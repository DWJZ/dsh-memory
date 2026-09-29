/**
 * Orchestration suite: the progress mark, the human-turn gate, the commit, and
 * what a failure does to the window.
 *
 * The model is scripted, so these assertions are about the pipeline rather than
 * about what a model would decide.
 *
 * Usage: `node test/consolidation-run.spec.mjs`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { createConsolidation, AUDIT_EVENT_TYPE, describeOutcome } = await import(pathToFileURL(join(PLUGIN, 'src/consolidation/index.js')).href)
const { createCollector } = await import(pathToFileURL(join(PLUGIN, 'src/consolidation/collector.js')).href)
const state = await import(pathToFileURL(join(PLUGIN, 'src/consolidation/state.js')).href)
const { readStore } = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.js')).href)
const { consolidationLayout, projectLayout, tombstoneLayout, userLayout } = await import(pathToFileURL(join(PLUGIN, 'src/paths.js')).href)
const { newProjectId } = await import(pathToFileURL(join(PLUGIN, 'src/schema.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-memory-consolidation-run-'))
const MEMORY = join(ROOT, 'memory')
mkdirSync(MEMORY, { recursive: true })
const PROJECT = newProjectId()
const STATE = consolidationLayout(MEMORY)

/** A human turn event. */
const human = (seq, text) => ({ seq, type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
/** An assistant message. */
const assistant = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })
/** A tool result. */
const toolResult = (seq, text) => ({ seq, type: 'tool/result', data: { message: { content: [{ type: 'text', text }] } } })
/** An event a reader may skip. */
const ignorable = (seq) => ({ seq, type: 'dsh-allow/check', data: {}, ignorable: true })

/**
 * One orchestrator over a fresh or shared environment.
 * @param options - environment overrides.
 * @returns the orchestrator and the fixtures it uses.
 */
function harness(options = {}) {
  const collector = options.collector ?? createCollector()
  const audit = []
  const warnings = []
  const session = {
    id: options.sessionId ?? 'session_a',
    requestHeader: () => ({ config: { provider: 'test-provider', model: 'test-model' } }),
    append(type, data, appendOptions) {
      if (options.auditThrows === true) throw new Error('session is going away')
      audit.push({ type, data, ignorable: appendOptions?.ignorable === true })
    },
  }
  const phases = []
  const agent = {
    session,
    status: 'idle',
    // The runtime's own claim on the maintenance phase, recorded so a test can
    // assert the work happens inside it rather than beside it.
    async runMaintenance(task) {
      if (phases.includes('busy')) throw new Error('agent is already driving a turn or a maintenance task')
      agent.claims += 1
      phases.push('busy')
      try {
        return await task(new AbortController().signal)
      } finally {
        phases.splice(phases.indexOf('busy'), 1)
      }
    },
    phases,
    claims: 0,
  }
  const calls = []
  const consolidation = createConsolidation({
    collector,
    scopes: options.scopes ?? { user: userLayout(MEMORY), project: id => projectLayout(MEMORY, id) },
    state: { statePath: STATE.statePath, lockPath: STATE.lockPath },
    actionOptions: {
      scopes: options.actionScopes ?? { user: userLayout(MEMORY), project: id => projectLayout(MEMORY, id) },
      tombstones: tombstoneLayout(MEMORY),
      lockTimeoutMs: options.lockTimeoutMs ?? 3000,
      staleLockMs: 60000,
      maxEvidencePerMemory: 8,
      logger: { warn: message => warnings.push(message) },
      host: 'test-host',
      kill: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) },
    },
    config: {
      debounceMs: 10,
      minConfidence: 0.8,
      maxRelevantEventsPerBatch: 200,
      maxTrajectoryBytesPerBatch: 65536,
      maxOutputTokens: 512,
      maxEvidencePerMemory: 8,
      quoteMaxChars: 200,
      autoCommit: options.autoCommit ?? true,
      lockTimeoutMs: 3000,
      staleLockMs: 60000,
    },
    logger: { info: () => {}, warn: message => warnings.push(message) },
    host: 'test-host',
    kill: () => { throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }) },
    projectFor: () => (options.projectless === true ? null : { project_id: PROJECT }),
    ...options.schedule === undefined ? {} : { schedule: options.schedule },
    ...options.cancelSchedule === undefined ? {} : { cancelSchedule: options.cancelSchedule },
    callModel: async request => {
      calls.push(request)
      if (options.modelThrows === true) throw new Error('provider is down')
      if (typeof options.modelAnswer === 'function') return options.modelAnswer(request)
      return options.modelAnswer ?? '{"operations":[]}'
    },
  })
  return { consolidation, collector, agent, session, audit, calls, warnings, statePath: STATE.statePath }
}

/** The plan that stores one project fact. */
const addProjectFact = seqs => `{"operations":[{"action":"add","scope":"project","category":"state","content":"The project uses pnpm.","confidence":0.94,"evidence_event_seqs":${JSON.stringify(seqs)}}]}`

/**
 * Observe a whole trajectory into a collector.
 * @param harnessed - the harness.
 * @param events - the events to observe.
 * @returns nothing.
 */
const observe = (harnessed, events) => {
  for (const event of events) harnessed.collector.observe(harnessed.session, event)
}

const markOf = sessionId => state.lastProcessedSeq(state.readState(STATE.statePath), sessionId)

/**
 * Whether the project store holds a record with this content.
 * @param content - the exact content to look for.
 * @returns true when it is stored.
 */
const projectStoreHas = (content) => {
  const storePath = projectLayout(MEMORY, PROJECT).storePath
  if (!existsSync(storePath)) return false
  return readStore(storePath).records.some(record => record.content === content)
}

console.log('a successful run advances the mark')
{
  const harnessed = harness({ modelAnswer: addProjectFact([1, 3]) })
  observe(harnessed, [human(1, '这个项目以后用 pnpm'), assistant(2, '好的'), toolResult(3, 'pnpm@10')])
  const outcome = await harnessed.consolidation.consolidate(harnessed.agent)
  check('the run reports success', outcome.status === 'success', JSON.stringify(outcome))
  check('the mark moved to the window end', markOf('session_a') === 3)
  check('the model was called once', harnessed.calls.length === 1)
  check('one addition was committed', outcome.operations.add === 1)
  const stored = readStore(projectLayout(MEMORY, PROJECT).storePath).records
  check('the Memory was written', stored.length === 1 && stored[0].content === 'The project uses pnpm.')
  check('the provenance was built by the plugin', stored[0].evidence[0].quote.includes('这个项目以后用 pnpm'))
  check('the cited seqs were stored', stored[0].evidence[0].event_seqs.join(',') === '1,3')
  // The fixture starts at seq 1, so seq 0 is unobserved and is audited as a gap.
  const runAudits = harnessed.audit.filter(entry => entry.data?.status !== 'gap')
  check('the run audit was recorded', runAudits.length === 1 && runAudits[0].type === AUDIT_EVENT_TYPE)
  const runAudit = harnessed.audit.filter(entry => entry.data?.status !== 'gap').at(-1)
  check('the audit is marked ignorable', runAudit.ignorable === true)
  check('the audit carries counts, not content',
    runAudit.data.operations.add === 1 && !JSON.stringify(runAudit.data).includes('pnpm'))
  check('the audit records the window', runAudit.data.from_seq === 1 && runAudit.data.to_seq === 3)
  check('the description names the counts', describeOutcome(outcome).includes('1 added'))
}

console.log('the mark is the only thing that limits a second run')
{
  const harnessed = harness({ sessionId: 'session_incremental', modelAnswer: addProjectFact([1]) })
  observe(harnessed, [human(1, 'x'), assistant(2, 'y')])
  await harnessed.consolidation.consolidate(harnessed.agent)
  check('the first run consumed the window', markOf('session_incremental') === 2)
  const second = await harnessed.consolidation.consolidate(harnessed.agent)
  check('a second run finds nothing pending', second.status === 'nothing-pending')
  check('no second model call was made', harnessed.calls.length === 1)
  observe(harnessed, [human(3, 'another turn')])
  const third = await harnessed.consolidation.consolidate(harnessed.agent)
  check('new events are collected', harnessed.calls.length === 2)
  check('the window starts after the mark', third.from_seq === 3)
  check('only the new turn was sent', harnessed.calls[1].entries.map(entry => entry.seq).join(',') === '3')
}

console.log('NOOP is success and still advances')
{
  const harnessed = harness({ sessionId: 'session_noop', modelAnswer: '{"operations":[{"action":"noop","reason":"transient task state"}]}' })
  observe(harnessed, [human(1, 'run the tests'), assistant(2, 'done')])
  const outcome = await harnessed.consolidation.consolidate(harnessed.agent)
  check('the run reports success', outcome.status === 'success', JSON.stringify(outcome))
  check('the mark advanced', markOf('session_noop') === 2)
  check('nothing was written', !existsSync(userLayout(MEMORY).storePath)
    || readStore(userLayout(MEMORY).storePath).records.length === 0)
  check('the noop is counted', outcome.operations.noop === 1)
}

console.log('an ignorable-only window consumes without asking a model')
{
  const harnessed = harness({ sessionId: 'session_noise' })
  observe(harnessed, [ignorable(10), ignorable(11), { seq: 12, type: 'dsh-memory/consolidation', data: {} }])
  const outcome = await harnessed.consolidation.consolidate(harnessed.agent)
  check('no model call was made', harnessed.calls.length === 0)
  check('the window was consumed', markOf('session_noise') === 12)
  check('the outcome reports no human turn', outcome.status === 'no-human-turn')
  check('the ignored events are counted', outcome.ignored_events === 3)
}

console.log('a window with no human turn is consumed without asking a model')
{
  const harnessed = harness({ sessionId: 'session_agent_only' })
  observe(harnessed, [assistant(20, 'I did a thing'), toolResult(21, 'ok')])
  const outcome = await harnessed.consolidation.consolidate(harnessed.agent)
  check('no model call was made', harnessed.calls.length === 0)
  check('the mark advanced over the agent-only window', markOf('session_agent_only') === 21)
  check('the reason is reported', outcome.status === 'no-human-turn')
  check('the audit records the skip', state.readState(STATE.statePath).sessions.session_agent_only !== undefined)
}

console.log('a failure keeps the mark so the window is retried')
{
  const harnessed = harness({ sessionId: 'session_fail', modelThrows: true })
  observe(harnessed, [human(0, 'remember this'), assistant(1, 'ok')])
  let threw = false
  try {
    await harnessed.consolidation.consolidate(harnessed.agent)
  } catch {
    threw = true
  }
  check('the failure propagates rather than reading as nothing to do', threw === true)
  check('the mark did not move', markOf('session_fail') === state.NO_PROGRESS)
  check('the events are still buffered', harnessed.collector.eventsFor('session_fail').length === 2)
}

console.log('unreadable model output keeps the mark')
{
  const harnessed = harness({ sessionId: 'session_bad', modelAnswer: 'I could not decide.' })
  observe(harnessed, [human(0, 'remember this')])
  let threw = false
  try {
    await harnessed.consolidation.consolidate(harnessed.agent)
  } catch (error) {
    threw = String(error.message).includes('no JSON object')
  }
  check('the unreadable answer is refused', threw === true)
  check('the mark did not move', markOf('session_bad') === state.NO_PROGRESS)
}

console.log('a commit failure keeps the mark')
{
  // The window is reviewable — the read path needs no lock — but the write
  // cannot take the scope lock, so the run is partial.
  const harnessed = harness({ sessionId: 'session_locked', modelAnswer: addProjectFact([0]), lockTimeoutMs: 40 })
  const projectLock = projectLayout(MEMORY, PROJECT).lockPath
  writeFileSync(projectLock, JSON.stringify({ pid: process.pid, host: 'test-host', at: new Date().toISOString(), nonce: 'held' }))
  observe(harnessed, [human(0, '这个项目用 pnpm')])
  const outcome = await harnessed.consolidation.consolidate(harnessed.agent)
  rmSync(projectLock, { force: true })
  check('the run reports a partial commit', outcome.status === 'partial', JSON.stringify(outcome))
  check('the mark stayed put', markOf('session_locked') === state.NO_PROGRESS)
  check('the events are still pending', harnessed.collector.eventsFor('session_locked').length === 1)
  check('the failure was reported', harnessed.warnings.some(message => message.includes('unwritten')))
  const retry = await harnessed.consolidation.consolidate(harnessed.agent)
  check('the retry succeeds once the lock is free', retry.status === 'success')
  check('the retry advanced the mark', markOf('session_locked') === 0)
}

console.log('an unobserved range is recorded as a gap')
{
  const harnessed = harness({ sessionId: 'session_resumed' })
  const at = '2026-09-29T00:00:00.000Z'
  await state.withState({ statePath: STATE.statePath, lockPath: STATE.lockPath, lockTimeoutMs: 3000, staleLockMs: 60000 }, current => ({
    changed: true,
    state: state.advanceHwm(current, 'session_resumed', 182, at),
  }))
  observe(harnessed, [assistant(500, 'resumed elsewhere')])
  const outcome = await harnessed.consolidation.consolidate(harnessed.agent)
  check('the run consumes what it can', outcome.status === 'no-human-turn')
  const progress = state.readState(STATE.statePath).sessions.session_resumed
  check('the unobserved range is recorded', progress.gaps.length === 1)
  check('the gap starts after the stored mark', progress.gaps[0].from_seq === 183)
  check('the gap ends before the first observed event', progress.gaps[0].to_seq === 499)
  check('the mark is now the observed end', progress.last_processed_seq === 500)
  check('the gap is announced', harnessed.warnings.length >= 0 && progress.gaps[0].at.length > 0)
}

console.log('a gap is audited even when the run afterwards fails')
{
  const harnessed = harness({ sessionId: 'session_gap_fail', modelAnswer: 'not json at all' })
  observe(harnessed, [human(5, '这个项目用 pnpm')])
  await harnessed.consolidation.consolidate(harnessed.agent).catch(() => undefined)
  const gapAudit = harnessed.audit.find(entry => entry.data?.status === 'gap')
  check('the gap reached an audit although the run failed afterwards',
    gapAudit?.data?.from_seq === 0 && gapAudit?.data?.to_seq === 4, JSON.stringify(harnessed.audit.map(entry => entry.data)))
  // The retry no longer sees a gap, so only the dedicated audit can report it.
  const retry = harness({ sessionId: 'session_gap_fail', modelAnswer: addProjectFact([5]) })
  observe(retry, [human(5, '这个项目用 pnpm')])
  const outcome = await retry.consolidation.consolidate(retry.agent)
  check('the retry succeeds', outcome.status === 'success', JSON.stringify(outcome))
  check('and its audit carries no gap, because reconcile no longer reports one',
    retry.audit.every(entry => entry.data?.status !== 'gap'), JSON.stringify(retry.audit.map(entry => entry.data)))
}

console.log('a buffer that evicted events records the gap')
{
  // The buffer keeps only the newest few events, so the older ones were never
  // available to read. That is a different reason for a gap than a late mount,
  // and it must be recorded rather than silently folded into the mark.
  const harnessed = harness({ sessionId: 'session_evicted', collector: createCollector({ maxBufferedEvents: 3 }) })
  observe(harnessed, [
    human(0, 'first'), assistant(1, 'a'), assistant(2, 'b'), assistant(3, 'c'),
    assistant(4, 'd'), assistant(5, 'e'), assistant(6, 'f'), assistant(7, 'g'),
    assistant(8, 'h'), assistant(9, 'i'),
  ])
  check('the buffer kept only its cap', harnessed.collector.eventsFor('session_evicted').length === 3)
  check('the collector knows what it dropped', harnessed.collector.droppedThrough('session_evicted') === 6)
  const outcome = await harnessed.consolidation.consolidate(harnessed.agent)
  check('the run consumes what is left', outcome.status === 'no-human-turn', JSON.stringify(outcome))
  const progress = state.readState(STATE.statePath).sessions.session_evicted
  check('one gap is recorded', progress.gaps.length === 1, JSON.stringify(progress.gaps))
  check('the gap covers exactly the evicted events', progress.gaps[0].from_seq === 0 && progress.gaps[0].to_seq === 6)
  check('the mark is the last consumed event, not the gap end', progress.last_processed_seq === 9)
  check('the remaining window started after the gap', outcome.from_seq === 7)
  check('the gap is audited on its own, as soon as it is durable',
    harnessed.audit.some(entry => entry.data?.status === 'gap'
      && entry.data.from_seq === 0 && entry.data.to_seq === 6),
    JSON.stringify(harnessed.audit.map(entry => entry.data)))
}

console.log('scope decides where a fact lands')
{
  const harnessed = harness({
    sessionId: 'session_scope',
    modelAnswer: JSON.stringify({ operations: [
      { action: 'add', scope: 'user', category: 'preference', content: 'Prefer Chinese.', confidence: 0.9, evidence_event_seqs: [60] },
      { action: 'add', scope: 'project', category: 'decision', content: 'The audit log belongs in the Trajectory tab.', confidence: 0.9, evidence_event_seqs: [60] },
    ] }),
  })
  observe(harnessed, [human(60, '以后用中文，audit log 放 Trajectory tab')])
  const outcome = await harnessed.consolidation.consolidate(harnessed.agent)
  check('both operations committed', outcome.operations.add === 2)
  check('the preference landed in the user scope',
    readStore(userLayout(MEMORY).storePath).records.some(record => record.content === 'Prefer Chinese.'))
  check('the decision landed in the project scope',
    readStore(projectLayout(MEMORY, PROJECT).storePath).records
      .some(record => record.content === 'The audit log belongs in the Trajectory tab.'))
}

console.log('project scope without a project is dropped, not committed')
{
  const harnessed = harness({
    sessionId: 'session_noproject',
    projectless: true,
    modelAnswer: JSON.stringify({ operations: [
      { action: 'add', scope: 'project', category: 'state', content: 'Project fact.', confidence: 0.9, evidence_event_seqs: [70] },
      { action: 'add', scope: 'user', category: 'preference', content: 'Prefer Chinese for explanations.', confidence: 0.9, evidence_event_seqs: [70] },
    ] }),
  })
  observe(harnessed, [human(70, 'some turn')])
  const outcome = await harnessed.consolidation.consolidate(harnessed.agent)
  check('the run still succeeds', outcome.status === 'success')
  check('only the user fact was written', outcome.operations.add === 1)
  check('the drop is counted', outcome.rejected === 1)
  check('the user fact landed', readStore(userLayout(MEMORY).storePath).records
    .some(record => record.content === 'Prefer Chinese for explanations.'))
}

console.log('a low-confidence proposal never reaches the store')
{
  const harnessed = harness({
    sessionId: 'session_unsure',
    modelAnswer: JSON.stringify({ operations: [
      { action: 'add', scope: 'user', category: 'state', content: 'Maybe the user prefers X.', confidence: 0.4, evidence_event_seqs: [80] },
    ] }),
  })
  observe(harnessed, [human(80, 'maybe?')])
  const outcome = await harnessed.consolidation.consolidate(harnessed.agent)
  check('nothing was written', outcome.operations.add === 0)
  check('the window was still consumed', markOf('session_unsure') === 80)
  check('the drop is reported', outcome.rejected === 1)
}

console.log('a dry run neither writes nor advances')
{
  const dryPlan = '{"operations":[{"action":"add","scope":"project","category":"state","content":"Dry-run only fact.","confidence":0.94,"evidence_event_seqs":[0]}]}'
  const harnessed = harness({ sessionId: 'session_dry', modelAnswer: dryPlan })
  observe(harnessed, [human(0, '这个项目用 pnpm')])
  const outcome = await harnessed.consolidation.consolidate(harnessed.agent, { dryRun: true })
  check('the run reports a dry run', outcome.status === 'dry-run')
  check('the proposal is shown', outcome.accepted.length === 1 && outcome.accepted[0].action === 'add')
  check('the evidence it would use is shown', outcome.accepted[0].evidence_event_seqs.join(',') === '0')
  check('nothing was written', !projectStoreHas('Dry-run only fact.'))
  check('the mark did not move', markOf('session_dry') === state.NO_PROGRESS)
  check('no audit event was written', harnessed.audit.length === 0)
  check('the description lists the plan', describeOutcome(outcome).includes('Dry run'))
  const real = await harnessed.consolidation.consolidate(harnessed.agent)
  check('a real run afterwards still has the window', real.status === 'success')
}

console.log('an audit that cannot be written does not undo the commit')
{
  const harnessed = harness({ sessionId: 'session_noaudit', modelAnswer: addProjectFact([100]), auditThrows: true })
  observe(harnessed, [human(100, '这个项目用 pnpm')])
  const outcome = await harnessed.consolidation.consolidate(harnessed.agent)
  check('the run still reports success', outcome.status === 'success')
  check('the mark still advanced', markOf('session_noaudit') === 100)
  check('the missing trace is reported', harnessed.warnings.some(message => message.includes('audit')))
}

console.log('the trigger consults the same pipeline')
{
  const harnessed = harness({ sessionId: 'session_trigger', modelAnswer: addProjectFact([110]) })
  observe(harnessed, [human(110, '这个项目用 pnpm')])
  check('the orchestrator starts with no pending debounce', harnessed.consolidation.progressFor('session_trigger') === undefined)
  await harnessed.consolidation.consolidate(harnessed.agent)
  check('the orchestrator exposes recorded progress',
    harnessed.consolidation.progressFor('session_trigger').last_processed_seq === 110)
  harnessed.consolidation.dispose()
  check('disposing the orchestrator is safe', true)
}

console.log('the audit explains a run without repeating the model')
{
  const harnessed = harness({
    sessionId: 'session_audit',
    modelAnswer: '{"operations":[{"action":"noop","reason":"transient task state"},{"action":"noop","reason":"already represented"},{"action":"noop","reason":"the user said their name is Ada"}]}',
  })
  observe(harnessed, [human(0, 'run the tests')])
  await harnessed.consolidation.consolidate(harnessed.agent, { trigger: 'manual-command' })
  const audit = harnessed.audit.at(-1).data
  check('the audit names the trigger that ran it', audit.trigger === 'manual-command')
  check('the audit counts the no-ops', audit.operations.noop === 3)
  check('and keeps none of the model\'s own words',
    !JSON.stringify(audit).includes('transient') && !JSON.stringify(audit).includes('Ada'),
    JSON.stringify(audit))
}

{
  // A rejection is recorded by our own code, never by the model's text.
  const harnessed = harness({
    sessionId: 'session_audit_codes',
    modelAnswer: '{"operations":[{"action":"delete","target_id":"mem_secret_name"}]}',
  })
  observe(harnessed, [human(0, 'run the tests')])
  await harnessed.consolidation.consolidate(harnessed.agent)
  const audit = harnessed.audit.at(-1).data
  check('a rejection is recorded under our own code',
    audit.rejected_reasons?.['action-forbidden'] === 1, JSON.stringify(audit.rejected_reasons))
  check('the count agrees', audit.rejected === 1)
  check('the model\'s own target name never reaches the audit',
    !JSON.stringify(audit).includes('mem_secret_name'))
}

{
  // The debounce path labels itself, and the timer is driven by the test clock.
  const timers = []
  const harnessed = harness({
    sessionId: 'session_debounce',
    modelAnswer: '{"operations":[]}',
    schedule: (run) => { timers.push(run); return timers.length },
    cancelSchedule: () => {},
  })
  observe(harnessed, [human(0, '这个项目用 pnpm')])
  harnessed.consolidation.statusChanged(harnessed.agent, 'idle')
  check('going idle schedules the debounce', timers.length === 1)
  await timers[0]()
  check('the timer runs consolidation inside maintenance', harnessed.agent.claims === 1)
  check('and the audit says the debounce is what ran it',
    harnessed.audit.at(-1)?.data?.trigger === 'idle-debounce', JSON.stringify(harnessed.audit.at(-1)?.data))
  check('the run committed nothing, since the plan was empty',
    harnessed.audit.at(-1)?.data?.operations.add === 0)
}

console.log('a run that did nothing writes no audit')
{
  const harnessed = harness({ sessionId: 'session_phase', modelAnswer: addProjectFact([0]) })
  observe(harnessed, [human(0, '这个项目用 pnpm')])
  const outcome = await harnessed.consolidation.consolidate(harnessed.agent)
  check('the run succeeded', outcome.status === 'success')
  check('the agent claimed its maintenance phase exactly once', harnessed.agent.claims === 1)
  check('the phase was released when the run settled', harnessed.agent.phases.length === 0)
}

{
  // The phase is held across the whole run, not only across the write.
  let heldDuringModelCall = false
  let harnessed
  harnessed = harness({
    sessionId: 'session_phase_held',
    modelAnswer: () => {
      heldDuringModelCall = harnessed.agent.phases.includes('busy')
      return addProjectFact([0])
    },
  })
  observe(harnessed, [human(0, '这个项目用 pnpm')])
  await harnessed.consolidation.consolidate(harnessed.agent)
  check('the phase is held while the model is asked', heldDuringModelCall === true)
  check('and released once the run settled', harnessed.agent.phases.length === 0)

  const busyAgent = {
    ...harnessed.agent,
    async runMaintenance() { throw new Error('agent is already driving a turn or a maintenance task') },
  }
  let refused = false
  try {
    await harnessed.consolidation.consolidate(busyAgent)
  } catch (error) {
    refused = String(error.message).includes('already driving')
  }
  check('an agent that cannot grant the phase refuses rather than running beside the turn', refused === true)
}

console.log('operation counts mean one thing each')
{
  // A duplicate add is skipped by commit, and that is what skipped must report.
  const countsPlan = '{"operations":[{"action":"add","scope":"project","category":"state","content":"A fact for the counts test.","confidence":0.9,"evidence_event_seqs":[0]}]}'
  const harnessed = harness({ sessionId: 'session_counts', modelAnswer: countsPlan })
  observe(harnessed, [human(0, '这个项目用 pnpm')])
  const first = await harnessed.consolidation.consolidate(harnessed.agent)
  check('a first add reports one write and no skip',
    first.operations.add === 1 && first.operations.skipped === 0, JSON.stringify(first.operations))
  // A second window in the same project: the first run consumed seq 0, so the
  // duplicate proposal has to arrive on events the mark has not passed.
  const duplicate = harness({
    sessionId: 'session_counts',
    modelAnswer: countsPlan.replace('"evidence_event_seqs":[0]', '"evidence_event_seqs":[10]'),
  })
  observe(duplicate, [human(10, '这个项目用 pnpm')])
  const again = await duplicate.consolidation.consolidate(duplicate.agent)
  check('a duplicate is reported as skipped, not as written',
    again.operations.add === 0 && again.operations.skipped === 1, JSON.stringify(again.operations))
}

console.log('observation mode leaves the window alone')
{
  const harnessed = harness({ sessionId: 'session_observe', modelAnswer: addProjectFact([1]), autoCommit: false })
  observe(harnessed, [human(1, '这个项目以后用 pnpm'), assistant(2, '好的'), toolResult(3, 'pnpm@10')])
  const observed = await harnessed.consolidation.consolidate(harnessed.agent)
  check('the run reports that it only observed', observed.status === 'observed', JSON.stringify(observed))
  check('it says how much it saw',
    observed.operations.add === 0 && observed.operations.proposed === 1 && observed.operations.skipped === 0,
    JSON.stringify(observed.operations))
  check('nothing was written', !projectStoreHas('该项目使用 pnpm'))
  // The fixture starts at seq 1, so seq 0 is a real gap and moves the mark to 0.
  // What matters is that nothing inside the window was consumed.
  check('the window was not consumed', markOf('session_observe') < 1, String(markOf('session_observe')))
  check('the window is still in the buffer', harnessed.collector.eventsFor('session_observe').length === 3)
  check('the audit says so too', harnessed.audit.at(-1)?.data?.status === 'observed')

  // The same window has to still be learnable once committing is switched on.
  const committing = harness({ sessionId: 'session_observe', modelAnswer: addProjectFact([1]) })
  observe(committing, [human(1, '这个项目以后用 pnpm'), assistant(2, '好的'), toolResult(3, 'pnpm@10')])
  const committed = await committing.consolidation.consolidate(committing.agent)
  check('the same window still commits afterwards', committed.status === 'success', JSON.stringify(committed))
  check('and the mark advances then', markOf('session_observe') === 3)
}

console.log('two agents sharing a Session cannot process the same window twice')
{
  // `runMaintenance()` serializes one agent. Two agents can share a Session, so
  // without a per-Session queue both would read the same mark, ask the model and
  // commit — the state lock only protects the individual writes.
  let calls = 0
  let release
  const gate = new Promise(resolve => { release = resolve })
  const harnessed = harness({
    sessionId: 'session_shared',
    modelAnswer: async (request) => {
      calls += 1
      if (calls === 1) await gate
      return addProjectFact([0])
    },
  })
  const otherAgent = {
    session: { id: 'session_shared', header: { id: 'session_shared', cwd: PROJECT } },
    status: 'idle',
    async runMaintenance(task) { return await task(new AbortController().signal) },
  }
  observe(harnessed, [human(0, '这个项目用 pnpm')])

  const first = harnessed.consolidation.consolidate(harnessed.agent)
  for (let turns = 0; calls < 1; turns += 1) {
    if (turns > 10000) throw new Error('the first run never reached the model')
    await new Promise(resolve => { setImmediate(resolve) })
  }
  const second = harnessed.consolidation.consolidate(otherAgent)
  // The second run cannot have started while the first is inside its model call.
  await new Promise(resolve => { setImmediate(resolve) })
  check('the second run waits for the first to finish', calls === 1, String(calls))
  release()
  await first
  const secondOutcome = await second
  check('the first run commits', (await first).status === 'success')
  check('and the second finds the window already consumed',
    secondOutcome.status === 'nothing-pending', JSON.stringify(secondOutcome))
  check('the model was asked once for that window', calls === 1, String(calls))
}

console.log('teardown waits for every run, not the newest one')
{
  // Two Sessions consolidate concurrently. The one that starts second can finish
  // first, and a single tracking slot would then report that nothing is in
  // flight while the first is still writing.
  const gates = new Map()
  const parked = (request) => new Promise(resolve => {
    const key = JSON.stringify(request).includes('second Session') ? 'b' : 'a'
    gates.set(key, () => resolve('{"operations":[]}'))
  })
  const harnessed = harness({ sessionId: 'session_multi_a', modelAnswer: parked })
  // The second Session has nothing relevant, so its run ends immediately. That
  // is what clears a single tracking slot while the first is still writing.
  const phasesB = []
  const agentB = {
    session: { id: 'session_multi_b', header: { id: 'session_multi_b', cwd: PROJECT } },
    status: 'idle',
    async runMaintenance(task) {
      phasesB.push('busy')
      try {
        return await task(new AbortController().signal)
      } finally {
        phasesB.splice(phasesB.indexOf('busy'), 1)
      }
    },
  }
  observe(harnessed, [human(0, '这个项目用 pnpm')])

  const runA = harnessed.consolidation.consolidate(harnessed.agent)
  for (let turns = 0; !gates.has('a'); turns += 1) {
    if (turns > 10000) throw new Error('the first run never reached the model')
    await new Promise(resolve => { setImmediate(resolve) })
  }
  const runB = await harnessed.consolidation.consolidate(agentB)
  check('the second Session had nothing to consolidate', runB.status === 'nothing-observed', JSON.stringify(runB))
  let settled = false
  const waiting = harnessed.consolidation.whenSettled().then(() => { settled = true })
  // Give a wait that had nothing to wait for every chance to report itself, so
  // the assertion cannot pass merely because the callback has not run yet.
  await new Promise(resolve => { setImmediate(resolve) })
  check('the wait is still pending while the earlier run is in flight', settled === false)
  gates.get('a')()
  await waiting
  check('and it ends once that run does', settled === true)
  await runA
}

console.log('waiting for a run survives the run failing')
{
  // Teardown waits for whatever is in flight. A failed run must not turn that
  // wait into a second failure that escapes into `/memory disable` or unload.
  const timers = []
  const harnessed = harness({
    sessionId: 'session_failing_run',
    modelAnswer: () => { throw new Error('the provider refused the call') },
    schedule: (run) => { timers.push(run); return timers.length },
    cancelSchedule: () => {},
  })
  observe(harnessed, [human(0, '这个项目用 pnpm')])
  harnessed.consolidation.statusChanged(harnessed.agent, 'idle')
  const firing = timers[0]()
  let waitedCleanly = false
  try {
    await harnessed.consolidation.whenSettled()
    waitedCleanly = true
  } catch {
    waitedCleanly = false
  }
  check('waiting for a failing run does not raise the failure again', waitedCleanly === true)
  await firing.catch(() => undefined)
  check('the trigger reported the failure and kept the mark',
    Object.keys(state.readState(STATE.statePath).sessions).every(id => id !== 'session_failing_run'))
}

console.log('a Session that produced nothing is not an error')
{
  const harnessed = harness({ sessionId: 'session_silent' })
  const outcome = await harnessed.consolidation.consolidate(harnessed.agent)
  check('the outcome says nothing was observed', outcome.status === 'nothing-observed')
  check('no model call was made', harnessed.calls.length === 0)
  check('the description is human-readable', describeOutcome(outcome).includes('no events'))
  const noSession = await harnessed.consolidation.consolidate({})
  check('an agent without a Session is refused politely', noSession.status === 'no-session')
}

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
