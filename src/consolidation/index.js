/**
 * One consolidation run, from the progress mark to the next one.
 *
 * The order below is the whole design, and each step exists because skipping it
 * loses something:
 *
 * 1. Reconcile the mark with what this process actually observed. Events from
 *    before the plugin mounted, or from a Session resumed elsewhere, are not in
 *    the buffer and cannot be read back; the range is recorded as a gap so "not
 *    observed" never reads as "read and held nothing".
 * 2. Take the bounded window. Ignorable and internal events are counted and
 *    consumed; an unknown event stops the run and names itself.
 * 3. Require a human turn. An idle period with no human input is not a reason to
 *    ask a model anything, and the window is consumed so it is not re-examined.
 * 4. Ask once, review the answer, commit through Phase 1, then move the mark.
 *
 * A failure anywhere before the commit leaves the mark alone, so the next
 * eligible idle period retries the same window. A partial commit does too, and
 * the retry re-reads Memory and decides again rather than replaying a plan that
 * was formed against state that has since moved.
 *
 * Usage: `const outcome = await consolidation.consolidate(agent)`.
 */

import { readStore } from '../jsonstore.js'
import { findSecret } from '../redact.js'
import { createTrigger } from './trigger.js'
import { batchWindow } from './normalize.js'
import { buildRequest } from './policy.js'
import { callConsolidator } from './model.js'
import { parsePlan } from './policy.js'
import { reviewPlan } from './validate.js'
import { commitOperations } from './commit.js'
import { advanceHwm, lastProcessedSeq, NO_PROGRESS, progressFor, readState, recordGap, withState } from './state.js'

/** Longest model-authored noop reason kept in an audit. */
export const NOOP_REASON_MAX_CHARS = 60

/** Session event type carrying this plugin's consolidation audit. */
export const AUDIT_EVENT_TYPE = 'dsh-memory/consolidation'

/**
 * Build the consolidation orchestrator.
 *
 * @param options - wiring.
 * @param options.llmScope - the injection scope carrying `llm`, or a getter for it.
 * @param options.collector - the observed-event buffer.
 * @param options.scopes - Phase 1 scope layouts.
 * @param options.state - consolidation state location and lock.
 * @param options.actionOptions - Phase 1 action options for committing.
 * @param options.config - consolidation policy.
 * @param options.logger - optional `{ info, warn }` sink.
 * @param options.now - clock, injectable for tests.
 * @param options.callModel - the model call seam, injectable for tests.
 * @returns the orchestrator.
 */
export function createConsolidation(options) {
  const { collector, scopes, logger, config } = options
  const now = options.now ?? Date.now
  const callModel = options.callModel ?? ((request) => {
    const scope = typeof options.llmScope === 'function' ? options.llmScope() : options.llmScope
    if (scope === undefined || scope === null) {
      throw new Error('dsh-memory: no model service is mounted, so consolidation has nothing to ask')
    }
    return callConsolidator(scope, request)
  })
  const stateOptions = { ...options.state, lockTimeoutMs: config.lockTimeoutMs, staleLockMs: config.staleLockMs, logger, now, host: options.host, kill: options.kill }

  /**
   * The active Memory a run may target, from both visible scopes.
   * @param projectId - the Session's project, or null.
   * @returns the active records.
   */
  const activeMemory = (projectId) => {
    const user = readStore(scopes.user.storePath).records
    const project = projectId === null || projectId === undefined
      ? []
      : readStore(scopes.project(projectId).storePath).records
    return [...user, ...project].filter(record => record.status === 'active')
  }

  /**
   * Reconcile the stored mark with the first seq this process can offer.
   *
   * Returns the mark to start from. A gap is recorded when the buffer begins
   * later than the mark requires, which is the only honest way to say those
   * events were never seen.
   * @param sessionId - the Session being consolidated.
   * @returns the seq to collect after.
   */
  const reconcile = async (sessionId) => {
    const first = collector.firstSeq(sessionId)
    const state = readState(options.state.statePath)
    const mark = lastProcessedSeq(state, sessionId)
    // A Session this process has consumed and dropped everything for still has a
    // mark, which is a different thing from a Session it has never seen.
    if (first === undefined) return mark === NO_PROGRESS ? undefined : mark
    const droppedThrough = collector.droppedThrough(sessionId)
    const unobservedStart = Math.max(mark, droppedThrough)
    if (first <= unobservedStart + 1) return mark
    const at = new Date(now()).toISOString()
    const written = await withState(stateOptions, current => ({
      changed: true,
      state: recordGap(current, sessionId, { from_seq: unobservedStart + 1, to_seq: first - 1 }, at),
    }))
    logger?.info?.(`dsh-memory: consolidation skipped unobserved seqs ${String(unobservedStart + 1)}..${String(first - 1)} of ${sessionId}`)
    return lastProcessedSeq(written.state, sessionId)
  }

  /**
   * Record one run's result on the Session, without letting the trace decide
   * whether the run succeeded.
   * @param session - the Session to record against.
   * @param audit - the compact result.
   * @returns nothing.
   */
  const recordAudit = (session, audit) => {
    // The commit is the guarantee; the audit is a trace of it. A failed append
    // must not hold the mark back, because the next run would commit the same
    // operations again.
    try {
      session.append(AUDIT_EVENT_TYPE, audit, { ignorable: true })
    } catch (failure) {
      logger?.warn?.(`dsh-memory: could not record the consolidation audit: ${String(failure?.message ?? failure)}`)
    }
  }

  /**
   * Run one consolidation inside the agent's maintenance phase.
   *
   * The phase claim is what keeps a new user turn from starting in the middle of
   * a run, and it is what makes `whenIdle()` — and therefore the owner's flush
   * and dispose — wait for the run to settle. Working outside it would let a turn
   * interleave, and would let the Session be flushed or torn down while the
   * result was still being written.
   *
   * The claim throws when a turn or another maintenance task already owns the
   * agent. That is not a failure: the caller retries on the next idle period,
   * with the mark untouched.
   * @param agent - the agent to consolidate.
   * @param runOptions - run options.
   * @param runOptions.dryRun - review the plan without committing or advancing.
   * @returns a compact outcome.
   */
  const consolidate = async (agent, runOptions = {}) => {
    if (typeof agent?.session?.id !== 'string') return { status: 'no-session' }
    return agent.runMaintenance(signal => runOnce(agent, { ...runOptions, signal }))
  }

  /**
   * Do the work for one consolidation run.
   * @param agent - the agent being consolidated.
   * @param runOptions - run options, including the maintenance signal.
   * @returns a compact outcome.
   */
  const runOnce = async (agent, runOptions) => {
    const session = agent?.session
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return { status: 'no-session' }

    const afterSeq = await reconcile(sessionId)
    if (afterSeq === undefined) return { status: 'nothing-observed' }
    const window = batchWindow(collector.eventsFor(sessionId), {
      afterSeq,
      maxEvents: config.maxRelevantEventsPerBatch,
      maxBytes: config.maxTrajectoryBytesPerBatch,
    })
    if (window.unsupported !== undefined) {
      throw new Error(`dsh-memory: consolidation cannot read ${String(window.unsupported.type)} events (seq ${String(window.unsupported.seq)})`)
    }
    if (window.toSeq === undefined) return { status: 'nothing-pending' }
    const auditBase = {
      from_seq: afterSeq + 1,
      to_seq: window.toSeq,
      relevant_events: window.counts.relevant,
      ignored_events: window.counts.ignored + window.counts.internal + window.counts.skipped,
      trigger: runOptions.trigger ?? 'direct',
    }

    /**
     * Consume the window without asking a model.
     * @param status - why nothing was asked.
     * @returns the outcome.
     */
    const consume = async (status) => {
      await withState(stateOptions, current => ({
        changed: true,
        state: advanceHwm(current, sessionId, window.toSeq, new Date(now()).toISOString()),
      }))
      collector.dropConsumed(sessionId, window.toSeq)
      recordAudit(session, { ...auditBase, status, operations: { add: 0, update: 0, supersede: 0, noop: 0 } })
      return { ...auditBase, status }
    }

    if (!window.humanTurn) return consume('no-human-turn')

    const projectId = options.projectFor(agent)?.project_id ?? null
    const existing = activeMemory(projectId)
    const text = await callModel({
      session,
      sessionId,
      fromSeq: afterSeq + 1,
      toSeq: window.toSeq,
      entries: window.entries,
      existing: existing.map(record => ({
        id: record.id,
        scope: record.scope,
        category: record.category,
        content: record.content,
      })),
      maxOutputTokens: config.maxOutputTokens,
      signal: runOptions.signal,
    })
    const plan = parsePlan(text)
    const reviewed = reviewPlan(plan, {
      fromSeq: afterSeq + 1,
      toSeq: window.toSeq,
      visibleSeqs: new Set(window.entries.map(entry => entry.seq)),
      eventsBySeq: new Map(collector.eventsFor(sessionId).map(event => [event.seq, event])),
      existing,
      projectId,
      sessionId,
      minConfidence: config.minConfidence,
      quoteMaxChars: config.quoteMaxChars,
      maxEvidencePerMemory: config.maxEvidencePerMemory,
      now,
    })

    if (runOptions.dryRun === true) {
      return {
        ...auditBase,
        status: 'dry-run',
        accepted: reviewed.accepted.map(operation => ({
          action: operation.action,
          scope: operation.scope,
          category: operation.category,
          content: operation.content,
          confidence: operation.confidence,
          target_id: operation.target_id,
          evidence_event_seqs: operation.evidence.event_seqs,
          quote: operation.evidence.quote,
        })),
        rejected: reviewed.rejected,
        noopReasons: reviewed.noopReasons,
      }
    }

    const noopReasons = countNoopReasons(reviewed.noopReasons)

    const outcome = config.autoCommit === false
      ? { committed: { add: 0, update: 0, supersede: 0 }, skipped: reviewed.accepted, failures: [], applied: [] }
      : await commitOperations(options.actionOptions, reviewed.accepted)

    if (outcome.failures.length > 0) {
      // Something a review accepted could not be written. The mark stays put, so
      // the window is retried and the plan is formed again against current state.
      logger?.warn?.(`dsh-memory: consolidation left ${String(outcome.failures.length)} operation(s) unwritten for ${sessionId}`)
      recordAudit(session, {
        ...auditBase,
        status: 'partial',
        operations: { ...outcome.committed, noop: reviewed.noopReasons.length },
        ...noopReasons,
      })
      return { ...auditBase, status: 'partial', committed: outcome.committed, failures: outcome.failures.length }
    }

    await withState(stateOptions, current => ({
      changed: true,
      state: advanceHwm(current, sessionId, window.toSeq, new Date(now()).toISOString()),
    }))
    collector.dropConsumed(sessionId, window.toSeq)
    const operations = { ...outcome.committed, noop: reviewed.noopReasons.length }
    recordAudit(session, { ...auditBase, status: 'success', operations, ...noopReasons })
    const wrote = operations.add + operations.update + operations.supersede
    logger?.info?.(`dsh-memory: consolidation of ${sessionId} consumed ${String(auditBase.relevant_events)} event(s) and wrote ${String(wrote)}`)
    return { ...auditBase, status: 'success', operations, rejected: reviewed.rejected.length }
  }

  const trigger = createTrigger({
    debounceMs: config.debounceMs,
    logger,
    ...options.schedule === undefined ? {} : { schedule: options.schedule },
    ...options.cancelSchedule === undefined ? {} : { cancelSchedule: options.cancelSchedule },
    task: agent => consolidate(agent, { trigger: 'idle-debounce' }),
  })

  return {
    /**
     * Record one committed Session event for later consolidation.
     * @param session - the Session it belongs to.
     * @param event - the committed event.
     * @returns nothing.
     */
    observe(session, event) {
      collector.observe(session, event)
    },

    /**
     * React to an agent status change by scheduling or cancelling the debounce.
     * @param agent - the agent.
     * @param status - its new status.
     * @returns nothing.
     */
    statusChanged(agent, status) {
      trigger.statusChanged(agent, status)
    },

    /**
     * Consolidate one agent now, outside the debounce.
     * @param agent - the agent.
     * @param runOptions - `{ dryRun }`.
     * @returns the outcome.
     */
    consolidate,

    /**
     * The progress recorded for one Session.
     * @param sessionId - the Session.
     * @returns its mark and gaps, or undefined.
     */
    progressFor(sessionId) {
      return progressFor(readState(options.state.statePath), sessionId)
    },

    /**
     * Drop pending timers.
     * @returns nothing.
     */
    dispose() {
      trigger.dispose()
    },
  }
}

/**
 * Count the reasons a model gave for proposing nothing.
 *
 * The count is what makes an audit answerable — "noop" alone cannot distinguish
 * "the fact was already there" from "the model judged it transient". The reason
 * text is the model's own words, so it is collapsed, truncated, and screened: an
 * audit is a trace, not a place for the turn's text to reappear.
 * @param reasons - the reasons recorded during review.
 * @returns `{ noop_reasons }` when there were any, otherwise an empty object.
 */
function countNoopReasons(reasons) {
  if (reasons.length === 0) return {}
  const counts = {}
  for (const reason of reasons) {
    const key = sanitizeReason(reason)
    counts[key] = (counts[key] ?? 0) + 1
  }
  return { noop_reasons: counts }
}

/**
 * Make one model-authored reason safe to keep in an audit.
 * @param reason - the reason as the model wrote it.
 * @returns a short single-line reason, screened for secrets.
 */
function sanitizeReason(reason) {
  const collapsed = String(reason ?? '').replace(/\s+/gu, ' ').trim()
  if (collapsed === '') return 'no reason given'
  if (findSecret(collapsed) !== undefined) return '[redacted]'
  const points = Array.from(collapsed)
  return points.length <= NOOP_REASON_MAX_CHARS ? collapsed : `${points.slice(0, NOOP_REASON_MAX_CHARS).join('')}…`
}

/**
 * Render one run's outcome for a person.
 * @param outcome - the outcome from {@link createConsolidation}.
 * @returns the text to show.
 */
export function describeOutcome(outcome) {
  if (outcome.status === 'dry-run') {
    const lines = [
      `Dry run over seqs ${String(outcome.from_seq)}..${String(outcome.to_seq)} (${String(outcome.relevant_events)} relevant, ${String(outcome.ignored_events)} ignored).`,
      `Proposed operations: ${String(outcome.accepted.length)}`,
    ]
    for (const operation of outcome.accepted) {
      const target = operation.target_id === undefined ? '' : ` -> ${operation.target_id}`
      lines.push(`- ${operation.action} [${operation.scope}/${operation.category}] ${operation.content}${target}`)
      lines.push(`  confidence ${String(operation.confidence)}; evidence ${operation.evidence_event_seqs.join(',')}; quote: ${operation.quote}`)
    }
    for (const rejected of outcome.rejected) lines.push(`- dropped (${String(rejected.index)}): ${rejected.reason}`)
    for (const reason of outcome.noopReasons) lines.push(`- noop: ${reason}`)
    lines.push('Nothing was written and the progress mark is unchanged.')
    return lines.join('\n')
  }
  switch (outcome.status) {
    case 'success': {
      const { add, update, supersede, noop } = outcome.operations
      return `Consolidated seqs ${String(outcome.from_seq)}..${String(outcome.to_seq)}: ${String(add)} added, ${String(update)} updated, ${String(supersede)} superseded, ${String(noop)} noop${outcome.rejected === 0 ? '' : `, ${String(outcome.rejected)} dropped`}.`
    }
    case 'partial':
      return `Consolidated seqs ${String(outcome.from_seq)}..${String(outcome.to_seq)} but ${String(outcome.failures)} operation(s) could not be written; the window will be retried.`
    case 'no-human-turn':
      return `Nothing to learn from seqs ${String(outcome.from_seq)}..${String(outcome.to_seq)}: this window holds no human turn. The window is consumed.`
    case 'nothing-pending': return 'Nothing new to consolidate.'
    case 'nothing-observed': return 'This Session has produced no events this process has observed.'
    case 'no-session': return 'dsh-memory: this invocation has no Session to consolidate.'
    default: return `Consolidation did not run: ${String(outcome.status)}`
  }
}
