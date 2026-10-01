/**
 * Collector and normalizer suite: which events reach the model, which are
 * consumed without being read, and which make a batch refuse to run.
 *
 * Usage: `node test/consolidation-collector.spec.mjs`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const normalize = await import(pathToFileURL(join(PLUGIN, 'src/consolidation/normalize.js')).href)
const { createCollector, DEFAULT_MAX_BUFFERED_EVENTS } = await import(pathToFileURL(join(PLUGIN, 'src/consolidation/collector.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

/** One event, with the envelope fields consolidation reads. */
const event = (seq, type, data = {}, extra = {}) => ({ seq, type, data, ...extra })
/** A human turn. */
const human = (seq, text) => event(seq, 'user/message', {
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})
/** Injected context that shares the user/message type. */
const injected = (seq, text) => event(seq, 'user/message', {
  content: [{ type: 'text', text }],
  source: { kind: 'agent-instructions' },
})
/** An assistant message. */
const assistant = (seq, text) => event(seq, 'assistant/message', {
  message: { content: [{ type: 'text', text }] },
})
/** An event a reader may always skip. */
const ignorable = (seq, type = 'dsh-allow/check') => event(seq, type, { note: 'noise' }, { ignorable: true })

console.log('classify')
check('an ignorable event is ignorable whatever its type',
  normalize.classify(ignorable(1, 'user/message')).kind === 'ignorable')
check('an internal event is recognized by its namespace',
  normalize.classify(event(1, 'dsh-reflection/consolidation')).kind === 'internal')
check('an internal event is internal even when marked ignorable',
  normalize.classify(event(1, 'dsh-reflection/consolidation', {}, { ignorable: true })).kind === 'ignorable')
check('a turn event is relevant', normalize.classify(human(1, 'x')).kind === 'relevant')
check('a tool result is relevant', normalize.classify(event(1, 'tool/result')).kind === 'relevant')
check('a known bookkeeping event is skipped, not unsupported',
  normalize.classify(event(1, 'turn/start')).kind === 'skipped')
check('an unknown event is unsupported', normalize.classify(event(1, 'some-plugin/event')).kind === 'unsupported')
check('the unsupported classification names the type',
  normalize.classify(event(1, 'some-plugin/event')).type === 'some-plugin/event')

console.log('isHumanTurn')
check('a human message is a human turn', normalize.isHumanTurn(human(1, 'hi')))
check('injected context is not a human turn', !normalize.isHumanTurn(injected(1, 'AGENTS.md')))
check('an assistant message is not a human turn', !normalize.isHumanTurn(assistant(1, 'hi')))

console.log('normalizeEvent')
check('a human message keeps its text and role',
  normalize.normalizeEvent(human(7, '以后用中文'))?.content === '以后用中文'
  && normalize.normalizeEvent(human(7, '以后用中文'))?.role === 'user')
check('injected context is labelled as context, not as the user',
  normalize.normalizeEvent(injected(7, 'AGENTS.md'))?.role === 'context')
check('an assistant message reads from message.content',
  normalize.normalizeEvent(assistant(8, 'done'))?.content === 'done')
check('a tool call keeps its name and raw arguments',
  normalize.normalizeEvent(event(9, 'tool/call', { name: 'bash', arguments: '{"command":"ls"}' }))?.arguments === '{"command":"ls"}')
check('a tool result keeps its text',
  normalize.normalizeEvent(event(10, 'tool/result', { message: { content: [{ type: 'text', text: 'pnpm@10' }] } }))?.content === 'pnpm@10')
check('an empty message normalizes away', normalize.normalizeEvent(human(11, '')) === undefined)
check('a result carrying no text normalizes away',
  normalize.normalizeEvent(event(12, 'tool/result', { message: { content: [{ type: 'image', id: 'x' }] } })) === undefined)

console.log('batchWindow: only new events')
const WINDOW = [
  human(201, '这个项目以后用 pnpm'),
  ignorable(202),
  event(203, 'tool/call', { name: 'bash', arguments: '{}' }),
  ignorable(204, 'dsh-allow/audit'),
  event(205, 'tool/result', { message: { content: [{ type: 'text', text: 'pnpm@10' }] } }),
  assistant(206, '已切到 pnpm'),
]
const mixed = normalize.batchWindow(WINDOW, { afterSeq: 200 })
check('the window starts after the mark', mixed.entries[0].seq === 201)
check('only relevant events reach the model',
  mixed.entries.map(entry => entry.seq).join(',') === '201,203,205,206')
check('ignorable events are counted but not sent', mixed.counts.ignored === 2)
check('the window ends at the newest event', mixed.toSeq === 206)
check('a human turn is detected', mixed.humanTurn === true)
check('no unsupported event is reported', mixed.unsupported === undefined)

const advanced = normalize.batchWindow(WINDOW, { afterSeq: 206 })
check('an already consumed window is empty', advanced.entries.length === 0)
check('an empty window has no end', advanced.toSeq === undefined)

console.log('ignorable-only window still advances')
const noiseOnly = [ignorable(301), ignorable(302), event(303, 'dsh-reflection/consolidation')]
const noise = normalize.batchWindow(noiseOnly, { afterSeq: 300 })
check('no model input is produced', noise.entries.length === 0)
check('no human turn is found', noise.humanTurn === false)
check('the mark still moves past every ignored event', noise.toSeq === 303)
check('the ignored events are still counted', noise.counts.ignored === 2 && noise.counts.internal === 1)

console.log('an unknown event stops the batch before it is consumed')
const unknownWindow = [human(401, 'x'), event(402, 'mystery/event'), human(403, 'y')]
const unknown = normalize.batchWindow(unknownWindow, { afterSeq: 400 })
check('the unsupported event is reported', unknown.unsupported?.seq === 402)
check('nothing is offered to the model', unknown.entries.length === 0)
check('the window does not advance past it', unknown.toSeq === undefined)

console.log('bounded input')
const manyTurns = Array.from({ length: 10 }, (_, index) => human(500 + index, `turn ${String(index)}`))
const bounded = normalize.batchWindow(manyTurns, { afterSeq: 499, maxEvents: 3 })
check('the batch respects the event ceiling', bounded.entries.length === 3)
check('it consumed exactly what it took', bounded.toSeq === 502)
const byteBound = normalize.batchWindow(manyTurns, { afterSeq: 499, maxBytes: 120 })
check('the batch respects the byte ceiling', byteBound.entries.length < 10 && byteBound.entries.length >= 1)
check('the byte ceiling never blocks progress', byteBound.toSeq !== undefined)
const oversized = normalize.batchWindow([human(600, 'x'.repeat(5000))], { afterSeq: 599, maxBytes: 100 })
check('one oversized event is still consumed rather than stalling the window',
  oversized.entries.length === 1 && oversized.toSeq === 600)
check('its text is truncated to the budget',
  Buffer.byteLength(oversized.entries[0].content, 'utf8') < 5000
  && oversized.entries[0].content.endsWith('[truncated]'))

console.log('the byte budget holds in bytes, not characters')
{
  const cjk = normalize.batchWindow([human(700, '中'.repeat(400))], { afterSeq: 699, maxBytes: 300 })
  const cjkBytes = Buffer.byteLength(JSON.stringify(cjk.entries[0]), 'utf8')
  check('a Chinese entry is capped by bytes, not code units', cjkBytes <= 300, String(cjkBytes))
  check('and it was shortened', cjk.entries[0].content.endsWith('[truncated]'))
  const emoji = normalize.batchWindow([human(701, '🙂'.repeat(200))], { afterSeq: 700, maxBytes: 200 })
  check('a cut never splits a surrogate pair',
    !/[\uD800-\uDBFF]$/u.test(emoji.entries[0].content.replace('[truncated]', '')))
  const ascii = normalize.batchWindow([human(702, 'x'.repeat(1000))], { afterSeq: 701, maxBytes: 120 })
  check('an ASCII entry is capped too',
    Buffer.byteLength(JSON.stringify(ascii.entries[0]), 'utf8') <= 120)
  // The whole batch budget, not just one entry: two entries cannot together
  // exceed it.
  const pair = normalize.batchWindow([human(703, '中'.repeat(200)), human(704, '中'.repeat(200))], { afterSeq: 702, maxBytes: 400 })
  check('the batch budget bounds the entries together',
    Buffer.byteLength(JSON.stringify(pair.entries), 'utf8') <= 400,
    String(Buffer.byteLength(JSON.stringify(pair.entries), 'utf8')))
}

console.log('the ceiling covers tool arguments and budgets too small to hold an entry')
{
  const big = JSON.stringify({ command: 'x'.repeat(4000) })
  const call = normalize.batchWindow([{ seq: 800, type: 'tool/call', data: { name: 'bash', arguments: big } }],
    { afterSeq: 799, maxBytes: 300 })
  const callBytes = Buffer.byteLength(JSON.stringify(call.entries[0]), 'utf8')
  check('a tool call is capped too', callBytes <= 300, String(callBytes))
  check('and the arguments are what yield', String(call.entries[0].arguments).endsWith('[truncated]'))

  for (const budget of [128, 200, 400]) {
    const tiny = normalize.batchWindow([human(810, '中'.repeat(500))], { afterSeq: 809, maxBytes: budget })
    const tinyBytes = Buffer.byteLength(JSON.stringify(tiny.entries[0]), 'utf8')
    check(`an entry stays within a ${String(budget)} byte budget`, tinyBytes <= budget, `${String(tinyBytes)} > ${String(budget)}`)
    check(`and carries a shortened form at ${String(budget)} bytes`,
      JSON.stringify(tiny.entries[0]).includes('[truncated]'))
  }
}

console.log('the ceiling holds for what the model actually reads')
{
  // The request joins entries with newlines, so the separators count too.
  const many = Array.from({ length: 6 }, (_, index) => human(900 + index, '中'.repeat(30)))
  const window = normalize.batchWindow(many, { afterSeq: 899, maxBytes: 400 })
  const rendered = window.entries.map(entry => JSON.stringify(entry)).join('\n')
  check('the rendered trajectory is within the budget',
    Buffer.byteLength(rendered, 'utf8') <= 400, String(Buffer.byteLength(rendered, 'utf8')))

  // A field this code cannot shrink must not become an oversized entry.
  const longTool = { seq: 950, type: 'tool/call', data: { name: 'x'.repeat(500), arguments: 'y'.repeat(5000) } }
  const pinned = normalize.batchWindow([longTool], { afterSeq: 949, maxBytes: 128 })
  check('an unshrinkable field cannot push the entry over the ceiling',
    Buffer.byteLength(JSON.stringify(pinned.entries[0]), 'utf8') <= 128,
    String(Buffer.byteLength(JSON.stringify(pinned.entries[0]), 'utf8')))
  check('and the placeholder carries no original text',
    !JSON.stringify(pinned.entries[0]).includes('yyy'))
}

console.log('collector')
const collector = createCollector()
const session = { id: 'session_a' }
for (const one of WINDOW) collector.observe(session, one)
collector.observe(session, WINDOW[0])
check('every distinct event is buffered once', collector.eventsFor('session_a').length === WINDOW.length)
check('an out-of-order repeat is ignored', collector.eventsFor('session_a')[0].seq === 201)
check('the first retained seq is reported', collector.firstSeq('session_a') === 201)
check('an unknown Session has no events', collector.eventsFor('session_b').length === 0)
check('an unknown Session has no first seq', collector.firstSeq('session_b') === undefined)
check('nothing has been dropped', collector.droppedThrough('session_a') === -1)

collector.observe({ id: 'session_a' }, event(207, 'turn/end'))
check('a later event is appended', collector.eventsFor('session_a').at(-1).seq === 207)
collector.observe({ id: 'session_a' }, event(206, 'assistant/message'))
check('an older seq arriving late is refused rather than appended out of order',
  collector.eventsFor('session_a').at(-1).seq === 207)

const dropped = collector.dropConsumed('session_a', 205)
check('consumed events are dropped', dropped === 5)
check('the pending remainder stays', collector.eventsFor('session_a').map(one => one.seq).join(',') === '206,207')
check('dropping consumed events is not recorded as a gap', collector.droppedThrough('session_a') === -1)

const capped = createCollector({ maxBufferedEvents: 3 })
for (const one of WINDOW) capped.observe(session, one)
check('the buffer respects its cap', capped.eventsFor('session_a').length === 3)
check('the oldest surviving seq is reported', capped.firstSeq('session_a') === 204)
check('what was dropped is reported so a gap can be recorded', capped.droppedThrough('session_a') === 203)

const kept = createCollector()
kept.observe(session, WINDOW[0])
kept.observe({ id: 'session_b' }, WINDOW[0])
check('the collector lists its Sessions', kept.sessions().sort().join(',') === 'session_a,session_b')
check('forgetting one Session leaves the other', kept.forget('session_a') === undefined
  && kept.sessions().join(',') === 'session_b')
check('retaining a name drops the rest', kept.retain(new Set(['session_a'])) === 1)
check('the dropped Session is gone', kept.sessions().length === 0)
check('the retention cap has a documented default', DEFAULT_MAX_BUFFERED_EVENTS >= 1000)

console.log('the vocabulary this build knows covers the one the harness declares')
// Reading the harness source is what keeps this honest: a type added there must
// be classified here, or consolidation would discover it only by refusing a real
// Session. The plugin itself carries no harness dependency; this is a test that
// lives in the harness checkout.
const HARNESS_TYPES = resolve(PLUGIN, '../../packages/core/session/src/known-event-types.ts')
if (existsSync(HARNESS_TYPES)) {
  const declared = [...readFileSync(HARNESS_TYPES, 'utf8').matchAll(/^ {2}'([a-zA-Z/_-]+)',$/gmu)]
    .map(match => match[1])
  check('the harness vocabulary was read', declared.length > 40, String(declared.length))
  const unclassified = declared.filter(type => normalize.classify({ type }).kind === 'unsupported')
  check('every declared event type is classified', unclassified.length === 0, unclassified.join(','))
  check('the declared types are split between read and skipped',
    declared.some(type => normalize.classify({ type }).kind === 'relevant')
    && declared.some(type => normalize.classify({ type }).kind === 'skipped'))
} else {
  console.log('  note  the harness source is absent, so the vocabulary check did not run')
}

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
