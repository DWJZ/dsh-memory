/**
 * Consolidation progress: how far each Session has been consumed.
 *
 * The high-water mark is the canonical progress coordinate, and it counts raw
 * Session sequence numbers — not "relevant events", not "user messages". An
 * event that consolidation decided to skip still counts as consumed, or the
 * same ignored events would be rediscovered on every later idle period.
 *
 * The mark is advanced only after a batch settles successfully. A failure
 * leaves it where it was so the next eligible idle period retries the window.
 *
 * Usage: `import { readState, advanceHwm } from './state.js'`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { writeAtomic } from '../jsonstore.js'
import { withLock } from '../lock.js'
import { failureMessage } from '../errors.js'

/** Format version of `consolidation-state.json`. */
export const CONSOLIDATION_SCHEMA_VERSION = 1

/**
 * A Session with no recorded progress.
 *
 * `last_processed_seq` is `-1` rather than `0`, because seq 0 is a real event:
 * "nothing consumed yet" and "event 0 consumed" must not look alike.
 */
export const NO_PROGRESS = -1

/**
 * An empty consolidation state.
 * @returns the state document.
 */
/** One range of sequence numbers nobody observed. */
export interface ProgressGap {
  /** First seq in the gap. */
  from_seq: number
  /** Last seq in the gap. */
  to_seq: number
  /** When the gap was recorded, ISO-8601. */
  at: string
}

/** One Session's consolidation progress. */
export interface ConsolidationProgress {
  /** Highest seq whose window was fully consumed; -1 before the first run. */
  last_processed_seq: number
  /** Ranges the collector noticed were never observed. */
  gaps: ProgressGap[]
  /** When the record last advanced, ISO-8601. */
  updated_at?: string | undefined
}

/** Where the state document lives, and the lock that guards it. */
export interface StateLockOptions {
  /** The state file. */
  statePath: string
  /** Its lock file. */
  lockPath: string
  /** How long to wait for the lock before reporting the file. */
  lockTimeoutMs?: number
  /** Age at which an existing lock is treated as abandoned. */
  staleLockMs?: number
  /** Clock in epoch milliseconds. */
  now?(): number
  /** The host name written into the lock record. */
  host?: string
  /** Whether a recorded process is still alive. */
  kill?(pid: number, signal?: number | string): boolean
  /** Diagnostic sink. */
  logger?: { warn(message: string | Error): void; info?(message: string): void } | undefined
}

/** What one state mutation produces. */
export interface StateMutation {
  /** Whether anything changed; a mutation that changes nothing skips the write. */
  changed?: boolean | undefined
  /** The next document. */
  state: ConsolidationState
  /** What the caller gets back. */
  result?: unknown
}

/** The consolidation state document. */
export interface ConsolidationState {
  schema_version: number
  /** Per-Session progress, keyed by Session id. */
  sessions: Record<string, ConsolidationProgress>
}

export function emptyState(): ConsolidationState {
  return { schema_version: CONSOLIDATION_SCHEMA_VERSION, sessions: {} }
}

/**
 * Read the consolidation state.
 *
 * An absent file is a first run, not damage: it reads as empty state.
 * @param statePath - absolute path of `consolidation-state.json`.
 * @returns the state document.
 * @throws when the file is unreadable, malformed, or violates the schema.
 */
export function readState(statePath: string): ConsolidationState {
  if (!existsSync(statePath)) return emptyState()
  let parsed
  try {
    parsed = JSON.parse(readFileSync(statePath, 'utf8'))
  } catch (error) {
    throw new Error(`dsh-memory: ${statePath} is not valid JSON: ${failureMessage(error)}`)
  }
  validateState(parsed, statePath)
  return parsed
}

/**
 * Validate one consolidation state document.
 * @param state - the parsed document.
 * @param where - path named in failures.
 * @throws {TypeError} when the document violates the schema.
 */
export function validateState(state: unknown, where: string = 'consolidation state'): void {
  // Parsed from a durable file: read field by field after the checks below.
  const document = state as Record<string, unknown>
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    throw new TypeError(`dsh-memory: ${where} must hold a JSON object`)
  }
  if (document.schema_version !== CONSOLIDATION_SCHEMA_VERSION) {
    throw new TypeError(`dsh-memory: ${where} has schema_version ${JSON.stringify(document.schema_version)}, this build writes ${String(CONSOLIDATION_SCHEMA_VERSION)}`)
  }
  if (typeof document.sessions !== 'object' || document.sessions === null || Array.isArray(document.sessions)) {
    throw new TypeError(`dsh-memory: ${where} must hold a sessions object`)
  }
  for (const [sessionId, progress] of Object.entries(document.sessions as Record<string, unknown>)) {
    validateProgress(progress, `${where} session ${sessionId}`)
  }
}

/**
 * Validate one Session's progress record.
 * @param progress - the record.
 * @param where - description named in failures.
 * @throws {TypeError} when the record violates the schema.
 */
function validateProgress(progress: unknown, where: string): void {
  // Same boundary as `validateState`: field by field, after the checks.
  const record = progress as Record<string, unknown>
  if (typeof progress !== 'object' || progress === null || Array.isArray(progress)) {
    throw new TypeError(`dsh-memory: ${where} must be an object`)
  }
  const last = record.last_processed_seq
  if (typeof last !== 'number' || !Number.isInteger(last) || last < NO_PROGRESS) {
    throw new TypeError(`dsh-memory: ${where} needs an integer last_processed_seq >= ${String(NO_PROGRESS)}, got ${JSON.stringify(last)}`)
  }
  if (!Array.isArray(record.gaps)) {
    throw new TypeError(`dsh-memory: ${where} needs a gaps array`)
  }
  for (const gap of record.gaps) {
    if (typeof gap !== 'object' || gap === null || Array.isArray(gap)) {
      throw new TypeError(`dsh-memory: ${where} has a non-object gap`)
    }
    // A gap records a range nobody observed, so it may legitimately be empty;
    // what it may not be is inverted or incomplete.
    if (!Number.isInteger(gap.from_seq) || !Number.isInteger(gap.to_seq) || gap.to_seq < gap.from_seq - 1) {
      throw new TypeError(`dsh-memory: ${where} has an invalid gap ${JSON.stringify(gap)}`)
    }
    if (typeof gap.at !== 'string' || gap.at === '') {
      throw new TypeError(`dsh-memory: ${where} has a gap without a timestamp`)
    }
  }
}

/**
 * Progress for one Session.
 * @param state - the state document.
 * @param sessionId - the Session to look up.
 * @returns its record, or undefined when the Session has never been observed.
 */
export function progressFor(state: ConsolidationState, sessionId: string): ConsolidationProgress | undefined {
  return state.sessions[sessionId]
}

/**
 * The seq a batch for one Session may start after.
 * @param state - the state document.
 * @param sessionId - the Session to look up.
 * @returns the last consumed seq, or {@link NO_PROGRESS} when nothing is recorded.
 */
export function lastProcessedSeq(state: ConsolidationState, sessionId: string): number {
  return progressFor(state, sessionId)?.last_processed_seq ?? NO_PROGRESS
}

/**
 * Set one Session's high-water mark.
 *
 * Marks only move forward: a batch that finishes late must not pull progress
 * back behind a batch that already covered those events.
 * @param state - the current state document.
 * @param sessionId - the Session to update.
 * @param seq - the highest consumed seq.
 * @param at - ISO-8601 timestamp of the update.
 * @returns the next state document.
 */
export function advanceHwm(state: ConsolidationState, sessionId: string, seq: number, at: string): ConsolidationState {
  const current = progressFor(state, sessionId)
  if (current !== undefined && seq <= current.last_processed_seq) return state
  return withSession(state, sessionId, {
    last_processed_seq: seq,
    gaps: current?.gaps ?? [],
    updated_at: at,
  })
}

/**
 * Record that a range of events was never observed, then set the mark past it.
 *
 * This is what keeps "we could not see these events" distinct from "we looked
 * at these events and found nothing worth keeping". The gap is written down so
 * an audit can say which seqs were skipped and why, instead of the mark simply
 * jumping and the reason being unknowable later.
 * @param state - the current state document.
 * @param sessionId - the Session to update.
 * @param {object} range - the unobserved range.
 * @param range.from_seq - first unobserved seq.
 * @param range.to_seq - last unobserved seq.
 * @param at - ISO-8601 timestamp of the update.
 * @returns the next state document.
 */
export function recordGap(
  state: ConsolidationState,
  sessionId: string,
  range: { from_seq: number; to_seq: number },
  at: string,
): ConsolidationState {
  const current = progressFor(state, sessionId)
  const gaps = [...current?.gaps ?? [], { from_seq: range.from_seq, to_seq: range.to_seq, at }]
  return withSession(state, sessionId, {
    last_processed_seq: Math.max(range.to_seq, current?.last_processed_seq ?? NO_PROGRESS),
    gaps,
    updated_at: at,
  })
}

/**
 * Replace one Session's progress, leaving the others alone.
 * @param state - the current state document.
 * @param sessionId - the Session to write.
 * @param progress - its new progress record.
 * @returns the next state document.
 */
function withSession(state: ConsolidationState, sessionId: string, progress: ConsolidationProgress): ConsolidationState {
  return {
    schema_version: CONSOLIDATION_SCHEMA_VERSION,
    sessions: { ...state.sessions, [sessionId]: progress },
  }
}

/**
 * Run one state mutation while holding the state lock.
 *
 * Progress is shared by every Session in one harness home and by every process
 * using it, so a read-modify-write takes the same exclusive lock every other
 * writer takes, and commits through the same atomic write.
 * @param {object} options - state location and lock thresholds.
 * @param options.statePath - absolute path of `consolidation-state.json`.
 * @param options.lockPath - absolute path of its lock file.
 * @param options.lockTimeoutMs - how long to wait for the lock.
 * @param options.staleLockMs - age at which a lock becomes reclaimable.
 * @param options.logger - optional `{ warn }` sink.
 * @param options.now - clock, injectable for tests.
 * @param options.host - current host name.
 * @param operation - receives the latest state, returns the next state.
 * @returns the operation's result and the state now on disk.
 */
export async function withState(
  options: StateLockOptions,
  operation: (state: ConsolidationState) => StateMutation,
): Promise<{ result: unknown; state: ConsolidationState }> {
  return withLock(options, () => {
    const state = readState(options.statePath)
    const outcome = operation(state)
    if (outcome.changed !== true) return { result: outcome.result, state }
    writeAtomic(options.statePath, `${JSON.stringify(outcome.state, null, 2)}\n`)
    return { result: outcome.result, state: outcome.state }
  })
}
