/**
 * Canonical store suite: revision accounting, format refusal, atomic writes, and
 * the lock guarantees a failing write must still honour.
 *
 * Usage: `node test/jsonstore.spec.mjs`.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const store = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-memory-store-'))
const STORE = join(ROOT, 'memories.json')
const LOCK = join(ROOT, 'memories.json.lock')
const OPTIONS = { storePath: STORE, lockPath: LOCK, lockTimeoutMs: 2000, staleLockMs: 60000 }

/** Temporary files this plugin left behind. */
const temps = () => readdirSync(ROOT).filter(entry => entry.includes(store.TEMP_MARKER))

/** Append one placeholder record through the store lock. */
const append = record => store.withStore(OPTIONS, current => ({
  changed: true,
  records: [...current.records, record],
  result: record,
}))

console.log('reading')
check('a missing store reads as empty',
  JSON.stringify(store.readStore(STORE)) === JSON.stringify(store.emptyStore()))
writeFileSync(STORE, JSON.stringify({ schema_version: 99, revision: 1, records: [] }))
let versionError
try {
  store.readStore(STORE)
} catch (error) {
  versionError = error
}
check('an unknown schema_version is refused', versionError !== undefined)
check('the refusal names schema_version', String(versionError?.message).includes('schema_version'))
check('the refusal quotes both versions',
  String(versionError?.message).includes('99') && String(versionError?.message).includes('1'))

writeFileSync(STORE, '{ not json')
check('malformed JSON is refused', throws(() => store.readStore(STORE)))
writeFileSync(STORE, JSON.stringify({ schema_version: 1, revision: 1, records: {} }))
check('a non-array records field is refused', throws(() => store.readStore(STORE)))
writeFileSync(STORE, JSON.stringify({ schema_version: 1, revision: -1, records: [] }))
check('a negative revision is refused', throws(() => store.readStore(STORE)))
writeFileSync(STORE, '[]')
check('a JSON array is refused', throws(() => store.readStore(STORE)))
rmSync(STORE, { force: true })

console.log('revision_increment')
const first = await append({ id: 'mem_a' })
check('the first write advances revision to 1', first.revision === 1)
const second = await append({ id: 'mem_b' })
check('the second write advances revision to 2', second.revision === 2)
check('both records survive', store.readStore(STORE).records.length === 2)
check('the mutation result is returned', second.result.id === 'mem_b')
check('nothing temporary is left behind', temps().length === 0)
check('the store file ends with one newline', readFileSync(STORE, 'utf8').endsWith('}\n'))

const untouched = await store.withStore(OPTIONS, current => ({ changed: false, result: current.records.length }))
check('an unchanged operation reports the current revision', untouched.revision === 2)
check('an unchanged operation reports the current records', untouched.result === 2)
check('an unchanged operation writes nothing', store.readStore(STORE).revision === 2)

console.log('atomic writes')
const other = join(ROOT, 'atomic.json')
store.writeAtomic(other, 'first\n')
check('a written file carries the new content', readFileSync(other, 'utf8') === 'first\n')
check('writing leaves no temporary file', temps().length === 0)
store.writeAtomic(other, 'second\n')
check('a rewrite replaces the whole content', readFileSync(other, 'utf8') === 'second\n')
store.writeAtomic(other, 'a'.repeat(200000))
check('a large write is complete', readFileSync(other, 'utf8').length === 200000)
check('a large write leaves no temporary file', temps().length === 0)

console.log('temp_removed_after_write_failure')
const blocked = join(ROOT, 'blocked.json')
mkdirSync(blocked)
check('a write onto a directory fails', throws(() => store.writeAtomic(blocked, 'x')))
check('the failed write leaves no temporary file', temps().length === 0)

console.log('cleanupStaleTemps')
writeFileSync(join(ROOT, `stale${store.TEMP_MARKER}memories.json`), 'leftover')
writeFileSync(join(ROOT, 'unrelated.tmp'), 'not ours')
const removed = store.cleanupStaleTemps(ROOT)
check('the plugin removes its own leftover temporary file', removed === 1)
check('the leftover is gone', !existsSync(join(ROOT, `stale${store.TEMP_MARKER}memories.json`)))
check('an unrelated .tmp file is left alone', existsSync(join(ROOT, 'unrelated.tmp')))
check('a missing directory sweeps cleanly', store.cleanupStaleTemps(join(ROOT, 'absent')) === 0)

console.log('lock_released_on_validation_error')
let validationError
try {
  await store.withStore(OPTIONS, () => { throw new TypeError('target is no longer active') })
} catch (error) {
  validationError = error
}
check('the validation failure propagates', validationError instanceof TypeError)
check('the lock is released after a validation failure', !existsSync(LOCK))

console.log('lock_released_on_write_error')
let writeError
try {
  await store.withStore({ ...OPTIONS, storePath: blocked }, current => ({
    changed: true,
    records: current.records,
  }))
} catch (error) {
  writeError = error
}
check('the write failure propagates', writeError !== undefined)
check('the lock is released after a write failure', !existsSync(LOCK))
check('a failed write leaves no temporary file', temps().length === 0)

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Whether running this thunk throws.
 * @param thunk - the call to attempt.
 * @returns true when it threw.
 */
function throws(thunk) {
  try {
    thunk()
    return false
  } catch {
    return true
  }
}
