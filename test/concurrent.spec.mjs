/**
 * Concurrent write suite.
 *
 * `tmp` plus rename prevents a half-written store but not two processes reading
 * the same revision and overwriting each other, so this suite runs real second
 * and third processes against one store and demands that every mutation survives.
 *
 * Usage: `node test/concurrent.spec.mjs`.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { readStore, TEMP_MARKER } = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-reflection-concurrent-'))
const STORE = join(ROOT, 'memories.json')
const LOCK = join(ROOT, 'memories.json.lock')
const WORKER = join(PLUGIN, 'test/fixtures/mutate-worker.mjs')
const PER_WORKER = 12

/**
 * Run one writer process to completion.
 * @param prefix - record id prefix identifying this writer.
 * @returns fulfillment once the process exits successfully.
 */
function runWorker(prefix) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', WORKER, STORE, LOCK, prefix, String(PER_WORKER), '1'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', rejectRun)
    child.on('close', code => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`worker ${prefix} exited ${String(code)}: ${stderr}`))
    })
  })
}

const PREFIXES = ['a', 'b', 'c']
let spawnFailure
try {
  await Promise.all(PREFIXES.map(runWorker))
} catch (error) {
  spawnFailure = error
}
check('every writer process exits successfully', spawnFailure === undefined, String(spawnFailure?.message ?? ''))

const store = readStore(STORE)
const expected = PREFIXES.length * PER_WORKER
check('the revision counts every mutation', store.revision === expected)
check('no record is lost', store.records.length === expected)
check('the revision and the record count agree', store.revision === store.records.length)
for (const prefix of PREFIXES) {
  const present = store.records.filter(record => record.content.startsWith(`${prefix}-`)).length
  check(`every ${prefix} record survives`, present === PER_WORKER)
}
const ids = new Set(store.records.map(record => record.id))
check('every record id is distinct', ids.size === expected)
check('no temporary file is left behind',
  !readdirSync(ROOT).some(entry => entry.includes(TEMP_MARKER)))
check('the lock is released after the last writer', !existsSync(LOCK))

// Negative control: without the lock the same two writers lose an update, so the
// assertions above are observing the lock rather than passing for free.
const UNSAFE_ROOT = mkdtempSync(join(tmpdir(), 'dsh-reflection-concurrent-unsafe-'))
const UNSAFE_STORE = join(UNSAFE_ROOT, 'memories.json')
const UNSAFE_WORKER = join(PLUGIN, 'test/fixtures/mutate-worker-unsafe.mjs')

/**
 * Run one lock-free writer that holds the state it read.
 * @param prefix - record id prefix identifying this writer.
 * @returns fulfillment once the process exits successfully.
 */
function runUnsafeWorker(prefix) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', UNSAFE_WORKER, UNSAFE_STORE, prefix, '60'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', rejectRun)
    child.on('close', code => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`unsafe worker ${prefix} exited ${String(code)}: ${stderr}`))
    })
  })
}

let unsafeFailure
try {
  await Promise.all(['x', 'y'].map(runUnsafeWorker))
} catch (error) {
  unsafeFailure = error
}
const unsafeStore = unsafeFailure === undefined ? readStore(UNSAFE_STORE) : undefined
check('the lock-free control writers run', unsafeFailure === undefined, String(unsafeFailure?.message ?? ''))
check('without the lock one update is lost', unsafeStore?.revision === 1, `revision ${String(unsafeStore?.revision)}`)
check('without the lock one record is lost', unsafeStore?.records.length === 1, `${String(unsafeStore?.records.length)} records`)

rmSync(UNSAFE_ROOT, { recursive: true, force: true })
rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
