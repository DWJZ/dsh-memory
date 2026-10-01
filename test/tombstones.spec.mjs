/**
 * Tombstone suite.
 *
 * A tombstone is the only trace a deleted Memory leaves, so it must record that
 * the deletion happened and nothing about what was deleted.
 *
 * Usage: `node test/tombstones.spec.mjs`.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const actions = await import(pathToFileURL(join(PLUGIN, 'src/actions.js')).href)
const { projectLayout, userLayout, tombstoneLayout } = await import(pathToFileURL(join(PLUGIN, 'src/paths.js')).href)
const { newProjectId } = await import(pathToFileURL(join(PLUGIN, 'src/schema.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const AT = '2026-09-26T00:00:00.000Z'
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-reflection-tombstone-'))
const MEMORY = join(ROOT, 'memory')
mkdirSync(MEMORY, { recursive: true })
const PROJECT = newProjectId()
const TOMBSTONES = tombstoneLayout(MEMORY)
const OPTIONS = {
  scopes: { user: userLayout(MEMORY), project: id => projectLayout(MEMORY, id) },
  tombstones: TOMBSTONES,
  lockTimeoutMs: 3000,
  staleLockMs: 60000,
  maxEvidencePerMemory: 3,
}

/** One provenance entry. */
const evidence = (overrides = {}) => ({
  session_id: 'session-1',
  event_seqs: [1],
  kind: 'user',
  quote: '记住这个',
  observed_at: AT,
  ...overrides,
})

/** Every tombstone written so far. */
const lines = () => readFileSync(TOMBSTONES.path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

/** Keys no tombstone may carry. */
const FORBIDDEN = ['content', 'evidence', 'quote']

console.log('tombstone_forget_body_free')
const added = await actions.addMemory(OPTIONS, {
  content: '该项目使用 pnpm',
  scope: 'project',
  category: 'state',
  projectId: PROJECT,
  evidence: evidence({ quote: '记住，这个项目使用 pnpm' }),
})
await actions.forgetMemory(OPTIONS, { id: added.id, projectId: PROJECT })
const forgetEntries = lines()
check('one tombstone is appended', forgetEntries.length === 1)
const forgotten = forgetEntries[0]
check('the operation is recorded', forgotten.op === 'forget')
check('the id is recorded', forgotten.id === added.id)
check('the scope is recorded', forgotten.scope === 'project')
check('the project is recorded', forgotten.project_id === PROJECT)
check('the time is recorded', typeof forgotten.deleted_at === 'string' && forgotten.deleted_at.endsWith('Z'))
check('no body survives', FORBIDDEN.every(key => !(key in forgotten)))
check('the tombstone does not quote the record', !JSON.stringify(forgotten).includes('pnpm'))

console.log('tombstone_clear_summary_only')
await actions.addMemory(OPTIONS, { content: 'one', scope: 'project', category: 'state', projectId: PROJECT })
await actions.addMemory(OPTIONS, { content: 'two', scope: 'project', category: 'state', projectId: PROJECT })
const cleared = await actions.clearScope(OPTIONS, { scope: 'project', projectId: PROJECT })
const clearEntries = lines()
check('clearing adds exactly one line', clearEntries.length === 2)
const summary = clearEntries[1]
check('the summary records the operation', summary.op === 'clear')
check('the summary records the scope', summary.scope === 'project')
check('the summary records the project', summary.project_id === PROJECT)
check('the summary counts what was deleted', summary.count === cleared.count)
check('the summary records no per-record ids', !('id' in summary))
check('the summary carries no body', FORBIDDEN.every(key => !(key in summary)))

console.log('a user-scope clear records a null project')
await actions.addMemory(OPTIONS, { content: 'user fact', scope: 'user', category: 'preference' })
await actions.clearScope(OPTIONS, { scope: 'user' })
const userSummary = lines().at(-1)
check('the user clear is recorded', userSummary.op === 'clear' && userSummary.scope === 'user')
check('no project is claimed for user Memory', userSummary.project_id === null)

console.log('tombstone_concurrent_append_valid_jsonl')
const CONCURRENT = tombstoneLayout(join(ROOT, 'concurrent-memory'))
mkdirSync(CONCURRENT.path.replace('/tombstones.jsonl', ''), { recursive: true })
const WORKER = join(PLUGIN, 'test/fixtures/tombstone-worker.mjs')
const PER_WORKER = 20

/**
 * Run one tombstone writer process.
 * @param prefix - id prefix identifying this writer.
 * @returns fulfillment once the process exits successfully.
 */
function runWorker(prefix) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', WORKER, CONCURRENT.path, CONCURRENT.lockPath, prefix, String(PER_WORKER)], {
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', rejectRun)
    child.on('close', code => {
      if (code === 0) resolveRun()
      else rejectRun(new Error(`tombstone worker ${prefix} exited ${String(code)}: ${stderr}`))
    })
  })
}

let spawnFailure
try {
  await Promise.all(['a', 'b'].map(runWorker))
} catch (error) {
  spawnFailure = error
}
check('both writers exit successfully', spawnFailure === undefined, String(spawnFailure?.message ?? ''))
const raw = readFileSync(CONCURRENT.path, 'utf8')
const rawLines = raw.split('\n').filter(Boolean)
check('every line is one JSON object', rawLines.every(line => {
  try {
    return typeof JSON.parse(line) === 'object'
  } catch {
    return false
  }
}))
check('no line is interleaved with another', rawLines.length === PER_WORKER * 2)
const ids = new Set(rawLines.map(line => JSON.parse(line).id))
check('every appended entry survives', ids.size === PER_WORKER * 2)
check('the file ends with a newline', raw.endsWith('\n'))
check('the tombstone lock is released', !existsSync(CONCURRENT.lockPath))

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
