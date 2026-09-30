/**
 * Turn raw Session events into the trajectory a consolidation model may read.
 *
 * Three questions are answered here, and only here:
 * - which events may reach the model,
 * - which may not, but are still consumed,
 * - which are so unexpected that the batch must refuse to run at all.
 *
 * The last category is the one that matters most. The harness marks an event a
 * reader may safely skip with `ignorable: true`; an event without that marker is
 * one a reader is expected to understand, and the session log itself is refused
 * on an unknown type for the same reason. Silently dropping an event this build
 * does not recognize would hide a change in what a turn contains, so the batch
 * fails and names the type instead.
 *
 * Usage: `import { classify, batchWindow } from './normalize.js'`.
 */

/** Namespace reserved for this plugin's own Session events. */
export const INTERNAL_EVENT_PREFIX = 'dsh-memory/'

/** Source kind that marks a `user/message` as a human turn rather than injected context. */
export const HUMAN_SOURCE_KIND = 'user'

/** Event types that carry turn content and are sent to the model. */
export const RELEVANT_EVENT_TYPES = Object.freeze(new Set([
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'developer/message',
]))

/**
 * Event types this build knows about that carry no durable fact.
 *
 * These are bookkeeping, prompt scaffolding, or state the harness already
 * projects elsewhere. They are consumed without being sent and without failing
 * the batch: knowing a type and deciding it is not Memory input is different
 * from not knowing it at all.
 */
export const SKIPPED_EVENT_TYPES = Object.freeze(new Set([
  'agent-preset/selected',
  'agent/inbox/spliced',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'assistant/attempt',
  'command/done',
  'command/run',
  'compaction/end',
  'compaction/prune',
  'compaction/start',
  'compaction/summary',
  'deliverables/presented',
  'feedback/message-delete',
  'feedback/message-put',
  'feedback/record',
  'goal/change',
  'hook/invoked',
  'hook/result',
  'image/offload',
  'llm/retry',
  'llm/retry-started',
  'model/selection',
  'permission/preset',
  'plan/mode',
  'request/context',
  'request/header',
  'sandbox/mode',
  'schedule/change',
  'session-log-deepseek/delivery-accepted',
  'session/end-seed',
  'session/title',
  'session/title-llm-request',
  'step/end',
  'step/start',
  'subagent/catalog',
  'subagent/descriptor',
  'subagent/model-selection-policy',
  'system/message',
  'team/member',
  'team/message/delivered',
  'team/message/queued',
  'team/task',
  'todo/write',
  'tool-workflow/agent-end',
  'tool-workflow/agent-start',
  'tool-workflow/run-end',
  'tool-workflow/run-start',
  'tool/ptc-dispatch',
  'tool/ptc-dispatch-start',
  'turn/end',
  'turn/start',
  'web/deepseek-search-llm-request',
  'workspace/changes',
]))

/**
 * Decide what one event is to consolidation.
 *
 * Order matters: the ignorable marker is canonical and wins over everything,
 * including a type this build recognizes.
 * @param event - one Session event.
 * @returns the classification, whose `kind` is `ignorable`, `internal`,
 *   `relevant`, `skipped`, or `unsupported`.
 */
export function classify(event) {
  if (event?.ignorable === true) return { kind: 'ignorable', type: String(event.type) }
  const type = String(event?.type ?? '')
  if (type.startsWith(INTERNAL_EVENT_PREFIX)) return { kind: 'internal', type }
  if (RELEVANT_EVENT_TYPES.has(type)) return { kind: 'relevant', type }
  if (SKIPPED_EVENT_TYPES.has(type)) return { kind: 'skipped', type }
  return { kind: 'unsupported', type }
}

/**
 * Whether one event is a human turn.
 *
 * A `user/message` is not automatically human: the same event type carries
 * injected context such as file-change notices and skill content, and `source`
 * is what tells them apart. Only a human turn opens the learning gate.
 * @param event - one Session event.
 * @returns true when a person wrote this message.
 */
export function isHumanTurn(event) {
  return event?.type === 'user/message' && event?.data?.source?.kind === HUMAN_SOURCE_KIND
}

/**
 * Pull model-readable text out of a message payload.
 *
 * Handles both shapes the log uses: a bare `content` block array, and one
 * nested under `message`. Anything unreadable reads as empty rather than
 * throwing, because a payload this build cannot render is reported through
 * {@link classify}, not through a crash mid-normalization.
 * @param payload - event data, or one of its message fields.
 * @returns the concatenated text, or an empty string.
 */
export function textOf(payload) {
  const blocks = Array.isArray(payload?.content) ? payload.content : payload?.message?.content
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

/**
 * Turn one relevant event into the compact entry the model reads.
 *
 * Only what explains the turn survives: sequence number, type, speaker, and the
 * text or tool payload. The raw envelope is not the model's business.
 * @param event - one relevant Session event.
 * @returns the normalized entry, or undefined when nothing was carried.
 */
export function normalizeEvent(event) {
  const base = { seq: event.seq, type: event.type }
  switch (event.type) {
    case 'user/message': {
      const content = textOf(event.data)
      if (content === '') return undefined
      return { ...base, role: isHumanTurn(event) ? 'user' : 'context', content }
    }
    case 'assistant/message': {
      const content = textOf(event.data.message ?? event.data)
      if (content === '') return undefined
      return { ...base, role: 'assistant', content }
    }
    case 'developer/message': {
      const content = textOf(event.data.message ?? event.data)
      if (content === '') return undefined
      return { ...base, role: 'developer', content }
    }
    case 'tool/call':
      return { ...base, tool: String(event.data?.name ?? ''), arguments: String(event.data?.arguments ?? '') }
    case 'tool/result': {
      const content = textOf(event.data.message ?? event.data)
      // A result with no readable text says nothing about the turn; an entry
      // carrying an empty string would only spend bytes.
      if (content === '') return undefined
      return { ...base, tool: String(event.data?.name ?? ''), content }
    }
    default:
      return undefined
  }
}

/**
 * Select the bounded window of events one consolidation batch may consider.
 *
 * `toSeq` is the end of the batch, and it is returned even when nothing was
 * selected: ignorable and internal events still have to be consumed, or every
 * later idle period would rediscover them.
 *
 * A batch may stop short of the newest event. When it does, `toSeq` is the last
 * event it actually took, so the mark never moves past events nobody read.
 * @param events - the observed events for one Session, in seq order.
 * @param {object} options - window selection.
 * @param options.afterSeq - last consumed seq; events at or below it are ignored.
 * @param options.maxEvents - largest number of relevant entries in one batch.
 * @param options.maxBytes - largest byte size of the rendered trajectory.
 * @returns the selected entries, the window end, and what was passed over.
 */
export function batchWindow(events, options) {
  const afterSeq = options.afterSeq ?? -1
  const maxEvents = options.maxEvents ?? Number.POSITIVE_INFINITY
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
  const pending = events.filter(event => Number.isInteger(event?.seq) && event.seq > afterSeq)
  if (pending.length === 0) return { entries: [], toSeq: undefined, counts: emptyCounts(), unsupported: undefined, humanTurn: false }

  const counts = emptyCounts()
  const entries = []
  let toSeq
  let humanTurn = false
  let bytes = 0
  for (const event of pending) {
    const { kind } = classify(event)
    if (kind === 'unsupported') {
      // Stop before consuming it: the batch fails, and the mark stays put so the
      // window is retried once this build understands the event.
      return { entries: [], toSeq: undefined, counts, unsupported: event, humanTurn: false }
    }
    if (kind !== 'relevant') {
      counts[kind === 'ignorable' ? 'ignored' : kind] += 1
      toSeq = event.seq
      continue
    }
    const entry = normalizeEvent(event)
    if (entry === undefined) {
      counts.skipped += 1
      toSeq = event.seq
      continue
    }
    const capped = capEntry(entry, maxBytes)
    const size = Buffer.byteLength(JSON.stringify(capped), 'utf8')
    // The first entry is always taken, and truncated to the batch budget when it
    // is oversized on its own. Dropping it instead would leave a window that can
    // never be consumed, because the same event would head every later batch.
    if (entries.length > 0 && (entries.length >= maxEvents || bytes + size > maxBytes)) break
    entries.push(capped)
    bytes += size
    counts.relevant += 1
    if (isHumanTurn(event)) humanTurn = true
    toSeq = event.seq
  }
  return { entries, toSeq, counts, unsupported: undefined, humanTurn }
}

/**
 * Truncate one entry's text so a single pathological event cannot fill the batch.
 * @param entry - the normalized entry.
 * @param maxBytes - the batch budget, used as the per-entry ceiling.
 * @returns the entry, with its text shortened when it exceeded the ceiling.
 */
/** Fields that may carry unbounded text, by event kind. */
const FLEXIBLE_FIELDS = ['content', 'arguments']

/** Marks a field that was shortened to fit the batch's byte ceiling. */
export const TRUNCATION_MARKER = '…[truncated]'

/**
 * Smallest usable `maxTrajectoryBytesPerBatch`.
 *
 * A batch budget has to hold one serialized entry describing an event, including
 * the event's own type name and sequence number. Below this floor no such entry
 * can be written, so the setting would be a promise the plugin cannot keep; it is
 * refused at load instead.
 */
export const MIN_TRAJECTORY_BYTES_PER_BATCH = 128

function capEntry(entry, maxBytes) {
  if (!Number.isFinite(maxBytes)) return entry
  if (Buffer.byteLength(JSON.stringify(entry), 'utf8') <= maxBytes) return entry
  // Which field carries the unbounded text depends on the event: a message has
  // `content`, a tool call has `arguments`. Shrinking the wrong one leaves the
  // entry as large as it was.
  const field = FLEXIBLE_FIELDS.find(name => typeof entry[name] === 'string')
  if (field === undefined) return entry
  const text = String(entry[field])
  const points = Array.from(text)
  const build = (kept) => ({
    ...entry,
    [field]: kept >= points.length ? text : `${points.slice(0, kept).join('')}${TRUNCATION_MARKER}`,
  })
  if (Buffer.byteLength(JSON.stringify({ ...entry, [field]: '' }), 'utf8') >= maxBytes) {
    // The budget cannot hold this entry with any text. A truncated fragment would
    // not fit either, so the entry keeps only what it says about itself — and if
    // even that does not fit, a placeholder that always does. A field this
    // function cannot shrink (a tool name, say) must not become an entry that
    // silently exceeds the ceiling it was given.
    const empty = build(0)
    if (Buffer.byteLength(JSON.stringify(empty), 'utf8') <= maxBytes) return empty
    return { seq: entry.seq, type: 'truncated', truncated: true }
  }
  // The kept length is measured by serializing the candidate, not by counting
  // bytes of the field: JSON escapes what it writes, so the two differ.
  let low = 0
  let high = points.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(JSON.stringify(build(middle)), 'utf8') <= maxBytes) low = middle
    else high = middle - 1
  }
  return build(low)
}



/**
 * A zeroed tally of what a window contained.
 * @returns the tally.
 */
function emptyCounts() {
  return { relevant: 0, ignored: 0, internal: 0, skipped: 0 }
}
