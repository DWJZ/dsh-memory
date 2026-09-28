/**
 * Harness-home resolution suite.
 *
 * The point of these assertions is the contract's first rule: Memory belongs to
 * the harness, so its directory is derived from the harness home and cannot be
 * pointed somewhere else by configuration.
 *
 * Usage: `node test/paths.spec.mjs`.
 */
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const paths = await import(pathToFileURL(join(PLUGIN, 'src/paths.js')).href)
const config = await import(pathToFileURL(join(PLUGIN, 'src/config.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

console.log('harness home precedence')
check('an explicit setting wins over the environment',
  paths.resolveDshHome('/explicit/home', { DSH_HOME: '/from/env' }) === '/explicit/home')
check('$DSH_HOME wins over the default',
  paths.resolveDshHome(undefined, { DSH_HOME: '/from/env' }) === '/from/env')
check('the default is the user home plus .dsh',
  paths.resolveDshHome(undefined, {}) === join(homedir(), '.dsh'))
check('a blank setting falls through to the environment',
  paths.resolveDshHome('   ', { DSH_HOME: '/from/env' }) === '/from/env')
check('a blank environment value falls through to the default',
  paths.resolveDshHome(undefined, { DSH_HOME: '  ' }) === join(homedir(), '.dsh'))
check('a non-string environment value falls through to the default',
  paths.resolveDshHome(undefined, { DSH_HOME: undefined }) === join(homedir(), '.dsh'))

console.log('home expansion and normalization')
check('a bare ~ expands to the user home',
  paths.resolveDshHome('~', {}) === homedir())
check('a ~/ prefix expands to the user home',
  paths.resolveDshHome('~/harness', {}) === join(homedir(), 'harness'))
check('a relative setting becomes absolute',
  paths.resolveDshHome('relative/home', {}) === resolve('relative/home'))

console.log('memory_always_under_dsh_home')
const HOMES = ['/tmp/dsh-memory-home', '/tmp/with space', join(homedir(), 'nested')]
for (const home of HOMES) {
  const memoryDir = paths.resolveMemoryDir(home)
  check(`${home} resolves memory below the harness home`,
    memoryDir === join(resolve(home), 'memory') && memoryDir.startsWith(`${resolve(home)}${sep}`))
}
check('the resolved memory dir follows the resolved harness home',
  config.resolveConfig({}, { DSH_HOME: '/tmp/env-home' }).memoryDir === join('/tmp/env-home', 'memory'))
check('an explicit dshHome decides the memory dir',
  config.resolveConfig({ dshHome: '/tmp/set-home' }, { DSH_HOME: '/tmp/env-home' }).memoryDir === join('/tmp/set-home', 'memory'))

console.log('memoryDir is not a public setting')
check('a supplied memoryDir has no effect',
  config.resolveConfig({ memoryDir: '/tmp/elsewhere' }, {}).memoryDir === join(homedir(), '.dsh', 'memory'))
check('memoryDir is not among the documented defaults',
  !Object.hasOwn(config.DEFAULTS, 'memoryDir'))

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
