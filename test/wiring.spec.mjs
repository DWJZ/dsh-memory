/**
 * Plugin wiring suite.
 *
 * What the plugin registers, what disabling removes, and what provenance it can
 * honestly claim for a write. The distinction matters: disabling must dispose the
 * index and the tools rather than leave callbacks that do nothing, while the
 * command surface has to survive disabling, because it is the only way back.
 *
 * Usage: `node test/wiring.spec.mjs`.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStubContext, disposeEffects } from './fixtures/stub-context.mjs'
import { memoryRecord, projectMemoryRecord } from './fixtures/records.mjs'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import(pathToFileURL(join(PLUGIN, 'src/index.js')).href)
const { userLayout, projectLayout, pluginConfigPath } = await import(pathToFileURL(join(PLUGIN, 'src/paths.js')).href)
const { readStore } = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-memory-wiring-'))
const MEMORY = join(ROOT, 'memory')
mkdirSync(MEMORY, { recursive: true })
const PROJECT_DIR = join(ROOT, 'project')
mkdirSync(join(PROJECT_DIR, '.git'), { recursive: true })
const CONFIG = { dshHome: ROOT, memoryDir: MEMORY, enabled: true }

/** One agent stub bound to a session and working directory. */
const agentStub = (sessionId = 'session-1', cwd = PROJECT_DIR) => ({
  session: { header: { id: sessionId, cwd } },
})

/** One human user message as the event feed would carry it. */
const humanMessage = text => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })

/** One injected context message, which must not become provenance. */
const injectedMessage = text => ({ type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'agent-instructions' } } })

/** Start the plugin against a stub context. */
const start = (config = CONFIG) => {
  const ctx = createStubContext()
  plugin.apply(ctx, config)
  return ctx
}

/** The tool with one name. */
const toolNamed = (ctx, name) => ctx.registrations.tools.find(definition => definition.name === name)

/** Run one `/memory` invocation through the registered command. */
const runCommand = (ctx, rawInput, agent = agentStub()) => ctx.registrations.commands[0].handler({ rawInput, agent })

/** Give the async project lookup a chance to settle. */
const settle = () => new Promise(resolveTick => { setTimeout(resolveTick, 20) })

console.log('what the plugin registers')
const ctx = start()
check('exactly one command is registered', ctx.registrations.commands.length === 1)
check('the command is named memory', ctx.registrations.commands[0].name === 'memory')
check('three tools are registered', ctx.registrations.tools.length === 3)
check('the tools are the documented three',
  ctx.registrations.tools.map(definition => definition.name).sort().join(',') === 'memory_get,memory_remember,memory_search')
check('the index context is registered', ctx.registrations.contexts.length === 1)
check('the context is named memory:index', ctx.registrations.contexts[0].name === 'memory:index')
check('the context has a numeric order', Number.isFinite(ctx.registrations.contexts[0].order))
check('the plugin owns its registrations as effects', ctx.registrations.effects === 2)

console.log('the index reflects stored Memory')
const userScope = userLayout(MEMORY)
const { withStore } = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.js')).href)
await withStore({ ...userScope, lockTimeoutMs: 3000, staleLockMs: 60000 }, current => ({
  changed: true,
  records: [...current.records, memoryRecord({
    category: 'preference',
    content: '用户偏好中文解释',
  })],
}))
const rendered = ctx.registrations.contexts[0].text({ agent: agentStub() })
check('the index lists the stored fact', rendered.includes('- [preference] 用户偏好中文解释'))
check('a bare assemble renders nothing', ctx.registrations.contexts[0].text({}) === '')

console.log('project Memory reaches the index')
const projectAgent = agentStub('session-project', PROJECT_DIR)
ctx.emit('agent/created', { agent: projectAgent })
await settle()
const resolvedProjectId = readProjectId()
check('the project was registered', resolvedProjectId !== undefined)
await withStore({ ...projectLayout(MEMORY, resolvedProjectId), lockTimeoutMs: 3000, staleLockMs: 60000 }, current => ({
  changed: true,
  records: [...current.records, projectMemoryRecord(resolvedProjectId, {
    category: 'state',
    content: '该项目使用 pnpm',
  })],
}))
const projectIndex = ctx.registrations.contexts[0].text({ agent: projectAgent })
check('the project fact is injected for that session', projectIndex.includes('- [state] 该项目使用 pnpm'))
check('user Memory is injected alongside it', projectIndex.includes('- [preference] 用户偏好中文解释'))
const otherIndex = ctx.registrations.contexts[0].text({ agent: agentStub('session-other', ROOT) })
check('a session without that project does not see its Memory', !otherIndex.includes('该项目使用 pnpm'))
check('a session without a project still sees user Memory', otherIndex.includes('用户偏好中文解释'))

console.log('memory tools')
const search = toolNamed(ctx, 'memory_search')
const get = toolNamed(ctx, 'memory_get')
const remember = toolNamed(ctx, 'memory_remember')
check('search declares a query', search.parameters.required.includes('query'))
check('search offers the scope filter', JSON.stringify(search.parameters.properties.scope.enum) === '["user","project","all"]')
check('get requires an id', get.parameters.required.includes('id'))
check('remember requires a mode and content',
  remember.parameters.required.includes('mode') && remember.parameters.required.includes('content'))
check('remember documents the modes',
  JSON.stringify(remember.parameters.properties.mode.enum) === '["add","update","supersede"]')
check('remember tells the model when to call it',
  remember.description.includes('only when the user explicitly asks'))
check('remember names what not to store', remember.description.includes('AGENTS.md'))
check('no tool exposes a delete', ctx.registrations.tools.every(definition => !definition.name.includes('delete')))

console.log('memory_remember parameter enforcement')
const reject = async (args) => {
  try {
    await remember.execute(args, { agent: agentStub() })
    return false
  } catch (error) {
    return error instanceof TypeError
  }
}
check('add rejects a target_id', await reject({ mode: 'add', content: 'x', scope: 'user', category: 'state', target_id: 'mem_a' }))
check('add without a scope is rejected', await reject({ mode: 'add', content: 'x', category: 'state' }))
check('update without a target_id is rejected', await reject({ mode: 'update', content: 'x' }))
check('update carrying a scope is rejected', await reject({ mode: 'update', content: 'x', target_id: 'mem_a', scope: 'user' }))
check('supersede carrying a category is rejected', await reject({ mode: 'supersede', content: 'x', target_id: 'mem_a', category: 'state' }))

console.log('the remember card does not echo the content')
const card = remember.presentCall({ mode: 'add', content: 'a secret-looking fact', scope: 'user', category: 'state' })
check('the card is titled Remember', card.title === 'Remember')
check('the card omits the content', !JSON.stringify(card).includes('secret-looking'))
check('the card still names the mode and scope', card.rawInput.mode === 'add' && card.rawInput.scope === 'user')
const updateCard = remember.presentCall({ mode: 'update', content: 'x', target_id: 'mem_a' })
check('the update card names the target', updateCard.rawInput.target_id === 'mem_a')

console.log('the turn tracker binds provenance')
const trackAgent = agentStub('session-1', PROJECT_DIR)
ctx.emit('agent/created', { agent: trackAgent })
await settle()
ctx.emit('session/event', { header: { id: 'session-1' } }, humanMessage('记住，这个项目使用 pnpm'))
ctx.emit('session/event', { header: { id: 'session-1' } }, injectedMessage('injected guidance'))
ctx.emit('session/event', { header: { id: 'session-1' } }, { type: 'turn/start', seq: 9, data: { turn: 1 } })
const written = await remember.execute({ mode: 'add', content: '该项目使用 pnpm 作为包管理器', scope: 'project', category: 'state' }, { agent: trackAgent })
check('the write succeeded', written.action === 'added')
const projectId = written.action === 'added' ? readProjectIdForRecord(written.id) : undefined
check('the record is stored with provenance', projectId !== undefined)
const stored = projectId === undefined ? undefined : readStore(projectLayout(MEMORY, projectId).storePath).records.find(record => record.id === written.id)
check('the quote is the user message', stored?.evidence?.[0]?.quote.includes('这个项目使用 pnpm'))
check('the injected context is not the quote', !String(stored?.evidence?.[0]?.quote).includes('injected guidance'))
check('the provenance kind is user', stored?.evidence?.[0]?.kind === 'user')
check('the session is recorded', stored?.evidence?.[0]?.session_id === 'session-1')

console.log('provenance is left empty rather than guessed')
const { buildProvenance, createTurnTracker } = await import(pathToFileURL(join(PLUGIN, 'src/inject.js')).href)
const bareTracker = createTurnTracker(ctx)
const unknownTurn = buildProvenance(agentStub('session-never-observed', PROJECT_DIR), bareTracker, { evidenceQuoteMaxChars: 200 })
check('an unobserved session still yields an entry', unknownTurn.evidence?.session_id === 'session-never-observed')
check('an unobserved session guesses no sequence', unknownTurn.evidence?.event_seqs.length === 0)
check('an unobserved session quotes nothing', unknownTurn.evidence?.quote === '')
check('an unobserved session offers nothing to screen', unknownTurn.sourceTexts.length === 0)
bareTracker.dispose()
const noSession = buildProvenance({ session: { header: {} } }, bareTracker, { evidenceQuoteMaxChars: 200 })
check('an agent without a session yields no provenance', noSession.evidence === undefined)

console.log('disable disposes the runtime and keeps the command')
const disabled = await runCommand(ctx, 'disable')
check('the command reports success', disabled.kind === 'success')
check('the index is disposed', ctx.registrations.contexts.length === 0)
check('the tools are disposed', ctx.registrations.tools.length === 0)
check('the command survives', ctx.registrations.commands.length === 1)
check('the choice is persisted', JSON.parse(readFileSync(pluginConfigPath(MEMORY), 'utf8')).enabled === false)
const stillUsable = await runCommand(ctx, 'list')
check('the command still works while disabled', stillUsable.kind === 'success')
check('the usage text reports the disabled state', String((await runCommand(ctx, '')).text).includes('disabled'))

console.log('enable restores the runtime')
const reenabled = await runCommand(ctx, 'enable')
check('the command reports success', reenabled.kind === 'success')
check('the index is back', ctx.registrations.contexts.length === 1)
check('the tools are back', ctx.registrations.tools.length === 3)
check('the choice is persisted', JSON.parse(readFileSync(pluginConfigPath(MEMORY), 'utf8')).enabled === true)

console.log('a stored choice outlives the process')
const restarted = start({ ...CONFIG, enabled: false })
check('the persisted switch wins over the deployment config',
  restarted.registrations.contexts.length === 1 && restarted.registrations.tools.length === 3)
await runCommand(restarted, 'disable')
const restartedAgain = start(CONFIG)
check('a fresh start honours the stored switch', restartedAgain.registrations.tools.length === 0)
check('a fresh start still registers the command', restartedAgain.registrations.commands.length === 1)
check('a fresh start still reports the stored state', String((await runCommand(restartedAgain, '')).text).includes('disabled'))

console.log('registry_disposal')
const disposal = start()
disposeEffects(disposal)
check('unloading removes the index', disposal.registrations.contexts.length === 0)
check('unloading removes the tools', disposal.registrations.tools.length === 0)
check('unloading removes the command', disposal.registrations.commands.length === 0)
check('unloading removes the listeners', [...disposal.registrations.listeners.values()].every(list => list.length === 0))
check('every disposer ran', disposal.registrations.disposeCalls > 0)

console.log('the project lookup finishes before agent creation resolves')
// `agent/created` is a serial event, so awaiting the dispatch must be enough:
// no extra settling, and a directory that has never been registered before, so
// the lookup really has to write the registry.
const lateDir = join(ROOT, 'late-project')
mkdirSync(join(lateDir, '.git'), { recursive: true })
const lateCtx = createStubContext()
plugin.apply(lateCtx, { dshHome: ROOT, memoryDir: MEMORY })
const lateAgent = { session: { header: { id: 'session-late', cwd: lateDir } } }
await lateCtx.emitAsync('agent/created', { agent: lateAgent })
const lateCommand = await lateCtx.registrations.commands[0].handler({ rawInput: 'clear --project --yes', agent: lateAgent })
check('the session already has a project when creation resolves', lateCommand.kind === 'success')
check('the late directory was registered',
  JSON.parse(readFileSync(join(MEMORY, 'registry.json'), 'utf8')).projects
    .some(entry => entry.canonical_root === resolve(lateDir) || entry.canonical_root === realpathSync(lateDir)))
disposeEffects(lateCtx)

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)

/**
 * Read the first registered project id.
 * @returns the project id, or undefined.
 */
function readProjectId() {
  const registryPath = join(MEMORY, 'registry.json')
  try {
    const entries = JSON.parse(readFileSync(registryPath, 'utf8')).projects ?? []
    return entries.length > 0 ? entries[0].project_id : undefined
  } catch {
    return undefined
  }
}

/**
 * Locate the project holding one record.
 * @param id - the record id.
 * @returns the owning project id, or undefined.
 */
function readProjectIdForRecord(id) {
  const registryPath = join(MEMORY, 'registry.json')
  try {
    const entries = JSON.parse(readFileSync(registryPath, 'utf8')).projects ?? []
    for (const entry of entries) {
      const records = readStore(projectLayout(MEMORY, entry.project_id).storePath).records
      if (records.some(record => record.id === id)) return entry.project_id
    }
  } catch {
    return undefined
  }
  return undefined
}
