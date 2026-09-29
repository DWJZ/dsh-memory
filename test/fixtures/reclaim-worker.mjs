/**
 * One contender for a contested stale lock.
 *
 * Running several of these is the only way to show that a stale lock is taken
 * exactly once: a single-process simulation cannot observe one reclaimer
 * deleting the lock another has just created.
 *
 * Reported per contender:
 * - `reclaimed` — `reclaimIfStale` said to retry acquisition. More than one
 *   contender may report this: the first removes the stale lock, and the next
 *   then observes no lock at all, which is equally a reason to retry.
 * - `owned` — this contender won the atomic `open(..., 'wx')` and therefore holds
 *   the lock. At most one contender can ever report this, and that is the
 *   exclusion the store depends on.
 *
 * Usage: `node test/fixtures/reclaim-worker.mjs <lockPath> <staleLockMs> <startDelayMs>`.
 */
import { openSync, closeSync, writeSync, fsyncSync } from 'node:fs'
import { hostname } from 'node:os'
import { randomUUID } from 'node:crypto'
import { reclaimIfStale } from '../../src/lock.js'

const [lockPath, rawStale, rawDelay] = process.argv.slice(2)

/** An error shaped like `process.kill`'s ESRCH, so the recorded holder reads as gone. */
const deadProcess = () => {
  const error = new Error('ESRCH')
  error.code = 'ESRCH'
  throw error
}

/** Take the lock the way `acquire()` does: one atomic create, no waiting. */
const tryTake = (nonce) => {
  try {
    const fd = openSync(lockPath, 'wx', 0o600)
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), nonce }))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    return true
  } catch {
    return false
  }
}

// Every contender waits the same time, so they observe the stale lock together.
await new Promise(resolve => { setTimeout(resolve, Number(rawDelay)) })
const nonce = randomUUID()
const reclaimed = reclaimIfStale(lockPath, {
  staleLockMs: Number(rawStale),
  lockTimeoutMs: 10_000,
  host: hostname(),
  kill: deadProcess,
  now: Date.now,
})
const owned = tryTake(nonce)
process.stdout.write(`${JSON.stringify({ reclaimed, owned, nonce })}\n`)
