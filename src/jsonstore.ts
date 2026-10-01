/**
 * Canonical store persistence.
 *
 * `memories.json` is the source of truth: `{ schema_version, revision, records }`.
 * Every mutation runs under the store lock against the latest revision, so a
 * writer never validates against state another process has already replaced.
 *
 * The temporary file is written, flushed, and renamed into place, and is removed
 * when any step before the rename fails — a store that cannot be written must not
 * leave fragments of old Memory behind in the memory directory.
 *
 * @module dsh-reflection/jsonstore
 */

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'
import { withLock } from './lock.js'
import { validateStoreRecords } from './schema.js'
import { failureMessage } from './errors.js'
import type { SweepOptions } from './types/seams.js'
import type { MemoryRecord, MemoryStore } from './types/memory.js'

/** Format version this build writes; an unknown version is refused, never guessed. */
export const STORE_SCHEMA_VERSION = 1

/** Suffix every temporary file this plugin creates carries. */
export const TEMP_MARKER = '.dsh-reflection-tmp-'

/**
 * Build an empty store.
 * @returns a store with no records and revision 0.
 */
export function emptyStore() {
  return { schema_version: STORE_SCHEMA_VERSION, revision: 0, records: [] }
}

/**
 * Read one canonical store and validate every record it holds.
 *
 * Validation happens on the way in as well as on the way out: a store someone
 * edited by hand, or one left by an older build, must fail loudly here rather
 * than have its invalid records reach an index, a view, or a model request.
 * @param storePath - absolute path of `memories.json`.
 * @returns the stored document, or an empty store when the file is absent.
 * @throws when the file is unreadable, malformed, or violates the record schema.
 */
export function readStore(storePath: string) {
  const document = parseStore(storePath)
  validateStoreRecords(document.records)
  return document
}

/**
 * Read one canonical store, checking only the document's own shape.
 * @param storePath - absolute path of `memories.json`.
 * @returns the stored document, or an empty store when the file is absent.
 * @throws when the file is unreadable, malformed, or written by another format version.
 */
function parseStore(storePath: string) {
  if (!existsSync(storePath)) return emptyStore()
  const text = readFileSync(storePath, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`dsh-reflection: ${storePath} is not valid JSON: ${failureMessage(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`dsh-reflection: ${storePath} must hold a JSON object`)
  }
  if (parsed.schema_version !== STORE_SCHEMA_VERSION) {
    throw new Error(`dsh-reflection: ${storePath} has schema_version ${JSON.stringify(parsed.schema_version)}, this build writes ${String(STORE_SCHEMA_VERSION)}`)
  }
  if (!Number.isInteger(parsed.revision) || parsed.revision < 0) {
    throw new Error(`dsh-reflection: ${storePath} has an invalid revision ${JSON.stringify(parsed.revision)}`)
  }
  if (!Array.isArray(parsed.records)) {
    throw new Error(`dsh-reflection: ${storePath} must hold a records array`)
  }
  return parsed
}

/**
 * Write text to a file atomically, removing the temporary file on any failure.
 * @param targetPath - the file to replace.
 * @param text - the complete new content.
 * @throws when the content cannot be committed.
 */
export function writeAtomic(targetPath: string, text: string) {
  const dir = dirname(targetPath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `${randomUUID()}${TEMP_MARKER}${basename(targetPath)}`)
  let fd
  let committed = false
  try {
    fd = openSync(tmpPath, 'wx', 0o600)
    writeSync(fd, text)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmpPath, targetPath)
    committed = true
    fsyncDirectory(dir)
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // The descriptor is already unusable; the temporary file is removed below.
      }
    }
    if (!committed) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // Best effort: a leftover temporary file is cleaned on the next mount.
      }
    }
  }
}

/**
 * Remove this plugin's abandoned temporary files below one directory.
 *
 * Temporary files live beside the store they belong to, so scopes nested under
 * the Memory root are swept too. A file is removed only when it carries this
 * plugin's own marker AND is older than the threshold: a marker alone cannot
 * mean "abandoned", because another process may be writing that very file right
 * now, and deleting it would make that writer's rename fail.
 * @param dir - the Memory root to sweep.
 * @param {object} options - sweep inputs.
 * @param options.staleTempMs - age at which a temporary file is abandoned.
 * @param options.now - clock, injectable for tests.
 * @returns the number of files removed.
 */
export function cleanupStaleTemps(dir: string, options: SweepOptions = {}) {
  if (!existsSync(dir)) return 0
  const now = options.now ?? Date.now
  const staleTempMs = options.staleTempMs ?? Number.POSITIVE_INFINITY
  let removed = 0
  for (const path of findTemps(dir)) {
    try {
      const stats = statSync(path)
      if (!stats.isFile()) continue
      if (now() - stats.mtimeMs <= staleTempMs) continue
      unlinkSync(path)
      removed += 1
    } catch {
      // A concurrent writer may own this file; it cleans up after itself.
    }
  }
  return removed
}

/**
 * Every temporary file this plugin left below one directory.
 * @param dir - the directory to walk.
 * @returns absolute paths, deepest last.
 */
function findTemps(dir: string) {
  const found: string[] = []
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...findTemps(path))
      continue
    }
    if (entry.name.includes(TEMP_MARKER)) found.push(path)
  }
  return found
}

/**
 * Apply one mutation to the canonical store under the store lock.
 *
 * The operation receives the latest stored revision, so a target it judges
 * against cannot be replaced between the check and the write.
 * @param {object} options - store location and lock thresholds.
 * @param options.storePath - absolute path of `memories.json`.
 * @param options.lockPath - absolute path of the store lock file.
 * @param options.lockTimeoutMs - how long to wait for the lock.
 * @param options.staleLockMs - age at which a lock becomes reclaimable.
 * @param options.host - current host name.
 * @param options.kill - signal sender, injectable for tests.
 * @param options.now - clock, injectable for tests.
 * @param options.logger - optional `{ warn }` sink.
 * @param operation - receives the latest store, returns `{ result, changed }`.
 * @returns the operation's result and the store now on disk.
 */
/** Where one store lives, and the lock that guards it. */
export interface StoreLockOptions {
  /** The store file. */
  storePath: string
  /** Its lock file. */
  lockPath: string
  /** How long to wait for the lock before reporting the file. */
  lockTimeoutMs: number
  /** Age at which an existing lock is treated as abandoned. */
  staleLockMs: number
  /** Clock in epoch milliseconds. */
  now?(): number
  /** The host name written into the lock record. */
  host?: string
  /** Whether a recorded process is still alive. */
  kill?(pid: number, signal?: number | string): boolean
  /** Diagnostic sink. */
  logger?: { warn(message: string | Error): void; info?(message: string): void } | undefined
}

/**
 * What one store mutation produces.
 *
 * A mutation that reports a change must supply the records to write; one that does
 * not is skipped and carries none, which is what lets the writer read them without
 * a second check.
 */
export type StoreMutation<T = Record<string, unknown>> =
  | { changed: true; records: MemoryRecord[]; result?: T }
  | { changed?: false | undefined; records?: undefined; result?: T }

export async function withStore<T = Record<string, unknown>>(
  options: StoreLockOptions,
  operation: (store: MemoryStore) => StoreMutation<T> | undefined,
) {
  return withLock(options, () => {
    const store = parseStore(options.storePath)
    // Validate what is already on disk before the mutation runs. An operation
    // that changes nothing must still refuse a store that violates its own
    // schema, and every operation is then allowed to build on a store that holds.
    validateStoreRecords(store.records)
    const outcome = operation(store)
    // Checked without optional chaining so the compiler keeps the answer narrowed
    // to the one that reported a change.
    if (outcome === undefined || outcome.changed !== true) {
      return { result: outcome?.result, revision: store.revision, store }
    }
    const next = {
      schema_version: STORE_SCHEMA_VERSION,
      revision: store.revision + 1,
      records: outcome.records,
    }
    // The evidence cap is deliberately not applied here — it bounds what a writer
    // may append, not what a valid record is, so a store written under a larger
    // cap must still load after a deployment lowers it.
    validateStoreRecords(next.records)
    writeAtomic(options.storePath, `${JSON.stringify(next, null, 2)}\n`)
    return { result: outcome.result, revision: next.revision, store: next }
  })
}

/**
 * Remove one store's directory, used by tests and by an explicit scope reset.
 * @param dir - the directory to remove.
 * @returns fulfillment once the directory is gone.
 */
export async function removeStoreDir(dir: string) {
  await rm(dir, { recursive: true, force: true })
}

/**
 * Flush one directory entry so the rename survives a crash.
 * @param dir - the directory that received the rename.
 */
function fsyncDirectory(dir: string) {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // Directory fsync is unavailable on some platforms; the rename still stands.
  }
}
