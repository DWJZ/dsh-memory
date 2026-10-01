/**
 * Derived view suite.
 *
 * Two contract rules are load-bearing here: the view shows only active Memory,
 * and a view that cannot be written never turns a committed mutation into a
 * failure.
 *
 * Usage: `node test/views.spec.mjs`.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { renderMemoryView, rebuildView, mutateAndRefreshView } = await import(pathToFileURL(join(PLUGIN, 'src/views.js')).href)
const { scopeLayout } = await import(pathToFileURL(join(PLUGIN, 'src/paths.js')).href)
const { readStore, withStore, TEMP_MARKER } = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.js')).href)
const { compareRecords } = await import(pathToFileURL(join(PLUGIN, 'src/retention.js')).href)
const { newMemoryId } = await import(pathToFileURL(join(PLUGIN, 'src/schema.js')).href)
const memoryId = newMemoryId

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-reflection-view-'))
const layout = scopeLayout(join(ROOT, 'user'))
const OPTIONS = { ...layout, lockTimeoutMs: 2000, staleLockMs: 60000 }

/** One record shaped well enough for rendering, with a valid identity. */
const record = (overrides = {}) => ({
  id: memoryId(),
  scope: 'user',
  project_id: null,
  category: 'state',
  content: 'a fact',
  confidence: 1,
  evidence: [],
  created_at: '2026-09-26T00:00:00.000Z',
  updated_at: '2026-09-26T00:00:00.000Z',
  status: 'active',
  superseded_by: null,
  ...overrides,
})

console.log('MEMORY.md shows active Memory only')
const mixed = [
  record({ id: 'mem_active', content: 'current fact', category: 'state' }),
  record({ id: 'mem_old', content: 'stale fact', category: 'state', status: 'superseded', superseded_by: 'mem_active' }),
  record({ id: 'mem_arch', content: 'archived fact', category: 'state', status: 'archived' }),
]
const mixedView = renderMemoryView(mixed, { revision: 3 })
check('the active record appears', mixedView.includes('current fact'))
check('a superseded record is absent', !mixedView.includes('stale fact'))
check('an archived record is absent', !mixedView.includes('archived fact'))
check('the revision is recorded', mixedView.includes('dsh-reflection: revision 3'))
check('the file is generated, and says so', mixedView.includes('will be overwritten'))

console.log('ordering matches the shared comparator')
const ordered = renderMemoryView([
  record({ id: 'mem_ref', category: 'reference', content: 'reference fact' }),
  record({ id: 'mem_pref', category: 'preference', content: 'preference fact' }),
  record({ id: 'mem_new', category: 'preference', content: 'newer preference', updated_at: '2026-09-27T00:00:00.000Z' }),
  record({ id: 'mem_old2', category: 'preference', content: 'older preference' }),
], { revision: 1 })
const positions = ['preference fact', 'newer preference', 'older preference', 'reference fact']
  .map(text => ordered.indexOf(text))
check('a higher-priority category sorts first', ordered.indexOf('preference fact') < ordered.indexOf('reference fact'))
check('a newer record sorts before an older one in the same category',
  ordered.indexOf('newer preference') < ordered.indexOf('older preference'))
check('every active record is listed', positions.every(position => position > 0))
check('compareRecords agrees with the render order',
  compareRecords(record({ category: 'preference' }), record({ category: 'reference' })) < 0)

console.log('an empty scope still renders a readable file')
const emptyView = renderMemoryView([], { revision: 0 })
check('the empty view says so', emptyView.includes('No active Memory.'))
check('the empty view records revision 0', emptyView.includes('dsh-reflection: revision 0'))

console.log('rebuildView writes what is on disk')
await withStore(OPTIONS, current => ({
  changed: true,
  records: [...current.records, record({ content: 'first fact' })],
}))
const rebuilt = await rebuildView(OPTIONS)
check('the rebuild reports the committed revision', rebuilt.revision === 1)
check('the view file exists', existsSync(layout.viewPath))
check('the view holds the committed record', readFileSync(layout.viewPath, 'utf8').includes('first fact'))
check('no temporary file is left behind',
  !readdirSync(layout.dir).some(entry => entry.includes(TEMP_MARKER)))

console.log('view_rebuild_reads_latest_revision')
await withStore(OPTIONS, current => ({
  changed: true,
  records: [...current.records, record({ content: 'second fact' })],
}))
await rebuildView(OPTIONS)
const latest = readFileSync(layout.viewPath, 'utf8')
check('the view reflects the newest revision', latest.includes('dsh-reflection: revision 2'))
check('the view holds the newest record', latest.includes('second fact'))
check('the view still holds the earlier record', latest.includes('first fact'))

console.log('view_failure_does_not_fail_commit')
const warnings = []
rmSync(layout.viewPath, { force: true })
mkdirSync(layout.viewPath)
const thirdRecord = record({ content: 'third fact' })
const blocked = await mutateAndRefreshView(
  { ...OPTIONS, logger: { warn: message => warnings.push(message) } },
  current => ({ changed: true, records: [...current.records, thirdRecord], result: 'ok' }),
)
check('the mutation still reports success', blocked.result === 'ok')
check('the canonical revision advanced', blocked.revision === 3)
check('the mutation is marked view-stale', blocked.viewStale === true)
check('a warning names the stale view', String(warnings[0]).includes('memory-view-stale'))
check('the record reached the canonical store',
  readStore(layout.storePath).records.some(item => item.id === thirdRecord.id))

console.log('a healthy rebuild reports no staleness')
rmSync(layout.viewPath, { recursive: true, force: true })
const healthy = await mutateAndRefreshView(OPTIONS, current => ({
  changed: true,
  records: [...current.records, record({ content: 'fourth fact' })],
  result: 'ok',
}))
check('the mutation reports success', healthy.result === 'ok')
check('the view is not stale', healthy.viewStale === false)
check('the view holds the new record', readFileSync(layout.viewPath, 'utf8').includes('fourth fact'))

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
