/**
 * Concurrent project registration suite.
 *
 * Two harness processes opening the same new directory must agree on one project
 * id. Checking and creating under one registry lock is what makes that true, so
 * this suite runs real processes and then shows the hazard it prevents.
 *
 * Usage: `node test/registry-concurrent.spec.mjs`.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { readRegistry } = await import(pathToFileURL(join(PLUGIN, 'src/registry.js')).href)
const { registryLayout } = await import(pathToFileURL(join(PLUGIN, 'src/paths.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-memory-registry-concurrent-'))
const MEMORY = join(ROOT, 'memory')
mkdirSync(MEMORY, { recursive: true })
const LAYOUT = registryLayout(MEMORY)
const WORKSPACE = join(ROOT, 'workspace')
mkdirSync(WORKSPACE, { recursive: true })

/**
 * Run one worker process and collect the project id it printed.
 * @param script - the fixture to run.
 * @param args - arguments after the script path.
 * @returns the parsed worker report.
 */
function runWorker(script, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [join(PLUGIN, 'test/fixtures', script), ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', rejectRun)
    child.on('close', code => {
      if (code !== 0) {
        rejectRun(new Error(`worker ${script} exited ${String(code)}: ${stderr}`))
        return
      }
      resolveRun(JSON.parse(stdout.trim()))
    })
  })
}

console.log('project_concurrent_auto_register_single_id')
let lockedReports
let lockedFailure
try {
  lockedReports = await Promise.all([1, 2, 3].map(() => runWorker(
    'registry-worker.mjs',
    [LAYOUT.registryPath, LAYOUT.lockPath, WORKSPACE],
  )))
} catch (error) {
  lockedFailure = error
}
check('every registration process exits successfully', lockedFailure === undefined, String(lockedFailure?.message ?? ''))
const ids = new Set((lockedReports ?? []).map(report => report.project_id))
check('three racing processes agree on one project id', ids.size === 1, `${String(ids.size)} distinct ids`)
check('exactly one process created the project',
  (lockedReports ?? []).filter(report => report.created).length === 1)
const stored = readRegistry(LAYOUT.registryPath)
check('the registry holds exactly one project', stored.projects.length === 1)
check('the stored project is the one every process reported',
  stored.projects[0].project_id === (lockedReports ?? [])[0]?.project_id)

console.log('negative control: without the lock two ids appear')
const UNSAFE_MEMORY = join(ROOT, 'unsafe-memory')
mkdirSync(UNSAFE_MEMORY, { recursive: true })
const UNSAFE = registryLayout(UNSAFE_MEMORY)
let unsafeReports
let unsafeFailure
try {
  unsafeReports = await Promise.all([1, 2].map(() => runWorker(
    'registry-worker-unsafe.mjs',
    [UNSAFE.registryPath, WORKSPACE, '80'],
  )))
} catch (error) {
  unsafeFailure = error
}
check('the lock-free control processes run', unsafeFailure === undefined, String(unsafeFailure?.message ?? ''))
const unsafeStored = unsafeFailure === undefined ? readRegistry(UNSAFE.registryPath) : undefined
check('without the lock two project ids are minted',
  new Set((unsafeReports ?? []).map(report => report.project_id)).size === 2)
check('without the lock one registration is lost entirely',
  unsafeStored?.projects.length === 1, `${String(unsafeStored?.projects.length)} projects`)
check('the surviving project is only one of the two reported',
  (unsafeReports ?? []).filter(report => report.project_id === unsafeStored?.projects[0]?.project_id).length === 1)

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
