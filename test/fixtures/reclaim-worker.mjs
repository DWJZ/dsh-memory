/**
 * One contender for reclaiming the same stale lock.
 *
 * Two of these racing is the only way to show that reclaim is serialized: a
 * single-process simulation cannot observe one reclaimer deleting the lock the
 * other has just created.
 *
 * Usage: `node test/fixtures/reclaim-worker.mjs <lockPath> <staleLockMs> <startDelayMs>`.
 */
import { hostname } from 'node:os'
import { reclaimIfStale } from '../../src/lock.js'

const [lockPath, rawStale, rawDelay] = process.argv.slice(2)

/** An error shaped like `process.kill`'s ESRCH, so the recorded holder reads as gone. */
const deadProcess = () => {
  const error = new Error('ESRCH')
  error.code = 'ESRCH'
  throw error
}

// Both contenders wait the same time, so they observe the stale lock together.
await new Promise(resolve => { setTimeout(resolve, Number(rawDelay)) })
const reclaimed = reclaimIfStale(lockPath, {
  staleLockMs: Number(rawStale),
  lockTimeoutMs: 10_000,
  host: hostname(),
  kill: deadProcess,
  now: Date.now,
})
process.stdout.write(`${JSON.stringify({ reclaimed })}\n`)
