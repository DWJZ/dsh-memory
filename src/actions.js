/**
 * The six Memory operations, and the guarantees each one owes.
 *
 * Every mutation runs under its scope's store lock and revalidates its target
 * against the latest state, so a target another process superseded while this one
 * waited becomes a conflict rather than a silent overwrite. A target that is not
 * visible to the caller — another project's record — is a conflict too, never an
 * update.
 *
 * Phase 1 performs no semantic reasoning. Whether `pnpm` contradicts `npm` is the
 * model's judgement, expressed by calling `supersede` with a target id; the only
 * overlap this layer recognises is an exact duplicate, compared without folding
 * case, because `Model-X` and `model-x` can be different things.
 *
 * @module dsh-memory/actions
 */

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'
import { readStore, withStore } from './jsonstore.js'
import { withLock } from './lock.js'
import { mutateAndRefreshView } from './views.js'
import { findSecretIn } from './redact.js'
import { MAX_CONTENT_CHARS, charLength, newMemoryId, normalizeContent, validateMemory } from './schema.js'

/**
 * Confidence of a record the user asked for directly.
 *
 * An explicit request is not a judgement about how likely a fact is; the user
 * said it, so it is certain. Automatic consolidation supplies its own value,
 * which is the model's estimate of how well the trajectory grounds the fact.
 */
export const PHASE1_CONFIDENCE = 1.0

/**
 * Read the confidence a writer supplied, or fall back.
 * @param value - the supplied confidence, when there is one.
 * @param fallback - the value to use when there is not.
 * @returns the validated confidence.
 * @throws {TypeError} when a supplied value is not a number in [0, 1].
 */
function requireConfidence(value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`dsh-memory: confidence must be a number in [0, 1], got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Add one Memory, unless an active record already says the same thing.
 * @param options - scopes, thresholds, and logger.
 * @param input - the new Memory.
 * @param input.content - the fact to remember.
 * @param input.scope - `user` or `project`.
 * @param input.category - the chosen category.
 * @param input.projectId - the project, required for project scope.
 * @param input.evidence - provenance the host built from the current turn.
 * @param input.sourceTexts - complete texts to screen before any truncation.
 * @returns the applied action and the affected id.
 */
export async function addMemory(options, input) {
  const layout = requireLayout(options, input.scope, input.projectId)
  const content = requireContent(input.content)
  const screened = screen([...input.sourceTexts ?? [], content], input.evidence?.quote)
  if (screened !== undefined) return noop(`secret-detected:${screened}`)

  return apply(options, layout, (store) => {
    // The effective project is what the record will store, so a user-scope write
    // compares against other user-scope records rather than a project's.
    const projectId = input.scope === 'project' ? input.projectId : null
    const duplicate = store.records.find(record => record.status === 'active'
      && record.scope === input.scope
      && record.project_id === projectId
      && record.category === input.category
      && normalizeContent(record.content) === normalizeContent(content))
    if (duplicate !== undefined) return { changed: false, result: { action: 'noop', id: duplicate.id, reason: 'duplicate' } }

    const at = nowIso(options)
    const record = {
      id: newMemoryId(),
      scope: input.scope,
      project_id: input.scope === 'project' ? input.projectId : null,
      category: input.category,
      content,
      confidence: requireConfidence(input.confidence, PHASE1_CONFIDENCE),
      evidence: input.evidence === undefined ? [] : [input.evidence],
      created_at: at,
      updated_at: at,
      status: 'active',
      superseded_by: null,
    }
    validateMemory(record, { maxEvidencePerMemory: options.maxEvidencePerMemory })
    return { changed: true, records: [...store.records, record], result: { action: 'added', id: record.id } }
  })
}

/**
 * Restate one Memory, keeping its identity and accumulating provenance.
 * @param options - scopes, thresholds, and logger.
 * @param input - the update.
 * @param input.id - the record to update.
 * @param input.content - the restated fact.
 * @param input.projectId - the current project, used to decide visibility.
 * @param input.evidence - provenance the host built from the current turn.
 * @param input.sourceTexts - complete texts to screen before any truncation.
 * @returns the applied action and the record id.
 */
export async function updateMemory(options, input) {
  const located = locateVisible(options, input.id, input.projectId)
  const content = requireContent(input.content)
  const screened = screen([...input.sourceTexts ?? [], content], input.evidence?.quote)
  if (screened !== undefined) return noop(`secret-detected:${screened}`)

  return apply(options, located.layout, (store) => {
    const current = requireActive(store, input.id)
    const evidence = accumulate(current.evidence, input.evidence, options.maxEvidencePerMemory)
    const record = {
      ...current,
      content,
      evidence,
      confidence: requireConfidence(input.confidence, current.confidence),
      updated_at: nowIso(options),
    }
    validateMemory(record, { maxEvidencePerMemory: options.maxEvidencePerMemory })
    return {
      changed: true,
      records: store.records.map(entry => entry.id === record.id ? record : entry),
      result: { action: 'updated', id: record.id },
    }
  })
}

/**
 * Replace one Memory with a newer fact, retiring the old record in the same write.
 * @param options - scopes, thresholds, and logger.
 * @param input - the replacement.
 * @param input.id - the record being superseded.
 * @param input.content - the newer fact.
 * @param input.projectId - the current project, used to decide visibility.
 * @param input.evidence - provenance the host built from the current turn.
 * @param input.sourceTexts - complete texts to screen before any truncation.
 * @returns the applied action, the new id, and the retired id.
 */
export async function supersedeMemory(options, input) {
  const located = locateVisible(options, input.id, input.projectId)
  const content = requireContent(input.content)
  const screened = screen([...input.sourceTexts ?? [], content], input.evidence?.quote)
  if (screened !== undefined) return noop(`secret-detected:${screened}`)

  return apply(options, located.layout, (store) => {
    const current = requireActive(store, input.id)
    const at = nowIso(options)
    const replacement = {
      id: newMemoryId(),
      scope: current.scope,
      project_id: current.project_id,
      category: current.category,
      content,
      confidence: requireConfidence(input.confidence, PHASE1_CONFIDENCE),
      evidence: input.evidence === undefined ? [] : [input.evidence],
      created_at: at,
      updated_at: at,
      status: 'active',
      superseded_by: null,
    }
    validateMemory(replacement, { maxEvidencePerMemory: options.maxEvidencePerMemory })
    // The retired record keeps its created_at/updated_at: what changed is its
    // status, and the replacement carries the newer content.
    const retired = { ...current, status: 'superseded', superseded_by: replacement.id }
    // Retiring adds no evidence, so the current cap does not apply to it:
    // lowering the cap must not make an existing record impossible to retire.
    validateMemory(retired)
    return {
      changed: true,
      records: [...store.records.map(entry => entry.id === retired.id ? retired : entry), replacement],
      result: { action: 'superseded', id: replacement.id, superseded_id: retired.id },
    }
  })
}

/**
 * Retire one Memory without deleting it. Archived records leave the index and
 * ordinary retrieval but stay in the canonical store.
 * @param options - scopes, thresholds, and logger.
 * @param input - the archive request.
 * @param input.id - the record to archive.
 * @param input.projectId - the current project, used to decide visibility.
 * @returns the applied action and the record id.
 */
export async function archiveMemory(options, input) {
  const located = locateVisible(options, input.id, input.projectId)
  return apply(options, located.layout, (store) => {
    const current = requireActive(store, input.id)
    const record = { ...current, status: 'archived' }
    // Archiving adds no evidence, so the current cap does not apply to it.
    validateMemory(record)
    return {
      changed: true,
      records: store.records.map(entry => entry.id === record.id ? record : entry),
      result: { action: 'archived', id: record.id },
    }
  })
}

/**
 * Delete one Memory outright, leaving only a tombstone that carries no content.
 * @param options - scopes, thresholds, tombstones, and logger.
 * @param input - the forget request.
 * @param input.id - the record to delete.
 * @param input.projectId - the current project, used to decide visibility.
 * @returns the applied action and the deleted id.
 */
export async function forgetMemory(options, input) {
  const located = locateVisible(options, input.id, input.projectId)
  const outcome = await apply(options, located.layout, (store) => {
    const doomed = store.records.find(entry => entry.id === input.id)
    if (doomed === undefined) {
      throw new Error(`dsh-memory: memory ${input.id} is no longer present`)
    }
    // Deleting a record must not leave others claiming to be superseded by it.
    // A predecessor either inherits the deleted record's successor, keeping the
    // chain intact, or — when there is nothing to inherit — becomes an archived
    // record that no longer asserts anything about a successor.
    const survivor = doomed.superseded_by !== null
      && store.records.some(entry => entry.id === doomed.superseded_by)
      ? doomed.superseded_by
      : undefined
    const repaired = store.records
      .filter(entry => entry.id !== input.id)
      .map((entry) => {
        if (entry.superseded_by !== input.id) return entry
        return survivor === undefined
          ? { ...entry, status: 'archived', superseded_by: null }
          : { ...entry, superseded_by: survivor }
      })
    return {
      changed: true,
      records: repaired,
      result: { action: 'forgotten', id: input.id },
    }
  })
  // The deletion is the guarantee; the tombstone is a body-free trace of it, so a
  // failure to write the trace is reported rather than undoing a completed delete.
  const tombstoned = await recordTombstone(options, {
    op: 'forget',
    id: input.id,
    scope: located.record.scope,
    project_id: located.record.project_id,
    deleted_at: nowIso(options),
  })
  return { ...outcome, tombstoneWritten: tombstoned }
}

/**
 * Delete every Memory in one scope, leaving one summary tombstone.
 * @param options - scopes, thresholds, tombstones, and logger.
 * @param input - the clear request.
 * @param input.scope - `user` or `project`.
 * @param input.projectId - the project, required for project scope.
 * @returns the applied action and how many records were deleted.
 */
export async function clearScope(options, input) {
  const layout = requireLayout(options, input.scope, input.projectId)
  const outcome = await apply(options, layout, (store) => {
    if (store.records.length === 0) {
      return { changed: false, result: { action: 'noop', reason: 'empty-scope', count: 0 } }
    }
    return {
      changed: true,
      records: [],
      result: { action: 'cleared', count: store.records.length },
    }
  })
  if (outcome.action !== 'cleared') return outcome
  return {
    ...outcome,
    tombstoneWritten: await recordTombstone(options, {
      op: 'clear',
      scope: input.scope,
      project_id: input.scope === 'project' ? input.projectId : null,
      count: outcome.count,
      deleted_at: nowIso(options),
    }),
  }
}

/**
 * Raised when a Memory is not among the scopes a caller may read.
 *
 * A store that cannot be read is a different failure with a different remedy, so
 * callers that turn "not found" into a user-facing answer must be able to tell
 * the two apart.
 */
export class MemoryNotVisibleError extends Error {
  /**
   * Describe one invisible record.
   * @param id - the record the caller asked for.
   */
  constructor(id) {
    super(`dsh-memory: memory ${id} is not visible to this session`)
    this.name = 'MemoryNotVisibleError'
    /** The id that could not be found. */
    this.id = id
  }
}

/**
 * Find one record among the scopes the caller may read.
 * @param options - scopes and thresholds.
 * @param id - the record to find.
 * @param projectId - the caller's current project, when it has one.
 * @returns the record, its scope, and that scope's layout.
 * @throws {MemoryNotVisibleError} when no visible scope holds the record.
 */
export function locateVisible(options, id, projectId) {
  for (const candidate of visibleScopes(options, projectId)) {
    const record = readStore(candidate.layout.storePath).records.find(entry => entry.id === id)
    if (record !== undefined) return { scope: candidate.scope, layout: candidate.layout, record }
  }
  throw new MemoryNotVisibleError(id)
}

/**
 * Append one tombstone under the tombstone lock.
 *
 * The log is shared by every scope, so the append takes a lock rather than relying
 * on one line being atomic on every filesystem. The entry carries no content,
 * evidence, or quote: the point of a tombstone is that the Memory is gone.
 * @param options - tombstone location, thresholds, and logger.
 * @param entry - the tombstone record.
 * @returns fulfillment once the line is durable.
 */
export async function appendTombstone(options, entry) {
  const target = options.tombstones
  if (target === undefined) throw new Error('dsh-memory: no tombstone location is configured')
  mkdirSync(dirname(target.path), { recursive: true })
  await withLock({
    ...target,
    lockTimeoutMs: options.lockTimeoutMs,
    staleLockMs: options.staleLockMs,
    logger: options.logger,
    now: options.now,
    host: options.host,
    kill: options.kill,
  }, () => {
    const fd = openSync(target.path, 'a', 0o600)
    try {
      writeSync(fd, `${JSON.stringify(entry)}\n`)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  })
}

/**
 * Append a tombstone, reporting rather than failing when the log is unwritable.
 * @param options - tombstone location, thresholds, and logger.
 * @param entry - the tombstone record.
 * @returns whether the tombstone reached the log, so a caller can word its
 *   report truthfully instead of promising a trace it does not have.
 */
async function recordTombstone(options, entry) {
  try {
    await appendTombstone(options, entry)
    return true
  } catch (error) {
    options.logger?.warn(`dsh-memory: could not append the tombstone for ${String(entry.id ?? entry.op)}: ${String(error?.message ?? error)}`)
    return false
  }
}

/**
 * Screen every text that would be persisted.
 *
 * Two passes, because truncating first can cut a credential into a fragment that
 * no longer matches any pattern while still carrying most of the secret: the full
 * source text is screened before the quote is truncated, and the finished record
 * is screened again before it is stored.
 * @param fullTexts - complete texts, before truncation.
 * @param persistedQuote - the truncated quote that will be stored.
 * @returns the matching rule name, or undefined when everything is clean.
 */
function screen(fullTexts, persistedQuote) {
  const beforeTruncation = findSecretIn(fullTexts.map(text => String(text ?? '')))
  if (beforeTruncation !== undefined) return beforeTruncation.name
  if (persistedQuote === undefined) return undefined
  return findSecretIn([persistedQuote])?.name
}

/**
 * Accumulate provenance, keeping the newest entries at the cap.
 * @param existing - the record's evidence.
 * @param addition - the new entry, when there is one.
 * @param limit - the largest accepted list.
 * @returns the accumulated list.
 */
function accumulate(existing, addition, limit) {
  const combined = addition === undefined ? [...existing] : [...existing, addition]
  return combined.slice(-limit)
}

/**
 * Run one scope mutation and flatten its outcome for callers.
 * @param options - scopes, thresholds, and logger.
 * @param layout - the target scope's layout.
 * @param operation - receives the latest store, returns `{ result, changed, records }`.
 * @returns the operation's result plus the committed revision and view state.
 */
async function apply(options, layout, operation) {
  const outcome = await mutateAndRefreshView(scopeOptions(options, layout), operation)
  return { ...outcome.result, revision: outcome.revision, viewStale: outcome.viewStale }
}

/**
 * Require one record to still be active.
 * @param store - the store as read under the lock.
 * @param id - the record id.
 * @returns the stored record.
 * @throws when the record is gone or no longer active.
 */
function requireActive(store, id) {
  const record = store.records.find(entry => entry.id === id)
  if (record === undefined) throw new Error(`dsh-memory: memory ${id} is no longer present`)
  if (record.status !== 'active') {
    throw new Error(`dsh-memory: memory ${id} is ${record.status} and cannot be modified`)
  }
  return record
}

/**
 * Resolve the layout one scope writes to.
 * @param options - scopes and thresholds.
 * @param scope - `user` or `project`.
 * @param projectId - the project, required for project scope.
 * @returns that scope's layout.
 * @throws when the caller has no project scope.
 */
function requireLayout(options, scope, projectId) {
  if (scope === 'user') return options.scopes.user
  if (projectId === undefined || projectId === null) {
    throw new Error('dsh-memory: project scope requires a project; this session has none')
  }
  const layout = options.scopes.project(projectId)
  if (layout === undefined) throw new Error(`dsh-memory: unknown project ${projectId}`)
  return layout
}

/**
 * Every scope one session may read.
 * @param options - scopes and thresholds.
 * @param projectId - the caller's current project, when it has one.
 * @returns the user scope, then the current project's scope when it has one.
 */
function visibleScopes(options, projectId) {
  const scopes = [{ scope: 'user', layout: options.scopes.user }]
  if (projectId !== undefined && projectId !== null) {
    const layout = options.scopes.project(projectId)
    if (layout !== undefined) scopes.push({ scope: 'project', layout })
  }
  return scopes
}

/**
 * Combine one scope's layout with the thresholds a store mutation needs.
 * @param options - scopes, thresholds, and logger.
 * @param layout - the target scope's layout.
 * @returns options for one store call.
 */
function scopeOptions(options, layout) {
  return {
    ...layout,
    lockTimeoutMs: options.lockTimeoutMs,
    staleLockMs: options.staleLockMs,
    logger: options.logger,
    now: options.now,
    host: options.host,
    kill: options.kill,
  }
}

/**
 * Require one usable content value.
 * @param content - the raw content.
 * @returns the normalized content.
 * @throws when the content is unusable.
 */
function requireContent(content) {
  const normalized = normalizeContent(content ?? '')
  if (normalized === '') throw new Error('dsh-memory: content must not be empty')
  if (charLength(normalized) > MAX_CONTENT_CHARS) {
    throw new Error(`dsh-memory: content must be at most ${String(MAX_CONTENT_CHARS)} characters`)
  }
  return normalized
}

/**
 * Build the outcome of a refused write.
 * @param reason - why nothing was stored.
 * @returns a noop outcome.
 */
function noop(reason) {
  return { action: 'noop', id: null, reason }
}

/**
 * Current time as a record timestamp.
 * @param options - clock source.
 * @returns an ISO-8601 UTC instant with millisecond precision.
 */
function nowIso(options) {
  return new Date((options.now ?? Date.now)()).toISOString()
}
