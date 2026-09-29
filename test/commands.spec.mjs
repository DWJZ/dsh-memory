/**
 * Command surface suite.
 *
 * These assertions drive the registered `/memory` command the way the dispatcher
 * does, so the parsing, the scope selection, and the destructive guards are all
 * exercised rather than assumed. The two read tools are executed here as well:
 * their schemas are checked in the wiring suite, but a schema is not a result.
 *
 * Usage: `node test/commands.spec.mjs`.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStubContext, disposeEffects } from './fixtures/stub-context.mjs'
import { memoryId } from './fixtures/records.mjs'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import(pathToFileURL(join(PLUGIN, 'src/index.js')).href)
const { projectLayout, tombstoneLayout, userLayout } = await import(pathToFileURL(join(PLUGIN, 'src/paths.js')).href)
const { readStore, withStore } = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const AT = '2026-09-26T00:00:00.000Z'
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-memory-commands-'))
const MEMORY = join(ROOT, 'memory')
const PROJECT = join(ROOT, 'project')
mkdirSync(join(PROJECT, '.git'), { recursive: true })
mkdirSync(MEMORY, { recursive: true })

/** One record the store holds. */
const record = (overrides = {}) => ({
  id: memoryId(),
  scope: 'user',
  project_id: null,
  category: 'state',
  content: 'a fact',
  confidence: 1,
  evidence: [],
  created_at: AT,
  updated_at: AT,
  status: 'active',
  superseded_by: null,
  ...overrides,
})

/** Start the plugin and settle its project lookup. */
async function start() {
  const ctx = createStubContext()
  plugin.apply(ctx, { dshHome: ROOT, memoryDir: MEMORY })
  if (ctx.registrations.injections.length === 0) throw new Error('the runtime did not mount')
  const agent = { session: { id: 'session-1', header: { id: 'session-1', cwd: PROJECT } } }
  ctx.emit('agent/created', { agent })
  await new Promise(resolveTick => { setTimeout(resolveTick, 30) })
  return { ctx, agent }
}

/** Run one `/memory` invocation. */
const run = (ctx, rawInput, agent) => ctx.registrations.commands[0].handler({ rawInput, agent })

/** The text of one command result. */
const textOf = result => String(result.text ?? '')

// Seed the user scope with two records.
const userScope = userLayout(MEMORY)
const pnpmRecord = record({ content: '用户偏好 pnpm', category: 'preference' })
const langRecord = record({ content: '用户偏好中文解释', category: 'preference' })
await withStore({ ...userScope, lockTimeoutMs: 3000, staleLockMs: 60000 }, current => ({
  changed: true,
  records: [...current.records, pnpmRecord, langRecord],
}))

const { ctx, agent } = await start()
const command = ctx.registrations.commands[0]

console.log('help and dispatch')
check('the command is named memory', command.name === 'memory')
check('the command declares an input hint', typeof command.input?.hint === 'string')
const usage = await run(ctx, '', agent)
check('an empty invocation prints usage', usage.kind === 'success' && textOf(usage).includes('/memory list'))
check('usage reports the enabled state', textOf(usage).includes('enabled'))
check('usage names the memory root', textOf(usage).includes(MEMORY))
const unknown = await run(ctx, 'nonsense', agent)
check('an unknown subcommand is an error', unknown.kind === 'error')
check('the error repeats the usage', textOf(unknown).includes('/memory inspect'))

console.log('consolidate')
// The manual trigger runs the same pipeline the debounce runs. Nothing has been
// observed for this Session, so it reports that without reaching a model.
check('usage names the consolidation command', textOf(usage).includes('/memory consolidate'))
const consolidateNow = await run(ctx, 'consolidate', agent)
check('consolidate succeeds', consolidateNow.kind === 'success', textOf(consolidateNow))
check('it reports that nothing was observed',
  textOf(consolidateNow).includes('no events this process has observed'), textOf(consolidateNow))
const dryConsolidate = await run(ctx, 'consolidate --dry-run', agent)
check('--dry-run is accepted', dryConsolidate.kind === 'success')
check('a dry run over nothing is still a no-op report',
  textOf(dryConsolidate).includes('no events this process has observed'))

console.log('list')
const listed = await run(ctx, 'list', agent)
check('list succeeds', listed.kind === 'success')
check('list shows a stored record', textOf(listed).includes('用户偏好 pnpm'))
check('list shows the id and scope', textOf(listed).includes(pnpmRecord.id) && textOf(listed).includes('[user/preference]'))
check('list shows both records', textOf(listed).includes('用户偏好中文解释'))
check('list accepts --user', (await run(ctx, 'list --user', agent)).kind === 'success')
check('list accepts --project', (await run(ctx, 'list --project', agent)).kind === 'success')
check('an invalid --status is refused', (await run(ctx, 'list --status bogus', agent)).kind === 'error')
check('an invalid --category is refused', (await run(ctx, 'list --category bogus', agent)).kind === 'error')
check('a category filter narrows the list',
  textOf(await run(ctx, 'list --category decision', agent)).includes('No Memory matches'))
check('--status all includes non-active records', (await run(ctx, 'list --status all', agent)).kind === 'success')

console.log('search')
const found = await run(ctx, 'search 中文', agent)
check('search succeeds', found.kind === 'success')
check('search finds the matching record', textOf(found).includes('用户偏好中文解释'))
check('search omits the non-matching record', !textOf(found).includes('用户偏好 pnpm'))
check('a missing query is refused', (await run(ctx, 'search', agent)).kind === 'error')
check('a bad --top is refused', (await run(ctx, 'search 中文 --top=0', agent)).kind === 'error')
check('an unmatched query says so', textOf(await run(ctx, 'search zzz', agent)).includes('No Memory matches'))

console.log('inspect')
const inspected = await run(ctx, `inspect ${pnpmRecord.id}`, agent)
check('inspect succeeds', inspected.kind === 'success')
check('inspect prints the record as JSON', textOf(inspected).includes(`"id": "${pnpmRecord.id}"`))
check('inspect prints provenance', textOf(inspected).includes('"evidence"'))
check('a missing id is an error', (await run(ctx, 'inspect mem_absent', agent)).kind === 'error')
check('inspect without an id is an error', (await run(ctx, 'inspect', agent)).kind === 'error')

console.log('export')
const exported = await run(ctx, 'export --user', agent)
check('export succeeds', exported.kind === 'success')
check('export names both records', textOf(exported).includes(pnpmRecord.id) && textOf(exported).includes(langRecord.id))
const exportedJson = await run(ctx, 'export --user --format=json', agent)
check('export supports json', exportedJson.kind === 'success' && textOf(exportedJson).includes('"scope": "user"'))
check('an unknown format is refused', (await run(ctx, 'export --format=xml', agent)).kind === 'error')
const tiny = createStubContext()
plugin.apply(tiny, { dshHome: ROOT, memoryDir: MEMORY, exportInlineMaxBytes: 10 })
const refused = await tiny.registrations.commands[0].handler({ rawInput: 'export --user', agent })
check('an over-limit export fails loud', refused.kind === 'error')
check('the refusal says nothing was truncated', textOf(refused).includes('Nothing was truncated'))
check('the refusal suggests narrowing', textOf(refused).includes('--user'))
await disposeEffects(tiny)

console.log('clear guards the destructive path')
const reported = await run(ctx, 'clear --user', agent)
check('clear without --yes does not delete', reported.kind === 'success')
check('it reports how many would go', textOf(reported).includes('This would delete 2'))
check('the records are still present', readStore(userScope.storePath).records.length === 2)
check('clear without a scope is refused', (await run(ctx, 'clear --yes', agent)).kind === 'error')

console.log('archive and forget')
const archived = await run(ctx, `archive ${langRecord.id}`, agent)
check('archive succeeds', archived.kind === 'success')
check('the record becomes archived', readStore(userScope.storePath).records.find(r => r.id === langRecord.id).status === 'archived')
check('the index drops it', !readFileSync(userScope.viewPath, 'utf8').includes('用户偏好中文解释'))
check('archiving twice is a conflict', (await run(ctx, `archive ${langRecord.id}`, agent)).kind === 'error')

const forgotten = await run(ctx, `forget ${pnpmRecord.id}`, agent)
check('forget succeeds', forgotten.kind === 'success')
check('the record is gone', !readStore(userScope.storePath).records.some(r => r.id === pnpmRecord.id))
check('the view no longer holds it', !readFileSync(userScope.viewPath, 'utf8').includes('用户偏好 pnpm'))
check('a tombstone records the deletion',
  readFileSync(tombstoneLayout(MEMORY).path, 'utf8').includes('"op":"forget"'))
check('the tombstone carries no content',
  !readFileSync(tombstoneLayout(MEMORY).path, 'utf8').includes('用户偏好 pnpm'))
check('forgetting an absent Memory is an error', (await run(ctx, `forget ${pnpmRecord.id}`, agent)).kind === 'error')

const cleared = await run(ctx, 'clear --user --yes', agent)
check('clear with --yes succeeds', cleared.kind === 'success')
check('it reports the count', textOf(cleared).includes('Deleted 1'))
check('the user scope is empty', readStore(userScope.storePath).records.length === 0)
check('a summary tombstone is written',
  readFileSync(tombstoneLayout(MEMORY).path, 'utf8').includes('"op":"clear"'))
check('clearing an empty scope is a no-op',
  textOf(await run(ctx, 'clear --user --yes', agent)).includes('Nothing to delete'))

console.log('project')
const shown = await run(ctx, 'project show', agent)
check('project show succeeds', shown.kind === 'success')
check('a project is registered for the session', textOf(shown).includes('(current)'))
check('project show prints the root', textOf(shown).includes('project'))
check('project bind reports the binding', (await run(ctx, `project bind ${PROJECT}`, agent)).kind === 'success')
const other = join(ROOT, 'other-project')
mkdirSync(other, { recursive: true })
const bound = await run(ctx, `project bind ${other}`, agent)
check('binding a new directory creates a project', textOf(bound).includes('Bound'))
check('binding it again reuses the project', textOf(await run(ctx, `project bind ${other}`, agent)).includes('Already bound'))
check('relink without both paths is refused', (await run(ctx, 'project relink /a', agent)).kind === 'error')
const moved = join(ROOT, 'moved-project')
mkdirSync(moved, { recursive: true })
check('relink succeeds', (await run(ctx, `project relink ${other} ${moved}`, agent)).kind === 'success')
check('an unknown project subcommand is refused', (await run(ctx, 'project frobnicate', agent)).kind === 'error')
mkdirSync(join(PROJECT, 'relative-dir'), { recursive: true })
const relative = await run(ctx, 'project bind relative-dir', agent)
check('a relative path binds against the session directory', relative.kind === 'success')
check('the relative path was resolved, not stored verbatim',
  readFileSync(join(MEMORY, 'registry.json'), 'utf8').includes(join(PROJECT, 'relative-dir')))

console.log('paths with spaces survive the command line')
const spaced = join(ROOT, 'My Projects')
mkdirSync(spaced, { recursive: true })
const quoted = await run(ctx, `project bind "${spaced}"`, agent)
check('a double-quoted path binds as one argument', quoted.kind === 'success')
check('the whole path is stored, not its first word',
  readFileSync(join(MEMORY, 'registry.json'), 'utf8').includes(spaced))
check('binding the quoted path again is not a second project',
  textOf(await run(ctx, `project bind "${spaced}"`, agent)).includes('Already bound'))

const singleQuoted = join(ROOT, 'Single Quoted')
mkdirSync(singleQuoted, { recursive: true })
check('a single-quoted path binds as one argument',
  (await run(ctx, `project bind '${singleQuoted}'`, agent)).kind === 'success')
check('the whole single-quoted path is stored',
  readFileSync(join(MEMORY, 'registry.json'), 'utf8').includes(singleQuoted))

const escaped = join(ROOT, 'Escaped Path')
mkdirSync(escaped, { recursive: true })
check('an escaped space binds as one argument',
  (await run(ctx, `project bind ${ROOT}/Escaped\\ Path`, agent)).kind === 'success')
check('the escaped path is stored whole',
  readFileSync(join(MEMORY, 'registry.json'), 'utf8').includes(escaped))

const spacedMove = join(ROOT, 'Moved Projects')
mkdirSync(spacedMove, { recursive: true })
check('relink accepts two quoted paths',
  (await run(ctx, `project relink "${spaced}" "${spacedMove}"`, agent)).kind === 'success')
check('relink kept the old path as an alias and added the new one',
  readFileSync(join(MEMORY, 'registry.json'), 'utf8').includes(spacedMove))

console.log('a search query keeps its quotes')
const spacedRecord = record({ content: 'quoted phrase here' })
await withStore({ ...userScope, lockTimeoutMs: 3000, staleLockMs: 60000 }, current => ({
  changed: true,
  records: [...current.records, spacedRecord],
}))
check('a quoted multi-word query is one argument',
  (await run(ctx, 'search "quoted phrase"', agent)).kind === 'success')

console.log('unterminated_quote_fails_cleanly')
const unclosed = await run(ctx, 'project bind "/Users/me/My Projects', agent)
check('an unterminated quote is refused', unclosed.kind === 'error')
check('the refusal names the problem', textOf(unclosed).includes('unterminated quote'))
check('nothing was bound from a guessed argument boundary',
  !readFileSync(join(MEMORY, 'registry.json'), 'utf8').includes('/Users/me/My'))
const unclosedFlag = await run(ctx, 'list --status "active', agent)
check('an unterminated quote in a flag value is refused too', unclosedFlag.kind === 'error')
check('a closed quote in the same position still works',
  (await run(ctx, 'list --status "active"', agent)).kind === 'success')

console.log('the read tools execute')
const searchTool = ctx.registrations.tools.find(definition => definition.name === 'memory_search')
const getTool = ctx.registrations.tools.find(definition => definition.name === 'memory_get')
const registeredProjects = JSON.parse(readFileSync(join(MEMORY, 'registry.json'), 'utf8')).projects
const currentProject = registeredProjects.find(entry => entry.canonical_root === join(PROJECT)) ?? registeredProjects[0]
const projectRecord = record({
  scope: 'project',
  project_id: currentProject.project_id,
  content: '该项目使用 pnpm',
})
await withStore({ ...projectLayout(MEMORY, currentProject.project_id), lockTimeoutMs: 3000, staleLockMs: 60000 }, current => ({
  changed: true,
  records: [...current.records, projectRecord],
}))
const searchResult = await searchTool.execute({ query: 'pnpm' }, { agent })
check('memory_search returns the project record', searchResult.results.some(hit => hit.id === projectRecord.id))
check('memory_search reports a total', searchResult.total === 1)
check('memory_search hides the internal score', searchResult.results.every(hit => !('score' in hit)))
check('memory_search honours top_k',
  (await searchTool.execute({ query: 'pnpm', top_k: 1 }, { agent })).results.length === 1)
check('memory_search caps top_k at the configured bound',
  (await searchTool.execute({ query: 'pnpm', top_k: 999 }, { agent })).results.length === 1)
check('memory_search declares the same bound in its schema',
  searchTool.parameters.properties.top_k.maximum === 8)
check('memory_search with no match is empty',
  (await searchTool.execute({ query: 'zzz' }, { agent })).results.length === 0)

const fetched = await getTool.execute({ id: projectRecord.id }, { agent })
check('memory_get finds the record', fetched.found === true && fetched.memory.id === projectRecord.id)
check('memory_get returns provenance', Array.isArray(fetched.memory.evidence))
const absent = await getTool.execute({ id: memoryId() }, { agent })
check('memory_get reports a missing id explicitly', absent.found === false && absent.reason === 'not-found')
check('memory_get does not throw for a foreign id', absent.found === false)

console.log('memory_get does not hide a broken store')
const savedStore = readFileSync(userScope.storePath, 'utf8')
writeFileSync(userScope.storePath, '{ not json')
let corruptError
try {
  await getTool.execute({ id: projectRecord.id }, { agent })
} catch (error) {
  corruptError = error
}
check('a corrupt store propagates instead of reading as not-found', corruptError !== undefined)
writeFileSync(userScope.storePath, savedStore)
check('the restored store reads again', (await getTool.execute({ id: projectRecord.id }, { agent })).found === true)

console.log('binding a directory refreshes the session project')
const plain = join(ROOT, 'plain-workspace')
mkdirSync(plain, { recursive: true })
const fresh = createStubContext()
plugin.apply(fresh, { dshHome: ROOT, memoryDir: MEMORY })
const plainAgent = { session: { id: 'session-plain', header: { id: 'session-plain', cwd: plain } } }
await fresh.emitAsync('agent/created', { agent: plainAgent })
const beforeBind = await run(fresh, 'clear --project --yes', plainAgent)
check('a directory with no marker has no project scope yet', beforeBind.kind === 'error')
const boundPlain = await run(fresh, `project bind ${plain}`, plainAgent)
check('binding succeeds', boundPlain.kind === 'success')
const afterBind = await run(fresh, 'clear --project --yes', plainAgent)
check('the bound directory is now the session project', afterBind.kind === 'success')
check('the project scope is empty, so nothing was deleted',
  textOf(afterBind).includes('Nothing to delete'))
await disposeEffects(fresh)

console.log('forget reports a tombstone it could not write')
const doomed = record({ content: 'to be deleted' })
await withStore({ ...userScope, lockTimeoutMs: 3000, staleLockMs: 60000 }, current => ({
  changed: true,
  records: [...current.records, doomed],
}))
const tombstonePath = tombstoneLayout(MEMORY).path
const savedTombstones = existsSync(tombstonePath) ? readFileSync(tombstonePath, 'utf8') : undefined
rmSync(tombstonePath, { force: true })
mkdirSync(tombstonePath)
const blockedForget = await run(ctx, `forget ${doomed.id}`, agent)
check('the deletion still succeeds', blockedForget.kind === 'success')
check('the record is gone', !readStore(userScope.storePath).records.some(r => r.id === doomed.id))
check('the report does not promise a tombstone', !textOf(blockedForget).includes('A tombstone without content remains'))
check('the report names what failed', textOf(blockedForget).includes('audit tombstone could not be written'))
rmSync(tombstonePath, { recursive: true, force: true })
if (savedTombstones !== undefined) writeFileSync(tombstonePath, savedTombstones)

console.log('clear reports its tombstone honestly')
const clearedRecord = record({ content: 'cleared soon' })
await withStore({ ...userScope, lockTimeoutMs: 3000, staleLockMs: 60000 }, current => ({
  changed: true,
  records: [...current.records, clearedRecord],
}))
const clearTombstonePath = tombstoneLayout(MEMORY).path
rmSync(clearTombstonePath, { force: true })
const goodClear = await run(ctx, 'clear --user --yes', agent)
check('clear deletes every user-scope record', goodClear.kind === 'success')
check('clear says how many it deleted', textOf(goodClear).includes('Deleted'))
check('clear promises a summary tombstone it wrote',
  textOf(goodClear).includes('summary tombstone without content remains'))
check('the tombstone holds no content',
  !readFileSync(clearTombstonePath, 'utf8').includes('cleared soon'))
check('the tombstone records a count',
  JSON.parse(readFileSync(clearTombstonePath, 'utf8').trim().split('\n').at(-1)).count >= 1)

await withStore({ ...userScope, lockTimeoutMs: 3000, staleLockMs: 60000 }, current => ({
  changed: true,
  records: [...current.records, record({ content: 'cleared again' })],
}))
rmSync(clearTombstonePath, { force: true })
mkdirSync(clearTombstonePath)
const blockedClear = await run(ctx, 'clear --user --yes', agent)
check('clear still deletes when the tombstone cannot be written', blockedClear.kind === 'success')
check('the records are gone', readStore(userScope.storePath).records.length === 0)
check('clear does not promise the tombstone it failed to write',
  !textOf(blockedClear).includes('tombstone without content remains'))
check('clear names what failed', textOf(blockedClear).includes('audit tombstone could not be written'))
rmSync(clearTombstonePath, { recursive: true, force: true })

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
