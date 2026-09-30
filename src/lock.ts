/**
 * Cross-process write protection for one store.
 *
 * A temp file plus rename prevents a half-written store, but not two processes
 * reading the same revision and overwriting each other. This module serializes
 * writers twice: an in-process chain, so two fibers of one harness never
 * interleave, and an exclusive lock file, so a desktop session and a headless
 * run sharing `$DSH_HOME` never lose an update.
 *
 * A lock left behind by a crashed process must not wedge every later write, so a
 * lock older than `staleLockMs` is reclaimed — but only when the recorded process
 * is provably gone (`ESRCH`). `EPERM` means the process exists and merely refuses
 * the signal, so it keeps the lock.
 *
 * @module dsh-memory/lock
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { failureCode } from './errors.js'

/** How long one acquisition attempt waits before retrying. */
const RETRY_DELAY_MS = 25

/** In-process serialization chains, keyed by lock path. */
const inProcessTails = new Map()

/**
 * Whether the process holding a lock is still alive.
 *
 * Only `ESRCH` proves the process is gone. Any other failure - `EPERM` for a
 * process owned by another user, or an unexpected error - reads as alive, so an
 * uncertain answer never costs a live writer its lock.
 * @param pid - the process id recorded in the lock file.
 * @param kill - signal sender, injectable for tests.
 * @returns true when the process should be treated as alive.
 */
export function isProcessAlive(pid: number, kill = process.kill) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    return failureCode(error) !== 'ESRCH'
  }
}

/**
 * Decide whether one observed lock file may be reclaimed.
 * @param lockPath - the lock file path.
 * @param {object} options - thresholds and identity of the current writer.
 * @param options.staleLockMs - age at which a lock becomes reclaimable.
 * @param options.host - current host name.
 * @param options.kill - signal sender, injectable for tests.
 * @param options.now - clock, injectable for tests.
 * @param options.onWarn - receives a message when a lock is reclaimed.
 * @returns true when the caller should retry acquisition.
 */
export function reclaimIfStale(lockPath: string, options) {
  const observed = observeLock(lockPath, options)
  if (observed === undefined) return false
  if (observed.record !== undefined && observed.record.host !== options.host) {
    // Another machine's process cannot be probed, so the lock stands until the
    // waiter times out and reports it; a shared volume needs manual cleanup.
    return false
  }
  if (observed.record !== undefined && isProcessAlive(observed.record.pid, options.kill)) return false

  // Two processes can see the same stale lock. Without serializing the removal,
  // the slower one deletes the lock the faster one has just created, and both go
  // on to believe they hold it.
  const mutexPath = `${lockPath}.reclaim`
  if (!takeReclaimMutex(mutexPath)) return false
  try {
    // Re-observe under the mutex: the lock may be gone, refreshed, or replaced.
    const current = observeLock(lockPath, options)
    if (current === undefined) return true
    if (current.mtimeMs !== observed.mtimeMs || current.record?.nonce !== observed.record?.nonce) return false
    if (current.record !== undefined && isProcessAlive(current.record.pid, options.kill)) return false
    unlinkSync(lockPath)
    options.onWarn?.(`reclaimed stale lock ${lockPath} (age ${String(Math.round(current.ageMs))}ms, pid ${String(current.record?.pid ?? 'unknown')})`)
    return true
  } catch (error) {
    if (failureCode(error) === 'ENOENT') return true
    return false
  } finally {
    releaseReclaimMutex(mutexPath)
  }
}

/**
 * Read one lock file's identity and freshness.
 * @param lockPath - the lock file path.
 * @param options - staleness threshold and clock.
 * @returns the observation, or undefined when the lock is absent or still fresh.
 */
function observeLock(lockPath: string, options) {
  let stats
  try {
    stats = statSync(lockPath)
  } catch {
    return undefined
  }
  const ageMs = options.now() - stats.mtimeMs
  if (ageMs <= options.staleLockMs) return undefined
  let record
  try {
    record = JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    // A malformed lock older than the threshold has no owner to protect.
    record = undefined
  }
  return { ageMs, mtimeMs: stats.mtimeMs, record }
}

/**
 * Take the mutex that serializes stale-lock reclaim.
 *
 * The mutex is deliberately never reclaimed. Reclaiming it would repeat the very
 * race it exists to prevent one level down: two reapers could both judge it
 * stale, and the slower one would delete the mutex the faster one has just
 * created. A reaper holds it for microseconds, so the cost of refusing instead
 * is one retry round, and the cost of a crash inside that window is a mutex a
 * person removes — which the README states.
 * @param mutexPath - the mutex file path.
 * @returns true when this call now holds the mutex.
 */
function takeReclaimMutex(mutexPath: string) {
  try {
    closeSync(openSync(mutexPath, 'wx', 0o600))
    return true
  } catch {
    // Held by another reaper, or unwritable; either way this round does not
    // reclaim, and the caller returns to its ordinary acquire loop.
    return false
  }
}

/**
 * Release the reclaim mutex.
 * @param mutexPath - the mutex file path.
 */
function releaseReclaimMutex(mutexPath: string) {
  try {
    unlinkSync(mutexPath)
  } catch {
    // Another reaper's mutex, or already gone; either way nothing to release.
  }
}

/**
 * Run one operation while holding the store's exclusive lock.
 *
 * The lock is released in `finally`, so a validation failure, an unreadable
 * store, a failed write, or a throwing operation never leaves a lock file
 * behind.
 * @param {object} options - lock location, thresholds, and optional logger.
 * @param options.lockPath - absolute path of the lock file.
 * @param options.lockTimeoutMs - how long to keep trying before failing.
 * @param options.staleLockMs - age at which a lock becomes reclaimable.
 * @param options.host - current host name.
 * @param options.kill - signal sender, injectable for tests.
 * @param options.now - clock, injectable for tests.
 * @param options.logger - optional `{ warn }` sink for reclaim warnings.
 * @param run - the operation to run while holding the lock.
 * @returns whatever `run` returns.
 * @throws when the lock cannot be acquired within `lockTimeoutMs`.
 */
export async function withLock(options, run) {
  // An explicit `undefined` override must not erase a default: callers forward
  // optional seams by spreading an options bag that often lacks them.
  const resolved = {
    pid: process.pid,
    host: hostname(),
    now: Date.now,
    kill: process.kill,
    ...withoutUndefined(options),
  }
  const releaseChain = await enterProcessChain(resolved.lockPath)
  const nonce = randomUUID()
  let held = false
  try {
    // The lock is taken before anything is written, so a scope directory that
    // does not exist yet must be created here rather than by the first write.
    mkdirSync(dirname(resolved.lockPath), { recursive: true })
    held = await acquire(resolved, nonce)
    if (!held) {
      throw new Error(`dsh-memory: timed out after ${String(resolved.lockTimeoutMs)}ms waiting for ${resolved.lockPath}`)
    }
    return await run()
  } finally {
    if (held) releaseLockFile(resolved.lockPath, nonce)
    releaseChain()
  }
}

/**
 * Acquire the lock file, retrying until the deadline.
 * @param options - lock location, thresholds, and optional logger.
 * @param nonce - ownership token written into the lock file.
 * @returns true when this call now holds the lock.
 */
async function acquire(options, nonce: string) {
  const deadline = options.now() + options.lockTimeoutMs
  for (;;) {
    try {
      const fd = openSync(options.lockPath, 'wx', 0o600)
      try {
        writeSync(fd, JSON.stringify({
          pid: options.pid,
          host: options.host,
          at: new Date(options.now()).toISOString(),
          nonce,
        }))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      return true
    } catch (error) {
      if (failureCode(error) !== 'EEXIST') throw error
    }

    const reclaimed = reclaimIfStale(options.lockPath, {
      staleLockMs: options.staleLockMs,
      lockTimeoutMs: options.lockTimeoutMs,
      host: options.host,
      kill: options.kill,
      now: options.now,
      onWarn: message => options.logger?.warn(`dsh-memory: ${message}`),
    })
    if (reclaimed) continue
    if (options.now() >= deadline) return false
    await delay(RETRY_DELAY_MS)
  }
}

/**
 * Remove the lock file when this call still owns it.
 * @param lockPath - the lock file path.
 * @param nonce - ownership token written at acquisition.
 */
function releaseLockFile(lockPath: string, nonce: string) {
  try {
    const record = JSON.parse(readFileSync(lockPath, 'utf8'))
    // Another writer may have reclaimed this lock; deleting it would then
    // release a lock that is no longer ours.
    if (record?.nonce !== nonce) return
    unlinkSync(lockPath)
  } catch (error) {
    if (failureCode(error) !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
  }
}

/**
 * Join this process's chain for one lock path.
 * @param lockPath - the lock file path.
 * @returns a function that releases this call's place in the chain.
 */
async function enterProcessChain(lockPath: string) {
  const tail = inProcessTails.get(lockPath) ?? Promise.resolve()
  let finish
  const next = new Promise(resolve => { finish = resolve })
  inProcessTails.set(lockPath, next)
  await tail
  return () => {
    finish()
    // Only the last waiter removes the entry, so a later arrival still chains.
    if (inProcessTails.get(lockPath) === next) inProcessTails.delete(lockPath)
  }
}

/**
 * Whether a lock file currently exists.
 * @param lockPath - the lock file path.
 * @returns true when the lock file is present.
 */
export function lockExists(lockPath: string) {
  return existsSync(lockPath)
}

/**
 * Copy an options bag without its undefined members.
 * @param options - the raw options.
 * @returns the same options, minus undefined values.
 */
function withoutUndefined(options) {
  return Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined))
}

/**
 * Age of one lock file, or undefined when it is gone.
 * @param lockPath - the lock file path.
 * @param now - clock, injectable for tests.
 * @returns the age in milliseconds.
 */
function lockAgeMs(lockPath: string, now) {
  try {
    return now() - statSync(lockPath).mtimeMs
  } catch {
    return undefined
  }
}

/**
 * Wait one retry interval.
 * @param ms - milliseconds to wait.
 * @returns a promise resolved after the delay.
 */
function delay(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}
