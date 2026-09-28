/**
 * Lock suite: process liveness, stale reclaim, and the guarantee that a failed
 * critical section never leaves a lock file behind.
 *
 * Usage: `node test/lock.spec.mjs`.
 */
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { isProcessAlive, reclaimIfStale, withLock } = await import(pathToFileURL(join(PLUGIN, 'src/lock.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-memory-lock-'))
const LOCK = join(ROOT, 'memories.json.lock')
const HOST = hostname()

/** An error carrying one errno code, as `process.kill` reports it. */
const errnoError = code => Object.assign(new Error(code), { code })

/** Write a lock file and backdate it. */
const writeLock = (path, record, ageMs) => {
  writeFileSync(path, typeof record === 'string' ? record : JSON.stringify(record))
  const seconds = (Date.now() - ageMs) / 1000
  utimesSync(path, seconds, seconds)
}

/** Decide reclaim for one file with fixed thresholds. */
const reclaim = (path, overrides = {}) => reclaimIfStale(path, {
  staleLockMs: 1000,
  host: HOST,
  kill: () => true,
  now: Date.now,
  ...overrides,
})

const warnings = []

console.log('pid_check_esrch_is_dead')
check('ESRCH reads as dead', isProcessAlive(4242, () => { throw errnoError('ESRCH') }) === false)
check('a successful signal reads as alive', isProcessAlive(4242, () => undefined) === true)

console.log('pid_check_eperm_is_alive')
check('EPERM reads as alive', isProcessAlive(4242, () => { throw errnoError('EPERM') }) === true)
check('an unknown failure reads as alive', isProcessAlive(4242, () => { throw errnoError('EINVAL') }) === true)
check('a non-integer pid reads as dead', isProcessAlive('4242') === false)
check('pid 0 reads as dead', isProcessAlive(0) === false)

console.log('stale reclaim')
writeLock(LOCK, { pid: 4242, host: HOST, at: new Date().toISOString(), nonce: 'n1' }, 5000)
check('a dead owner on this host is reclaimed',
  reclaim(LOCK, { kill: () => { throw errnoError('ESRCH') }, onWarn: m => warnings.push(m) }) === true)
check('the reclaimed lock file is gone', !existsSync(LOCK))
check('reclaiming warns instead of staying silent', warnings.length === 1)
check('the warning names the stale lock', String(warnings[0]).includes('stale lock'))

writeLock(LOCK, { pid: process.pid, host: HOST, at: new Date().toISOString(), nonce: 'n2' }, 5000)
check('a live owner on this host is not reclaimed',
  reclaim(LOCK, { kill: () => undefined }) === false)
check('the live lock file survives', existsSync(LOCK))

writeLock(LOCK, { pid: 4242, host: HOST, at: new Date().toISOString(), nonce: 'n3' }, 10)
check('a young lock is not reclaimed even when the owner is gone',
  reclaim(LOCK, { kill: () => { throw errnoError('ESRCH') } }) === false)
check('the young lock file survives', existsSync(LOCK))

writeLock(LOCK, { pid: 4242, host: 'another-machine', at: new Date().toISOString(), nonce: 'n4' }, 5000)
check('another host is never reclaimed, since its pid cannot be probed',
  reclaim(LOCK, { kill: () => { throw errnoError('ESRCH') } }) === false)
check('the foreign lock file survives', existsSync(LOCK))

writeLock(LOCK, '{ not json', 5000)
check('a malformed lock older than the threshold is reclaimed', reclaim(LOCK) === true)

writeLock(LOCK, { pid: 4242, host: HOST, at: new Date().toISOString(), nonce: 'n5' }, 1000)
check('a lock exactly at the threshold is not reclaimed',
  reclaim(LOCK, { kill: () => { throw errnoError('ESRCH') } }) === false)

rmSync(LOCK, { force: true })
check('a missing lock file is not reclaimed', reclaim(LOCK) === false)

console.log('withLock')
const options = { lockPath: LOCK, lockTimeoutMs: 2000, staleLockMs: 60000 }
check('an operation returns its value',
  await withLock(options, () => 7) === 7)
check('the lock file is released after success', !existsSync(LOCK))

let threw = false
try {
  await withLock(options, () => { throw new TypeError('validation failed') })
} catch (error) {
  threw = error instanceof TypeError
}
check('an operation failure propagates', threw)
check('the lock file is released after a failure', !existsSync(LOCK))

const order = []
await Promise.all([
  withLock(options, async () => { order.push('a-start'); await new Promise(r => setTimeout(r, 40)); order.push('a-end') }),
  withLock(options, async () => { order.push('b-start'); await new Promise(r => setTimeout(r, 5)); order.push('b-end') }),
])
check('two in-process callers never interleave',
  order.join(',') === 'a-start,a-end,b-start,b-end')

writeLock(LOCK, { pid: process.pid, host: HOST, at: new Date().toISOString(), nonce: 'held' }, 50)
let timedOut = false
try {
  await withLock({ ...options, lockTimeoutMs: 150 }, () => 'never')
} catch (error) {
  timedOut = String(error.message).includes('timed out')
}
check('a live holder is not stolen and the wait fails loud', timedOut)
check('the live holder keeps its lock file', existsSync(LOCK))
rmSync(LOCK, { force: true })

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
