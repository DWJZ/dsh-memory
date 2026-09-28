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
 * @module dsh-memory/jsonstore
 */

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, rmSync, unlinkSync, writeSync,
} from 'node:fs'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { withLock } from './lock.js'

/** Format version this build writes; an unknown version is refused, never guessed. */
export const STORE_SCHEMA_VERSION = 1

/** Suffix every temporary file this plugin creates carries. */
export const TEMP_MARKER = '.dsh-memory-tmp-'

/**
 * Build an empty store.
 * @returns a store with no records and revision 0.
 */
export function emptyStore() {
  return { schema_version: STORE_SCHEMA_VERSION, revision: 0, records: [] }
}

/**
 * Read one canonical store.
 * @param storePath - absolute path of `memories.json`.
 * @returns the stored document, or an empty store when the file is absent.
 * @throws when the file is unreadable, malformed, or written by another format version.
 */
export function readStore(storePath) {
  if (!existsSync(storePath)) return emptyStore()
  const text = readFileSync(storePath, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`dsh-memory: ${storePath} is not valid JSON: ${String(error?.message ?? error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`dsh-memory: ${storePath} must hold a JSON object`)
  }
  if (parsed.schema_version !== STORE_SCHEMA_VERSION) {
    throw new Error(`dsh-memory: ${storePath} has schema_version ${JSON.stringify(parsed.schema_version)}, this build writes ${String(STORE_SCHEMA_VERSION)}`)
  }
  if (!Number.isInteger(parsed.revision) || parsed.revision < 0) {
    throw new Error(`dsh-memory: ${storePath} has an invalid revision ${JSON.stringify(parsed.revision)}`)
  }
  if (!Array.isArray(parsed.records)) {
    throw new Error(`dsh-memory: ${storePath} must hold a records array`)
  }
  return parsed
}

/**
 * Write text to a file atomically, removing the temporary file on any failure.
 * @param targetPath - the file to replace.
 * @param text - the complete new content.
 * @throws when the content cannot be committed.
 */
export function writeAtomic(targetPath, text) {
  const dir = dirname(targetPath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = join(dir, `${randomUUID()}${TEMP_MARKER}${basenameOf(targetPath)}`)
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
 * Remove this plugin's leftover temporary files from one directory.
 *
 * Only files carrying this plugin's own marker are removed, so an unrelated
 * `.tmp` file from another tool is never touched.
 * @param dir - the directory to sweep.
 * @returns the number of files removed.
 */
export function cleanupStaleTemps(dir) {
  if (!existsSync(dir)) return 0
  let removed = 0
  for (const entry of readdirSync(dir)) {
    if (!entry.includes(TEMP_MARKER)) continue
    try {
      rmSync(join(dir, entry), { force: true })
      removed += 1
    } catch {
      // A concurrent writer may own this file; it cleans up after itself.
    }
  }
  return removed
}

/**
 * Apply one mutation to the canonical store under the store lock.
 *
 * The operation receives the latest stored revision, so a target it judges
 * against cannot be replaced between the check and the write.
 * @param options - store location and lock thresholds.
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
export async function withStore(options, operation) {
  return withLock(options, () => {
    const store = readStore(options.storePath)
    const outcome = operation(store)
    if (outcome?.changed !== true) return { result: outcome?.result, revision: store.revision, store }
    const next = {
      schema_version: STORE_SCHEMA_VERSION,
      revision: store.revision + 1,
      records: outcome.records,
    }
    writeAtomic(options.storePath, `${JSON.stringify(next, null, 2)}\n`)
    return { result: outcome.result, revision: next.revision, store: next }
  })
}

/**
 * Remove one store's directory, used by tests and by an explicit scope reset.
 * @param dir - the directory to remove.
 * @returns fulfillment once the directory is gone.
 */
export async function removeStoreDir(dir) {
  await rm(dir, { recursive: true, force: true })
}

/**
 * Final path segment of one path.
 * @param path - the path to split.
 * @returns its last segment.
 */
function basenameOf(path) {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(index + 1)
}

/**
 * Flush one directory entry so the rename survives a crash.
 * @param dir - the directory that received the rename.
 */
function fsyncDirectory(dir) {
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
