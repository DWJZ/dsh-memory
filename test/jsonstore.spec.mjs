/**
 * Canonical store suite: revision accounting, format refusal, atomic writes, and
 * the lock guarantees a failing write must still honour.
 *
 * Usage: `node test/jsonstore.spec.mjs`.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const store = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.js')).href)
const { memoryRecord, memoryId, AT } = await import('./fixtures/records.mjs')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-reflection-store-'))
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
const firstRecord = memoryRecord()
const secondRecord = memoryRecord()
const first = await append(firstRecord)
check('the first write advances revision to 1', first.revision === 1)
const second = await append(secondRecord)
check('the second write advances revision to 2', second.revision === 2)
check('both records survive', store.readStore(STORE).records.length === 2)
check('the mutation result is returned', second.result.id === secondRecord.id)
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
const abandoned = join(ROOT, `stale${store.TEMP_MARKER}memories.json`)
const recent = join(ROOT, `recent${store.TEMP_MARKER}memories.json`)
writeFileSync(abandoned, 'leftover')
writeFileSync(recent, 'in flight')
writeFileSync(join(ROOT, 'unrelated.tmp'), 'not ours')
const backdate = (path, ageMs) => {
  const seconds = (Date.now() - ageMs) / 1000
  utimesSync(path, seconds, seconds)
}
backdate(abandoned, 60_000)
backdate(recent, 10)
const removed = store.cleanupStaleTemps(ROOT, { staleTempMs: 30_000 })
check('the plugin removes its own abandoned temporary file', removed === 1)
check('the abandoned file is gone', !existsSync(abandoned))
check('a recent temporary file is left for its writer', existsSync(recent))
check('an unrelated .tmp file is left alone', existsSync(join(ROOT, 'unrelated.tmp')))
const nested = join(ROOT, 'projects', 'proj_x')
mkdirSync(nested, { recursive: true })
const nestedTemp = join(nested, `old${store.TEMP_MARKER}memories.json`)
writeFileSync(nestedTemp, 'leftover')
backdate(nestedTemp, 60_000)
check('a nested scope is swept too', store.cleanupStaleTemps(ROOT, { staleTempMs: 30_000 }) === 1)
check('the nested file is gone', !existsSync(nestedTemp))
rmSync(recent, { force: true })
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

console.log('a store that violates its own schema is refused')
const writeRaw = records => {
  writeFileSync(STORE, `${JSON.stringify({ schema_version: 1, revision: 1, records }, null, 2)}\n`)
}
writeRaw([{ id: 'mem_not-a-uuid' }])
check('a hand-written id is refused', throws(() => store.readStore(STORE)))

const dangling = memoryRecord({ status: 'superseded', superseded_by: memoryId() })
writeRaw([dangling])
check('a supersession that points nowhere is refused', throws(() => store.readStore(STORE)))
let danglingError
try {
  store.readStore(STORE)
} catch (error) {
  danglingError = error
}
check('the refusal names the dangling target',
  String(danglingError?.message).includes(dangling.superseded_by))

const repeated = memoryRecord()
writeRaw([repeated, repeated])
check('a duplicated id is refused', throws(() => store.readStore(STORE)))

const sound = memoryRecord()
const successor = memoryRecord({ status: 'superseded', superseded_by: sound.id })
writeRaw([sound, successor])
check('a sound supersession is accepted', store.readStore(STORE).records.length === 2)
check('a mutation that would dangle is refused before the write',
  await rejectsWrite(() => store.withStore(OPTIONS, current => ({
    changed: true,
    records: [...current.records, memoryRecord({ status: 'superseded', superseded_by: memoryId() })],
  }))))
check('the store on disk is unchanged after the refusal', store.readStore(STORE).records.length === 2)
check('the lock is released after a validation refusal', !existsSync(LOCK))

console.log('the evidence cap bounds writers, not a valid record')
// A deployment that lowers `maxEvidencePerMemory` must still read what an
// earlier, more generous deployment wrote: the cap decides what a writer may
// append, not what a store may hold.
const wellDocumented = memoryRecord({
  evidence: Array.from({ length: 20 }, (_, index) => ({
    kind: 'user',
    session_id: 'session-long',
    quote: '',
    event_seqs: [index],
    observed_at: AT,
  })),
})
writeRaw([wellDocumented])
check('a record with more evidence than the default cap still loads',
  store.readStore(STORE).records.length === 1)
check('its evidence is preserved rather than trimmed on read',
  store.readStore(STORE).records[0].evidence.length === 20)
check('a write that keeps it is accepted',
  !await rejectsWrite(() => store.withStore(OPTIONS, current => ({
    changed: true,
    records: current.records,
  }))))
// The case the cap actually broke: one record written when the cap was large
// must not make an unrelated later addition fail.
const unrelated = memoryRecord()
check('adding an unrelated record is accepted',
  !await rejectsWrite(() => store.withStore(OPTIONS, current => ({
    changed: true,
    records: [...current.records, unrelated],
  }))))
check('both records are on disk', store.readStore(STORE).records.length === 2)

console.log('noop_mutation_still_validates_existing_store')
// A mutation that changes nothing still reads the store, so a corrupt one must
// fail there rather than pass as "nothing to do".
writeRaw([memoryRecord({ status: 'superseded', superseded_by: memoryId() })])
let noopError
try {
  await store.withStore(OPTIONS, current => ({ changed: false, result: current.records.length }))
} catch (error) {
  noopError = error
}
check('a noop mutation refuses a store that violates its schema', noopError !== undefined)
check('the refusal names the dangling target', String(noopError?.message).includes('does not hold'))
check('the lock is released after the noop refusal', !existsSync(LOCK))

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

/**
 * Whether running this mutation rejects.
 * @param thunk - the call to attempt.
 * @returns true when it rejected.
 */
async function rejectsWrite(thunk) {
  try {
    await thunk()
    return false
  } catch {
    return true
  }
}
