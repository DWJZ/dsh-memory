/**
 * Consolidation state suite: the high-water mark, gap recording, and the
 * guarantee that progress only ever moves forward.
 *
 * Usage: `node test/consolidation-state.spec.mjs`.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const state = await import(pathToFileURL(join(PLUGIN, 'src/consolidation/state.js')).href)
const { consolidationLayout } = await import(pathToFileURL(join(PLUGIN, 'src/paths.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}
const rejects = async (thunk, fragment) => {
  try {
    await thunk()
    return false
  } catch (error) {
    return fragment === undefined || String(error.message).includes(fragment)
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-memory-consolidation-state-'))
const MEMORY = join(ROOT, 'memory')
const LAYOUT = consolidationLayout(MEMORY)
const OPTIONS = {
  statePath: LAYOUT.statePath,
  lockPath: LAYOUT.lockPath,
  lockTimeoutMs: 3000,
  staleLockMs: 60000,
}
const AT = '2026-09-29T00:00:00.000Z'
const LATER = '2026-09-29T01:00:00.000Z'

console.log('layout')
check('the state file lives beside the Memory it tracks',
  LAYOUT.statePath === join(MEMORY, 'consolidation-state.json'))
check('the lock sits next to the state file',
  LAYOUT.lockPath === `${LAYOUT.statePath}.lock`)

console.log('a missing state file is a first run')
check('reading an absent file yields empty state', state.readState(LAYOUT.statePath).sessions !== undefined)
check('an absent file records no progress', state.lastProcessedSeq(state.emptyState(), 'session_a') === state.NO_PROGRESS)
check('nothing was created by reading it', !existsSync(LAYOUT.statePath))

console.log('the mark starts below the first real event')
// seq 0 is a real event, so "never consumed" must not look like "consumed 0".
check('an unobserved Session sits at -1', state.NO_PROGRESS === -1)

console.log('advance')
const first = state.advanceHwm(state.emptyState(), 'session_a', 182, AT)
check('the first advance is recorded', state.lastProcessedSeq(first, 'session_a') === 182)
check('the timestamp is recorded', first.sessions.session_a.updated_at === AT)
check('another Session is untouched', state.lastProcessedSeq(first, 'session_b') === state.NO_PROGRESS)
const second = state.advanceHwm(first, 'session_a', 241, LATER)
check('a later advance moves the mark', state.lastProcessedSeq(second, 'session_a') === 241)
check('the new timestamp replaces the old', second.sessions.session_a.updated_at === LATER)
const stale = state.advanceHwm(second, 'session_a', 200, LATER)
check('a batch finishing late cannot pull the mark back', stale === second)
check('the mark is still the higher one', state.lastProcessedSeq(stale, 'session_a') === 241)

console.log('gap')
const gapped = state.recordGap(state.emptyState(), 'session_c', { from_seq: 183, to_seq: 500 }, AT)
check('a gap moves the mark past the unobserved range',
  state.lastProcessedSeq(gapped, 'session_c') === 500)
check('the gap is written down', gapped.sessions.session_c.gaps.length === 1)
check('the gap records both ends', gapped.sessions.session_c.gaps[0].from_seq === 183
  && gapped.sessions.session_c.gaps[0].to_seq === 500)
check('the gap records when it was noticed', gapped.sessions.session_c.gaps[0].at === AT)
const gappedTwice = state.recordGap(gapped, 'session_c', { from_seq: 700, to_seq: 740 }, LATER)
check('a second gap is kept alongside the first', gappedTwice.sessions.session_c.gaps.length === 2)
check('the mark follows the later gap', state.lastProcessedSeq(gappedTwice, 'session_c') === 740)
const gapBackwards = state.recordGap(gappedTwice, 'session_c', { from_seq: 600, to_seq: 650 }, LATER)
check('a gap below the current mark does not pull it back',
  state.lastProcessedSeq(gapBackwards, 'session_c') === 740)
const advancedAfterGap = state.advanceHwm(gappedTwice, 'session_c', 800, LATER)
check('advancing keeps the recorded gaps', advancedAfterGap.sessions.session_c.gaps.length === 2)

console.log('validation')
check('a wrong schema_version is refused',
  await rejects(() => Promise.resolve(state.validateState({ schema_version: 99, sessions: {} })), 'schema_version'))
check('a missing sessions object is refused',
  await rejects(() => Promise.resolve(state.validateState({ schema_version: 1 })), 'sessions'))
check('a non-integer mark is refused',
  await rejects(() => Promise.resolve(state.validateState({
    schema_version: 1, sessions: { s: { last_processed_seq: 1.5, gaps: [], updated_at: AT } },
  })), 'last_processed_seq'))
check('a mark below -1 is refused',
  await rejects(() => Promise.resolve(state.validateState({
    schema_version: 1, sessions: { s: { last_processed_seq: -2, gaps: [], updated_at: AT } },
  })), 'last_processed_seq'))
check('a missing gaps array is refused',
  await rejects(() => Promise.resolve(state.validateState({
    schema_version: 1, sessions: { s: { last_processed_seq: 1, updated_at: AT } },
  })), 'gaps'))
check('an inverted gap is refused',
  await rejects(() => Promise.resolve(state.validateState({
    schema_version: 1, sessions: { s: { last_processed_seq: 1, gaps: [{ from_seq: 9, to_seq: 2, at: AT }], updated_at: AT } },
  })), 'invalid gap'))
check('a gap without a timestamp is refused',
  await rejects(() => Promise.resolve(state.validateState({
    schema_version: 1, sessions: { s: { last_processed_seq: 1, gaps: [{ from_seq: 1, to_seq: 2 }], updated_at: AT } },
  })), 'timestamp'))

console.log('persistence')
const written = await state.withState(OPTIONS, current => ({
  changed: true,
  state: state.advanceHwm(current, 'session_a', 182, AT),
}))
check('the mutation reports the state now on disk',
  state.lastProcessedSeq(written.state, 'session_a') === 182)
check('the file exists', existsSync(LAYOUT.statePath))
check('the file is a state document',
  JSON.parse(readFileSync(LAYOUT.statePath, 'utf8')).schema_version === 1)
check('the file ends with a newline', readFileSync(LAYOUT.statePath, 'utf8').endsWith('\n'))
check('re-reading sees the written mark', state.lastProcessedSeq(state.readState(LAYOUT.statePath), 'session_a') === 182)
check('the lock is released after the write', !existsSync(LAYOUT.lockPath))

const noop = await state.withState(OPTIONS, () => ({ changed: false, result: 'unchanged' }))
check('a no-op reports the operation result', noop.result === 'unchanged')
check('a no-op leaves the file untouched',
  state.lastProcessedSeq(state.readState(LAYOUT.statePath), 'session_a') === 182)

await state.withState(OPTIONS, current => ({
  changed: true,
  state: state.advanceHwm(current, 'session_b', 77, LATER),
}))
const both = state.readState(LAYOUT.statePath)
check('a second Session is added without losing the first',
  state.lastProcessedSeq(both, 'session_a') === 182 && state.lastProcessedSeq(both, 'session_b') === 77)

console.log('a corrupt state file is refused rather than reset')
writeFileSync(LAYOUT.statePath, '{ not json')
check('corrupt JSON is refused', await rejects(() => Promise.resolve(state.readState(LAYOUT.statePath)), 'not valid JSON'))
writeFileSync(LAYOUT.statePath, JSON.stringify({ schema_version: 1, sessions: { s: { last_processed_seq: 'many', gaps: [], updated_at: AT } } }))
check('a schema violation is refused', await rejects(() => Promise.resolve(state.readState(LAYOUT.statePath)), 'last_processed_seq'))
let refusedWrite = false
try {
  await state.withState(OPTIONS, current => ({ changed: true, state: current }))
} catch {
  refusedWrite = true
}
check('a mutation refuses to build on a corrupt file', refusedWrite === true)
check('the corrupt file was not overwritten',
  readFileSync(LAYOUT.statePath, 'utf8').includes('"many"'))
check('the lock is released after the refusal', !existsSync(LAYOUT.lockPath))

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
