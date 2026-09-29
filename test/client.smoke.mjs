/**
 * Browser half smoke test.
 *
 * The bundle is loaded outside a browser and driven through the same
 * registration calls the Client runtime makes. What is asserted is the whole of
 * the contract this half has: both Session event types reach the Trajectory
 * ledger as `extension` rows, every word in those rows comes from the registered
 * dictionary in both languages, the emphasis each status asks for stays inside
 * the closed tone vocabulary, and no Harness Client package is requested.
 *
 * Usage: `node test/client.smoke.mjs`.
 * The assertions against the shipped registry and Trajectory layout need a DSH
 * checkout with built client libraries; set `DSH_CHECKOUT` to that checkout's
 * root, or they are skipped.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

let captured = null
globalThis.window = { __ModuleLoader__: { load: (definition) => { captured = definition } } }
new Function(readFileSync(join(PLUGIN, 'client/client.js'), 'utf8'))()

check('the bundle registers one module', captured !== null && captured.id === 'dsh-memory', String(captured?.id))

// Anything but the module table would be a Harness Client package, which a
// plugin half may not reach for: its injected services are the whole surface.
let requires = 0
const stubRequire = (specifier) => { requires += 1; throw new Error(`unexpected require: ${specifier}`) }
const client = captured.factory(stubRequire)
check('the factory exports apply', typeof client.apply === 'function')
check('the factory exports inject', Array.isArray(client.inject) && client.inject.length === 2
  && client.inject.includes('locale') && client.inject.includes('uiConversation'),
String(client.inject))
check('the client half requests no Harness package', requires === 0, String(requires))

/**
 * A locale service that fails on any key the dictionary does not hold, so an
 * unlocalized string in a row is a failure rather than a silently rendered key.
 * @param locale - the dictionary to translate with.
 * @returns the service and the registrations it received.
 */
const localeService = (locale) => {
  const dictionaries = []
  const service = {
    register: (ns, dicts) => { dictionaries.push({ ns, dicts }); return () => {} },
    bind: (ns) => (key, params) => {
      const dict = dictionaries.find(entry => entry.ns === ns)?.dicts?.[locale]
      if (dict === undefined || dict[key] === undefined) throw new Error(`"${key}" is not in the ${locale} dictionary`)
      const template = dict[key]
      return params === undefined
        ? template
        : template.replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match))
    },
  }
  return { service, dictionaries }
}

/**
 * Install the plugin on a stub Client context.
 * @param locale - the dictionary to translate with.
 * @returns everything the registration produced.
 */
const install = (locale) => {
  const { service, dictionaries } = localeService(locale)
  const definitions = []
  const effects = []
  let insideEffect = 0
  let outsideEffect = 0
  const ctx = {
    effect: (factory, label) => {
      effects.push(label)
      insideEffect += 1
      try { return factory() }
      finally { insideEffect -= 1 }
    },
    locale: service,
    uiConversation: {
      events: {
        register: (definition) => {
          if (insideEffect === 0) outsideEffect += 1
          definitions.push(definition)
          return () => {}
        },
      },
    },
  }
  client.apply(ctx)
  return { definitions, effects, dictionaries, outsideEffect }
}

console.log('registration')
const en = install('en')
const zh = install('zh')
check('two definitions are registered, one per event type',
  en.definitions.length === 2, JSON.stringify(en.definitions.map(entry => entry.kind)))
check('both target the Trajectory ledger',
  en.definitions.every(entry => entry.target === 'trajectory'),
  JSON.stringify(en.definitions.map(entry => entry.target)))
check('their kinds differ, because the registry keys definitions by kind alone',
  en.definitions[0].kind !== en.definitions[1].kind,
  `${String(en.definitions[0].kind)} / ${String(en.definitions[1].kind)}`)
check('every contribution is an effect', en.effects.length === 3 && en.outsideEffect === 0,
  JSON.stringify(en.effects))
check('the dictionary is registered once, for both languages, with the same keys',
  en.dictionaries.length === 1 && en.dictionaries[0].ns === 'dshMemory'
  && Object.keys(en.dictionaries[0].dicts.zh).length === Object.keys(en.dictionaries[0].dicts.en).length
  && Object.keys(en.dictionaries[0].dicts.zh).every(key => key in en.dictionaries[0].dicts.en),
  JSON.stringify(en.dictionaries.map(entry => entry.ns)))

console.log('which events the rows claim')
const consolidation = en.definitions.find(entry => entry.kind === 'trajectory-memory-consolidation')
const project = en.definitions.find(entry => entry.kind === 'trajectory-memory-project')
const consolidationEvent = (seq, data) => ({ type: client.CONSOLIDATION_EVENT, seq, time: 1_700_000_000_000, data })
const projectEvent = (seq, data) => ({ type: client.PROJECT_EVENT, seq, time: 1_700_000_000_000, data })
check('the consolidation row claims its own event type only',
  consolidation?.match(consolidationEvent(7, {}))?.role === 'start'
  && consolidation?.match(projectEvent(7, {})) === null
  && consolidation?.match({ type: 'tool/call', seq: 1, data: {} }) === null,
  JSON.stringify(consolidation?.match(consolidationEvent(7, {}))))
check('the project row claims its own event type only',
  project?.match(projectEvent(7, {}))?.role === 'start'
  && project?.match(consolidationEvent(7, {})) === null,
  JSON.stringify(project?.match(projectEvent(7, {}))))
check('the two rows are identified apart',
  consolidation?.match(consolidationEvent(7, {}))?.id !== project?.match(projectEvent(7, {}))?.id,
  `${String(consolidation?.match(consolidationEvent(7, {}))?.id)} / ${String(project?.match(projectEvent(7, {}))?.id)}`)

/** One row built from one event, the way the assembler builds it. */
const rowOf = (definition, event) => definition.buildViewNode({
  key: `${String(definition.kind)}:k`,
  kind: definition.kind,
  id: `${String(definition.kind)}:${String(event.seq)}`,
  start: { event, location: { kind: 'unresolved' } },
  state: { seq: event.seq, time: event.time, payload: event.data },
})
const textOf = (definition, event) => rowOf(definition, event)?.data?.node?.text
const toneOf = (definition, event) => rowOf(definition, event)?.data?.node?.tone

console.log('the consolidation row')
const success = {
  from_seq: 12,
  to_seq: 48,
  relevant_events: 9,
  ignored_events: 4,
  trigger: 'idle-debounce',
  status: 'success',
  operations: { add: 2, update: 1, supersede: 0, noop: 3, skipped: 0, failed: 0 },
  rejected: 0,
}
const successRow = rowOf(consolidation, consolidationEvent(49, success))
check('the row is a Trajectory extension node',
  successRow?.data?.kind === 'node' && successRow?.data?.node?.kind === 'extension',
  JSON.stringify(successRow?.data))
check('it is anchored at the audit event and carries the envelope',
  successRow?.target === 'trajectory' && successRow?.anchorSeq === 49
  && successRow?.location?.kind === 'unresolved',
  JSON.stringify({ target: successRow?.target, anchorSeq: successRow?.anchorSeq, location: successRow?.location }))
check('the summary names the status, the trigger, the range and the counters',
  textOf(consolidation, consolidationEvent(49, success))
  === '🧠 Memory consolidation · success · idle debounce · seq 12–48 · added 2, updated 1, superseded 0, no-op 3',
  String(textOf(consolidation, consolidationEvent(49, success))))
check('a successful run asks the ledger for the positive tone',
  toneOf(consolidation, consolidationEvent(49, success)) === 'positive',
  String(toneOf(consolidation, consolidationEvent(49, success))))
check('the raw audit rides along for the details panel',
  successRow?.data?.node?.value === success
  && successRow?.data?.node?.key === client.CONSOLIDATION_EVENT
  && successRow?.data?.node?.seq === 49
  && successRow?.data?.node?.time === 1_700_000_000_000,
  JSON.stringify(successRow?.data?.node))

const partial = {
  ...success,
  status: 'partial',
  operations: { add: 1, update: 0, supersede: 2, noop: 0, skipped: 1, failed: 3 },
  rejected: 4,
  rejected_reasons: { 'action-forbidden': 4 },
}
check('a partial run adds only the counters it has',
  textOf(consolidation, consolidationEvent(50, partial))
  === '🧠 Memory consolidation · partial · idle debounce · seq 12–48 · added 1, updated 0, superseded 2, no-op 0 · rejected 4 · skipped 1 · failed 3',
  String(textOf(consolidation, consolidationEvent(50, partial))))
check('and asks for the warning tone',
  toneOf(consolidation, consolidationEvent(50, partial)) === 'warning',
  String(toneOf(consolidation, consolidationEvent(50, partial))))

const noHumanTurn = {
  from_seq: 3,
  to_seq: 9,
  relevant_events: 2,
  ignored_events: 1,
  trigger: 'manual-command',
  status: 'no-human-turn',
  operations: { add: 0, update: 0, supersede: 0, noop: 0 },
  rejected: 0,
}
check('a window with no human turn says so, and that nothing was written',
  textOf(consolidation, consolidationEvent(10, noHumanTurn))
  === '🧠 Memory consolidation · no human turn · manual command · seq 3–9 · added 0, updated 0, superseded 0, no-op 0',
  String(textOf(consolidation, consolidationEvent(10, noHumanTurn))))
check('and stays neutral',
  toneOf(consolidation, consolidationEvent(10, noHumanTurn)) === 'neutral',
  String(toneOf(consolidation, consolidationEvent(10, noHumanTurn))))

const gap = { status: 'gap', from_seq: 30, to_seq: 45, trigger: 'direct' }
check('a gap says the range was never observed, and carries no counters',
  textOf(consolidation, consolidationEvent(51, gap))
  === '🧠 Memory consolidation · gap · direct · seq 30–45 · this range was never observed',
  String(textOf(consolidation, consolidationEvent(51, gap))))
check('a gap asks for the critical tone',
  toneOf(consolidation, consolidationEvent(51, gap)) === 'critical',
  String(toneOf(consolidation, consolidationEvent(51, gap))))

console.log('the project row')
const attribution = {
  project_id: 'proj_01J8Z',
  canonical_root: '/Users/me/project',
  workspace_id: 'ws_7',
  matched_by: 'registry',
}
const attributionRow = rowOf(project, projectEvent(4, attribution))
check('it is a Trajectory extension node carrying the attribution',
  attributionRow?.data?.node?.kind === 'extension' && attributionRow?.data?.node?.value === attribution
  && attributionRow?.data?.node?.key === client.PROJECT_EVENT,
  JSON.stringify(attributionRow?.data?.node))
check('the summary names the root, the lookup that decided it and both ids',
  textOf(project, projectEvent(4, attribution))
  === '📁 Project attribution · /Users/me/project · by registry path · project proj_01J8Z · workspace ws_7',
  String(textOf(project, projectEvent(4, attribution))))
check('an attribution carries no emphasis',
  toneOf(project, projectEvent(4, attribution)) === 'neutral',
  String(toneOf(project, projectEvent(4, attribution))))
check('a workspace lookup and a marker lookup each name themselves',
  textOf(project, projectEvent(5, { ...attribution, matched_by: 'workspace' })).includes('by workspace')
  && textOf(project, projectEvent(5, { ...attribution, matched_by: 'marker' })).includes('by root marker'),
  String(textOf(project, projectEvent(5, { ...attribution, matched_by: 'marker' }))))
check('a Session outside any workspace says so instead of printing null',
  textOf(project, projectEvent(6, { ...attribution, workspace_id: null }))
  === '📁 Project attribution · /Users/me/project · by registry path · project proj_01J8Z · no workspace',
  String(textOf(project, projectEvent(6, { ...attribution, workspace_id: null }))))

console.log('the closed vocabularies')
const toneSet = new Set(['neutral', 'positive', 'accent', 'warning', 'critical'])
const statuses = ['success', 'partial', 'no-human-turn', 'gap']
const tones = statuses.map(status => `${status}=${String(toneOf(consolidation, consolidationEvent(1, { ...success, status })))}`)
check('each status asks for its own ledger tone',
  tones.join(' ') === 'success=positive partial=warning no-human-turn=neutral gap=critical',
  tones.join(' '))
check('the tone vocabulary is closed: an unknown status falls back to neutral',
  toneOf(consolidation, consolidationEvent(1, { ...success, status: 'mystery' })) === 'neutral',
  String(toneOf(consolidation, consolidationEvent(1, { ...success, status: 'mystery' }))))
check('every tone a row asks for exists in that closed set',
  [...statuses, 'mystery'].every(status => toneSet.has(toneOf(consolidation, consolidationEvent(1, { ...success, status }))))
  && toneSet.has(toneOf(project, projectEvent(1, attribution))))
check('an unknown status still renders, from the dictionary rather than the raw token',
  textOf(consolidation, consolidationEvent(1, { ...success, status: 'mystery' })).includes('other status'),
  String(textOf(consolidation, consolidationEvent(1, { ...success, status: 'mystery' }))))
check('an unknown trigger does too',
  textOf(consolidation, consolidationEvent(1, { ...success, trigger: 'mystery' })).includes('other trigger'),
  String(textOf(consolidation, consolidationEvent(1, { ...success, trigger: 'mystery' }))))
check('so does an unknown project lookup',
  textOf(project, projectEvent(1, { ...attribution, matched_by: 'mystery' })).includes('unknown lookup'),
  String(textOf(project, projectEvent(1, { ...attribution, matched_by: 'mystery' }))))
check('a payload missing its counters renders as zeroes rather than NaN',
  textOf(consolidation, consolidationEvent(1, { status: 'success' }))
  === '🧠 Memory consolidation · success · other trigger · added 0, updated 0, superseded 0, no-op 0',
  String(textOf(consolidation, consolidationEvent(1, { status: 'success' }))))

console.log('the row without a matched start')
check('the consolidation definition builds nothing without state',
  consolidation?.buildViewNode({ key: 'k', kind: 'trajectory-memory-consolidation', id: 'i', start: undefined, state: undefined }) === null)
check('and the project one neither',
  project?.buildViewNode({ key: 'k', kind: 'trajectory-memory-project', id: 'i', start: undefined, state: undefined }) === null)

console.log('the Chinese dictionary')
const zhConsolidation = zh.definitions.find(entry => entry.kind === 'trajectory-memory-consolidation')
const zhProject = zh.definitions.find(entry => entry.kind === 'trajectory-memory-project')
check('a successful run reads in Chinese',
  textOf(zhConsolidation, consolidationEvent(49, success))
  === '🧠 记忆整理 · 成功 · 空闲触发 · seq 12–48 · 新增 2 更新 1 取代 0 无操作 3',
  String(textOf(zhConsolidation, consolidationEvent(49, success))))
check('a gap reads in Chinese',
  textOf(zhConsolidation, consolidationEvent(51, gap))
  === '🧠 记忆整理 · 缺口 · 直接调用 · seq 30–45 · 这段区间从未被观测到',
  String(textOf(zhConsolidation, consolidationEvent(51, gap))))
check('a partial run reads in Chinese, counters included',
  textOf(zhConsolidation, consolidationEvent(50, partial))
  === '🧠 记忆整理 · 部分完成 · 空闲触发 · seq 12–48 · 新增 1 更新 0 取代 2 无操作 0 · 拒绝 4 · 跳过 1 · 失败 3',
  String(textOf(zhConsolidation, consolidationEvent(50, partial))))
check('an attribution reads in Chinese',
  textOf(zhProject, projectEvent(4, attribution))
  === '📁 项目归属 · /Users/me/project · 按登记路径 · 项目 proj_01J8Z · workspace ws_7',
  String(textOf(zhProject, projectEvent(4, attribution))))
check('and a missing workspace does too',
  textOf(zhProject, projectEvent(6, { ...attribution, workspace_id: null })).endsWith('无 workspace'),
  String(textOf(zhProject, projectEvent(6, { ...attribution, workspace_id: null }))))

console.log('the shipped registry and layout')
// The rows only matter if the shipped halves accept them, so where a checkout
// with built client libraries is named, the definitions go through the real
// registry and the real Trajectory projection instead of a stub.
const shipped = await shippedHalves()
if (shipped === null) {
  console.log('  skip (set DSH_CHECKOUT to a checkout with built client libraries)')
} else {
  const live = localeService('en')
  const registry = new shipped.ConversationEventRegistry({ effect: (factory) => factory() })
  client.apply({
    effect: (factory) => factory(),
    locale: live.service,
    uiConversation: { events: { register: (definition) => registry.register(definition) } },
  })
  check('the shipped registry accepts both definitions',
    registry.entries().length === 2, JSON.stringify(registry.entries().map(entry => entry.kind)))
  check('and refuses a second definition under a kind it already owns',
    (() => {
      try {
        registry.register(client.createConsolidationRow(() => 'x'))
        return false
      } catch { return true }
    })())
  const consolidationNode = rowOf(registry.entries()[0], consolidationEvent(49, success))
  const projectNode = rowOf(registry.entries()[1], projectEvent(4, attribution))
  const layout = shipped.deriveTrajectoryLayout(
    // The snapshot builder hands the target the inner ConversationNode, not the
    // view-node envelope the definition returns.
    { nodes: [consolidationNode.data.node, projectNode.data.node], partial: null, runningCalls: [] },
    (key) => key,
  )
  const cells = layout.flatMap(turn => turn.groups.flatMap(group => group.cells))
  check('the shipped layout projection turns both into ledger cells',
    cells.length === 2 && cells.every(cell => cell.kind === 'extension'),
    JSON.stringify(cells.map(cell => cell.kind)))
  // The ledger orders rows by seq, so the two arrive in log order, not
  // registration order.
  const bySeq = new Map(cells.map(cell => [cell.sourceSeq, cell]))
  const consolidationCell = bySeq.get(49)
  const projectCell = bySeq.get(4)
  check('the consolidation cell carries the summary, the emphasis and the audit',
    consolidationCell?.text === '🧠 Memory consolidation · success · idle debounce · seq 12–48 · added 2, updated 1, superseded 0, no-op 3'
    && consolidationCell?.extension?.tone === 'positive' && consolidationCell?.extension?.value === success,
    JSON.stringify(consolidationCell))
  check('and the shared details panel gets the audit as pretty JSON',
    typeof consolidationCell?.inputDetail === 'string' && consolidationCell.inputDetail.includes('"from_seq": 12'),
    String(consolidationCell?.inputDetail))
  check('the project cell carries its own summary and payload',
    projectCell?.text === '📁 Project attribution · /Users/me/project · by registry path · project proj_01J8Z · workspace ws_7'
    && projectCell?.extension?.value === attribution,
    JSON.stringify(projectCell))
}

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

/**
 * The shipped Conversation registry and Trajectory projection, when a checkout
 * with built client libraries is named.
 * @returns both classes, or null when none is available.
 */
async function shippedHalves() {
  const checkout = process.env.DSH_CHECKOUT
  if (typeof checkout !== 'string' || checkout === '') return null
  try {
    const conversation = await import(pathToFileURL(join(
      checkout, 'packages/client/ui-conversation/lib/types/client/conversation/event-registry.js')).href)
    const trajectory = await import(pathToFileURL(join(
      checkout, 'packages/client/ui-trajectory/lib/types/client/layout.js')).href)
    return {
      ConversationEventRegistry: conversation.ConversationEventRegistry,
      deriveTrajectoryLayout: trajectory.deriveTrajectoryLayout,
    }
  } catch (error) {
    console.log(`  skip the shipped-artifact assertions (${error instanceof Error ? error.message : String(error)})`)
    return null
  }
}
