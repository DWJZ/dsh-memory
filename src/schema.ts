/**
 * Memory record vocabulary, identity, and validation.
 *
 * This module is pure: it builds and checks records but never touches the file
 * system, so the schema rules are exercised without a store. Validation fails
 * loud and names the offending field, because a record that does not satisfy
 * these rules must never reach `memories.json`.
 *
 * @module dsh-memory/schema
 */

import { randomUUID } from 'node:crypto'
import type { MemoryRecord } from './types/memory.js'
import type { CheckOptions } from './types/seams.js'

/** Persistent scopes. A session is deliberately not one; it owns the trajectory. */
export const SCOPES = Object.freeze(['user', 'project'])

/** Categories a writer may choose. Phase 1 never infers one. */
export const CATEGORIES = Object.freeze(['preference', 'feedback', 'decision', 'lesson', 'state', 'reference'])

/** Record lifecycle states. `archived` is a status, never a second copy on disk. */
export const STATUSES = Object.freeze(['active', 'superseded', 'archived'])

/** Provenance kinds, strongest first is a ranking hint only, never an ordering rule. */
export const EVIDENCE_KINDS = Object.freeze(['user', 'tool', 'agent'])

/** Longest accepted `content`, counted in Unicode code points. */
export const MAX_CONTENT_CHARS = 500

/**
 * Mint one Memory id.
 * @returns a `mem_`-prefixed identifier.
 */
export function newMemoryId() {
  return `mem_${randomUUID()}`
}

/**
 * Mint one project id.
 * @returns a `proj_`-prefixed identifier.
 */
export function newProjectId() {
  return `proj_${randomUUID()}`
}

/** Exact shape of a Memory id, as minted by {@link newMemoryId}. */
export const MEMORY_ID_PATTERN = /^mem_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/** Exact shape of a project id, as minted by {@link newProjectId}. */
export const PROJECT_ID_PATTERN = /^proj_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u

/**
 * Whether a value is a well-formed Memory id.
 * @param value - the value to test.
 * @returns true when the value is a `mem_` id this plugin could have minted.
 */
export function isMemoryId(value: unknown): value is string {
  return typeof value === 'string' && MEMORY_ID_PATTERN.test(value)
}

/**
 * Whether a value is a well-formed project id.
 *
 * A project id becomes a directory name, so a malformed one is a path-safety
 * question rather than only a schema question.
 * @param value - the value to test.
 * @returns true when the value is a `proj_` id this plugin could have minted.
 */
export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID_PATTERN.test(value)
}

/**
 * Normalize content for exact-duplicate comparison.
 *
 * Case is preserved on purpose: `Model-X` and `model-x` can be different
 * identifiers, so folding case would drop a genuinely distinct Memory.
 * @param text - the raw content.
 * @returns trimmed, whitespace-collapsed, NFC-normalized text.
 */
export function normalizeContent(text: string) {
  return String(text).normalize('NFC').replace(/\s+/gu, ' ').trim()
}

/**
 * Count Unicode code points, so a limit never splits a surrogate pair.
 * @param text - the text to measure.
 * @returns the number of code points.
 */
export function charLength(text: string) {
  return Array.from(text).length
}

/**
 * Truncate to a code-point budget.
 * @param text - the text to truncate.
 * @param limit - maximum number of code points to keep.
 * @returns the truncated text.
 */
export function truncateChars(text: string, limit: number): string {
  const points = Array.from(text)
  return points.length <= limit ? text : points.slice(0, limit).join('')
}

/**
 * Whether a value is an ISO-8601 UTC instant with millisecond precision.
 * @param value - the value to test.
 * @returns true when the value is a canonical timestamp this plugin writes.
 */
export function isTimestamp(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
}

/**
 * Validate one Memory record against the contract's schema rules.
 *
 * Rule 4's second half — that `superseded_by` names a record the store actually
 * holds — is a property of the whole store, so {@link validateStoreRecords}
 * enforces it.
 * @param record - the candidate record.
 * @param {object} options - validation inputs that are not part of the record.
 * @param options.maxEvidencePerMemory - largest accepted evidence list; reading a
 *   stored document omits it, because the cap is a writer's choice rather than a
 *   property of a valid record.
 * @throws {TypeError} when the record violates any schema rule.
 */
export function validateMemory(record: MemoryRecord, options: CheckOptions = {}) {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) {
    throw new TypeError('dsh-memory: memory record must be an object')
  }

  if (!isMemoryId(record.id)) {
    throw new TypeError(`dsh-memory: id must be a Memory id, got ${JSON.stringify(record.id)}`)
  }
  requireMember(record.scope, SCOPES, 'scope')
  requireMember(record.category, CATEGORIES, 'category')
  requireMember(record.status, STATUSES, 'status')

  if (record.scope === 'project') {
    if (!isProjectId(record.project_id)) {
      throw new TypeError(`dsh-memory: memory ${record.id}: project_id must be a project id, got ${JSON.stringify(record.project_id)}`)
    }
  } else if (record.project_id !== null) {
    throw new TypeError(`dsh-memory: memory ${record.id}: project_id must be null for scope "user", got ${JSON.stringify(record.project_id)}`)
  }

  if (typeof record.content !== 'string' || record.content.trim() === '') {
    throw new TypeError(`dsh-memory: memory ${record.id}: content must be a non-empty string`)
  }
  if (/[\n\r\u2028\u2029]/u.test(record.content)) {
    throw new TypeError(`dsh-memory: memory ${record.id}: content must be a single line`)
  }
  if (charLength(record.content) > MAX_CONTENT_CHARS) {
    throw new TypeError(`dsh-memory: memory ${record.id}: content must be at most ${String(MAX_CONTENT_CHARS)} characters`)
  }

  if (typeof record.confidence !== 'number' || !Number.isFinite(record.confidence)
    || record.confidence < 0 || record.confidence > 1) {
    throw new TypeError(`dsh-memory: memory ${record.id}: confidence must be a number in [0, 1], got ${JSON.stringify(record.confidence)}`)
  }

  if (record.status === 'superseded') {
    if (!isMemoryId(record.superseded_by)) {
      throw new TypeError(`dsh-memory: memory ${record.id}: superseded_by must be a Memory id, got ${JSON.stringify(record.superseded_by)}`)
    }
  } else if (record.superseded_by !== null) {
    throw new TypeError(`dsh-memory: memory ${record.id}: superseded_by must be null unless status is "superseded"`)
  }

  requireTimestamp(record.created_at, record.id, 'created_at')
  requireTimestamp(record.updated_at, record.id, 'updated_at')
  if (record.updated_at < record.created_at) {
    throw new TypeError(`dsh-memory: memory ${record.id}: updated_at must not precede created_at`)
  }

  if (!Array.isArray(record.evidence)) {
    throw new TypeError(`dsh-memory: memory ${record.id}: evidence must be an array`)
  }
  const cap = options.maxEvidencePerMemory ?? Number.POSITIVE_INFINITY
  if (record.evidence.length > cap) {
    throw new TypeError(`dsh-memory: memory ${record.id}: evidence must hold at most ${String(cap)} entries`)
  }
  record.evidence.forEach((entry, index) => { validateEvidence(entry, record.id, index) })
}

/**
 * Validate a whole store's records, including the rules no single record can
 * answer.
 *
 * `memories.json` is the source of truth, so a document that violates its own
 * schema is refused rather than propagated into an index or a view: a record
 * claiming to be superseded by a record that is not there is an inconsistency a
 * reader would silently believe.
 * @param records - every record the store holds.
 * @param {object} options - validation inputs that are not part of a record.
 * @param options.maxEvidencePerMemory - largest accepted evidence list.
 * @throws {TypeError} when any record is invalid, ids repeat, or a supersession
 *   reference dangles.
 */
export function validateStoreRecords(records: MemoryRecord[], options: CheckOptions = {}) {
  if (!Array.isArray(records)) throw new TypeError('dsh-memory: a store document must hold a records array')
  const known = new Set()
  for (const record of records) {
    validateMemory(record, options)
    if (known.has(record.id)) {
      throw new TypeError(`dsh-memory: memory ${record.id} appears more than once in one store`)
    }
    known.add(record.id)
  }
  for (const record of records) {
    if (record.status !== 'superseded') continue
    if (!known.has(record.superseded_by)) {
      throw new TypeError(`dsh-memory: memory ${record.id} claims to be superseded by ${record.superseded_by}, which this store does not hold`)
    }
  }
}

/**
 * Validate one provenance entry.
 * @param entry - the candidate evidence entry.
 * @param memoryId - owning Memory id, named in the failure.
 * @param index - position in the evidence list, named in the failure.
 * @throws {TypeError} when the entry violates any schema rule.
 */
function validateEvidence(entry: unknown, memoryId: string, index: number): void {
  // Model- and file-supplied: read field by field after the checks below.
  const record = entry as Record<string, unknown>
  const where = `memory ${memoryId}: evidence[${String(index)}]`
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new TypeError(`dsh-memory: ${where} must be an object`)
  }
  requireMember(record.kind, EVIDENCE_KINDS, `${where}.kind`)
  requireNonEmptyString(record.session_id, `${where}.session_id`)
  if (typeof record.quote !== 'string') throw new TypeError(`dsh-memory: ${where}.quote must be a string`)
  if (!Array.isArray(record.event_seqs) || record.event_seqs.some(seq => !Number.isInteger(seq) || seq < 0)) {
    throw new TypeError(`dsh-memory: ${where}.event_seqs must be an array of non-negative integers`)
  }
  if (!isTimestamp(record.observed_at)) {
    throw new TypeError(`dsh-memory: ${where}.observed_at must be an ISO-8601 UTC timestamp`)
  }
}

/**
 * Require one non-empty string field.
 * @param value - the value to test.
 * @param field - field name, named in the failure.
 */
function requireNonEmptyString(value: unknown, field: string): void {
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`dsh-memory: ${field} must be a non-empty string, got ${JSON.stringify(value)}`)
  }
}

/**
 * Require one field to be a member of a closed vocabulary.
 * @param value - the value to test.
 * @param allowed - the accepted members.
 * @param field - field name, named in the failure.
 */
function requireMember(value: unknown, allowed: readonly string[], field: string): void {
  if (!allowed.includes(value)) {
    throw new TypeError(`dsh-memory: ${field} must be one of ${allowed.join(', ')}, got ${JSON.stringify(value)}`)
  }
}

/**
 * Require one ISO-8601 UTC timestamp field.
 * @param value - the value to test.
 * @param memoryId - owning Memory id, named in the failure.
 * @param field - field name, named in the failure.
 */
function requireTimestamp(value, memoryId, field: string) {
  if (!isTimestamp(value)) {
    throw new TypeError(`dsh-memory: memory ${memoryId}: ${field} must be an ISO-8601 UTC timestamp, got ${JSON.stringify(value)}`)
  }
}
