/**
 * Cross-session integration suite.
 *
 * These are the assertions the unit suites cannot make: every run below boots the
 * shipped headless profile through the real Loader, with the plugin mounted from
 * this checkout and a scripted adapter standing in for the model, and then reads
 * back what the model was actually sent. Nothing is installed into a profile, and
 * no API call is made.
 *
 * The four scenarios are the contract's: Memory written in one Session reaches the
 * next, one project cannot see another's Memory, user Memory reaches every
 * project, and an explicit supersede retires the record it replaces.
 *
 * Usage: `node test/integration.spec.mjs`.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = resolve(PLUGIN, '../..')
const { readRegistry } = await import(pathToFileURL(join(PLUGIN, 'src/registry.js')).href)
const { readStore } = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.js')).href)
const { projectLayout, registryLayout } = await import(pathToFileURL(join(PLUGIN, 'src/paths.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

/** Per-run wall-clock guard: a stuck adapter must not hang the suite. */
const RUN_TIMEOUT_MS = 120_000

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-memory-integration-'))
const HOME = join(ROOT, 'home')
mkdirSync(HOME, { recursive: true })

/** One project directory that looks like a repository. */
const projectDir = (name) => {
  const path = join(ROOT, name)
  mkdirSync(join(path, '.git'), { recursive: true })
  return path
}

const PROJECT_A = projectDir('project-a')
const PROJECT_B = projectDir('project-b')
const PROJECT_C = projectDir('project-c')

/**
 * Write the overlay that points the shipped headless profile at this checkout.
 *
 * The session's working directory comes from the filesystem provider, so pinning
 * `fs-sandbox` is what makes the session run inside the fixture project while the
 * process itself stays in the repository, where the TypeScript loader resolves
 * the workspace sources.
 * @param project - the working directory the session runs in.
 * @returns the patch path.
 */
function writePatch(project, options = {}) {
  const path = join(ROOT, `overlay-${String(Math.abs(hash(project)))}-${String(Date.now())}.yml`)
  writeFileSync(path, [
    '- id: llm-deepseek',
    '  disabled: true',
    '',
    '- id: agent-default-model',
    '  config:',
    '    provider: dsh-memory-mock',
    '    model: dsh-memory-mock',
    '',
    '- id: fs-sandbox',
    '  config:',
    `    cwd: ${JSON.stringify(project)}`,
    '',
    '- insert:',
    '    - id: dsh-memory-mock-llm',
    `      name: ${JSON.stringify(join(PLUGIN, 'test/fixtures/mock-llm.ts'))}`,
    '',
    '    - id: dsh-memory',
    `      name: ${JSON.stringify(join(PLUGIN, 'src/index.js'))}`,
    '',
    ...options.drive !== true ? [] : [
      '    - id: dsh-memory-consolidate-on-idle',
      `      name: ${JSON.stringify(join(PLUGIN, 'test/fixtures/consolidate-on-idle.ts'))}`,
      '',
    ],
  ].join('\n'))
  return path
}

/**
 * Boot one session to completion.
 * @param options - the run's inputs.
 * @param options.project - the working directory.
 * @param options.task - the task text.
 * @param options.remember - arguments for the scripted write, when it writes.
 * @param options.supersede - whether the scripted turn searches then supersedes.
 * @returns the exit code, output, and where the requests were recorded.
 */
async function runSession(options) {
  const patch = writePatch(options.project, options)
  const log = join(ROOT, `requests-${String(Date.now())}-${String(Math.abs(hash(options.task)))}.jsonl`)
  const env = {
    ...process.env,
    DSH_HOME: HOME,
    DSH_MEMORY_MOCK_LOG: log,
    ...options.remember === undefined ? {} : { DSH_MEMORY_MOCK_REMEMBER: JSON.stringify(options.remember) },
    ...options.supersede === true ? { DSH_MEMORY_MOCK_SUPERSEDE: '1' } : {},
    ...options.query === undefined ? {} : { DSH_MEMORY_MOCK_QUERY: options.query },
    ...options.learned === undefined ? {} : { DSH_MEMORY_MOCK_LEARNED: options.learned },
    ...options.drive !== true ? {} : { DSH_MEMORY_DRIVER_LOG: `${log}.driver` },
  }
  const outcome = await new Promise((settle) => {
    const child = spawn(process.execPath, [
      '--import', 'tsx/esm',
      join(REPO, 'apps/cli/src/bin.ts'),
      '--profile', 'headless',
      '--patch', patch,
      options.task,
    ], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
    const guard = setTimeout(() => { child.kill('SIGKILL') }, RUN_TIMEOUT_MS)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => {
      clearTimeout(guard)
      settle({ code: -1, stdout, stderr: `${stderr}\n${String(error)}` })
    })
    child.on('close', code => {
      clearTimeout(guard)
      settle({ code, stdout, stderr })
    })
  })
  return { ...outcome, log }
}

/**
 * Every request the main agent sent, in order.
 *
 * The session-title agent also reaches the model with the same words, so the
 * filter is the Memory tool catalogue it never carries.
 * @param log - the recorded request log.
 * @returns the parsed requests.
 */
/**
 * Every request recorded in one log, including calls that carry no tools.
 *
 * The consolidation call is one of those: it asks for a plan in text, so the
 * Memory tool catalogue is not part of it and {@link mainRequests} skips it.
 * @param log - the recorded request log.
 * @returns the parsed requests.
 */
function allRequests(log) {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').split('\n').filter(Boolean)
    .flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
}

/**
 * Whether one recorded request is a consolidation call.
 * @param request - a parsed request.
 * @returns true when it carries the consolidation policy.
 */
function isConsolidationCall(request) {
  return String(request?.system ?? '').includes('You maintain long-term Memory')
}

function mainRequests(log) {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line))
    .filter(request => request.tools.includes('memory_remember'))
}

/**
 * The full text of every request the main agent sent.
 * @param log - the recorded request log.
 * @returns the serialized requests.
 */
function requestText(log) {
  return JSON.stringify(mainRequests(log).map(request => request.messages))
}

/**
 * The records one project stores.
 * @param projectId - the project id.
 * @returns its records.
 */
function recordsOf(projectId) {
  return readStore(projectLayout(join(HOME, 'memory'), projectId).storePath).records
}

/**
 * Resolve the project id whose root is one directory.
 *
 * The registry stores the filesystem provider's resolved path, so both sides are
 * compared as real paths.
 * @param project - the directory.
 * @returns the project id, or undefined.
 */
function projectIdFor(project) {
  const registry = readRegistry(registryLayout(join(HOME, 'memory')).registryPath)
  const real = realpathSync(project)
  return registry.projects.find(entry => entry.canonical_root === real)?.project_id
}

/**
 * A small stable number for a string, used only to name files.
 * @param text - the text to hash.
 * @returns a non-negative integer.
 */
function hash(text) {
  let value = 0
  for (const character of text) value = (value * 31 + character.codePointAt(0)) | 0
  return value
}

console.log('boots the shipped profile with the plugin mounted from this checkout')
const first = await runSession({
  project: PROJECT_A,
  task: '记住，这个项目使用 pnpm',
  remember: { mode: 'add', content: '该项目使用 pnpm', scope: 'project', category: 'state' },
})
check('the run answers through the scripted model', first.code === 0, first.stderr.slice(0, 400))
check('no harness failure was reported', !first.stderr.includes('UNHANDLED'), first.stderr.slice(0, 400))
check('the model was sent a request', mainRequests(first.log).length >= 2)
check('the write reached the store', (() => {
  const projectId = projectIdFor(PROJECT_A)
  return projectId !== undefined && recordsOf(projectId).some(record => record.content === '该项目使用 pnpm')
})())
const writtenRecord = (() => {
  const projectId = projectIdFor(PROJECT_A)
  return projectId === undefined ? undefined : recordsOf(projectId).find(record => record.content === '该项目使用 pnpm')
})()
check('the record carries host-built provenance',
  writtenRecord?.evidence?.[0]?.kind === 'user' && String(writtenRecord?.evidence?.[0]?.quote).includes('记住'))
check('the record carries the current turn sequence',
  Number.isInteger(writtenRecord?.evidence?.[0]?.event_seqs?.[0]))

console.log('27.1 a later Session in the same project sees the Memory')
const secondSession = await runSession({ project: PROJECT_A, task: '安装 dependency foo' })
check('the second Session runs', secondSession.code === 0, secondSession.stderr.slice(0, 400))
const projectARequest = requestText(secondSession.log)
check('the model request carries the Memory index', projectARequest.includes('<memory-index>'))
check('the model request names the remembered fact', projectARequest.includes('[state] 该项目使用 pnpm'))
check('the index is not an empty envelope', projectARequest.includes('project:'))

console.log('27.5 automatic consolidation learns from a finished turn')
const CONSOLIDATION_PROJECT = join(ROOT, 'consolidation-project')
mkdirSync(CONSOLIDATION_PROJECT, { recursive: true })
writeFileSync(join(CONSOLIDATION_PROJECT, '.git'), '')
const learnedRun = await runSession({
  project: CONSOLIDATION_PROJECT,
  task: '我们决定统一用 pnpm 管理依赖',
  learned: '该项目使用 pnpm 管理依赖',
  drive: true,
})
check('the session with automatic consolidation finishes', learnedRun.code === 0, learnedRun.stderr.slice(0, 600))
const driverLog = `${learnedRun.log}.driver`
const driverSteps = existsSync(driverLog) ? readFileSync(driverLog, 'utf8') : ''
check('the consolidation ran to a successful commit',
  driverSteps.includes('handled:success'), driverSteps.replace(/\n/gu, ' | '))
const consolidationRequests = allRequests(learnedRun.log).filter(isConsolidationCall)
check('the consolidation model was called once', consolidationRequests.length === 1,
  String(consolidationRequests.length))
check('it was given the turn, not the whole log',
  JSON.stringify(consolidationRequests[0]?.messages ?? []).includes('我们决定统一用 pnpm'))
const learnedProjectId = projectIdFor(CONSOLIDATION_PROJECT)
check('the learned fact reached the store', learnedProjectId !== undefined
  && recordsOf(learnedProjectId).some(record => record.content === '该项目使用 pnpm 管理依赖'))
const learnedRecord = learnedProjectId === undefined
  ? undefined
  : recordsOf(learnedProjectId).find(record => record.content === '该项目使用 pnpm 管理依赖')
check('the learned record carries plugin-built provenance',
  learnedRecord?.evidence?.[0]?.kind === 'user'
  && String(learnedRecord?.evidence?.[0]?.quote).includes('pnpm'))
check('its evidence cites a sequence number from the window',
  Number.isInteger(learnedRecord?.evidence?.[0]?.event_seqs?.[0])
  && learnedRecord.evidence[0].event_seqs[0] >= 0)
const consolidationState = join(HOME, 'memory', 'consolidation-state.json')
check('the progress mark was recorded', existsSync(consolidationState))
check('the mark advanced over the window it consumed',
  Object.values(JSON.parse(readFileSync(consolidationState, 'utf8')).sessions)
    .some(progress => progress.last_processed_seq >= 0))

console.log('27.6 a later Session sees the automatically learned Memory')
const afterLearning = await runSession({ project: CONSOLIDATION_PROJECT, task: '装个依赖' })
check('the later Session runs', afterLearning.code === 0, afterLearning.stderr.slice(0, 400))
check('the index carries the automatically learned fact',
  requestText(afterLearning.log).includes('该项目使用 pnpm 管理依赖'),
  requestText(afterLearning.log).slice(0, 400))
check('a Session that learned nothing new calls no consolidation model',
  allRequests(afterLearning.log).filter(isConsolidationCall).length === 0)
check('the driver did not run in the second Session',
  !existsSync(`${afterLearning.log}.driver`))

console.log('27.3 user Memory reaches another project')
const userWrite = await runSession({
  project: PROJECT_A,
  task: '记住，我偏好中文解释',
  remember: { mode: 'add', content: '用户偏好中文解释，技术术语保留英文', scope: 'user', category: 'preference' },
})
check('the user Memory is written', userWrite.code === 0, userWrite.stderr.slice(0, 400))

console.log('27.2 another project sees its own Memory only')
const projectBWrite = await runSession({
  project: PROJECT_B,
  task: '记住，这个项目使用 npm',
  remember: { mode: 'add', content: '该项目使用 npm', scope: 'project', category: 'state' },
})
check('the second project records its own fact', projectBWrite.code === 0, projectBWrite.stderr.slice(0, 400))
const projectBSession = await runSession({ project: PROJECT_B, task: '装个依赖' })
check('the second project Session runs', projectBSession.code === 0, projectBSession.stderr.slice(0, 400))
const projectBRequest = requestText(projectBSession.log)
check('the second project sees its own fact', projectBRequest.includes('[state] 该项目使用 npm'))
check('the second project does not see the first project\'s fact', !projectBRequest.includes('该项目使用 pnpm'))
check('user Memory is visible from the second project', projectBRequest.includes('用户偏好中文解释'))

console.log('27.4 an explicit supersede retires the record it replaces')
const targetWrite = await runSession({
  project: PROJECT_C,
  task: '记住，这个项目使用 npm',
  remember: { mode: 'add', content: '该项目使用 npm', scope: 'project', category: 'state' },
})
check('the record to supersede is written', targetWrite.code === 0, targetWrite.stderr.slice(0, 400))
const seeded = recordsOf(projectIdFor(PROJECT_C)).find(record => record.content === '该项目使用 npm')
check('the record to supersede exists and is active',
  seeded?.status === 'active' && seeded?.superseded_by === null)
const superseded = await runSession({
  project: PROJECT_C,
  task: '记住，我们已经迁移到 pnpm',
  remember: { mode: 'supersede', content: '该项目已迁移到 pnpm' },
  supersede: true,
  // Phase 1 retrieval is keyword-based, so the scripted search asks for a term
  // the stored record actually contains.
  query: 'npm',
})
check('the supersede turn runs', superseded.code === 0, superseded.stderr.slice(0, 400))
const projectCRecords = recordsOf(projectIdFor(PROJECT_C))
const retired = projectCRecords.find(record => record.content === '该项目使用 npm')
const replacement = projectCRecords.find(record => record.content === '该项目已迁移到 pnpm')
check('the older record is retired', retired?.status === 'superseded')
check('the older record names its successor', retired?.superseded_by === replacement?.id)
check('the replacement is active', replacement?.status === 'active')
check('exactly one active record remains',
  projectCRecords.filter(record => record.status === 'active').length === 1)
const projectCSession = await runSession({ project: PROJECT_C, task: '装个依赖' })
check('the later Session runs', projectCSession.code === 0, projectCSession.stderr.slice(0, 400))
const projectCRequest = requestText(projectCSession.log)
check('the index shows the replacement', projectCRequest.includes('该项目已迁移到 pnpm'))
check('the index hides the retired fact', !projectCRequest.includes('该项目使用 npm'))

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
