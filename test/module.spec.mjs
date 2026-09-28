/**
 * Plugin shape suite.
 *
 * The Loader reads these exports before any behaviour runs: a function plugin
 * named-exports `name` and `apply` and has no default export, and the module must
 * import without a harness package on the resolution path.
 *
 * Usage: `node test/module.spec.mjs`.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createStubContext } from './fixtures/stub-context.mjs'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const plugin = await import(pathToFileURL(join(PLUGIN, 'src/index.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-memory-module-'))

check('the plugin names itself', plugin.name === 'dsh-memory')
check('the plugin exports apply', typeof plugin.apply === 'function')
check('the plugin has no default export', plugin.default === undefined)
check('the plugin declares only its own exports',
  Object.keys(plugin).every(key => ['name', 'inject', 'apply'].includes(key)))
check('the plugin declares the command service it needs',
  Array.isArray(plugin.inject) && plugin.inject.includes('commands'))

const enabled = createStubContext()
plugin.apply(enabled, { dshHome: ROOT })
check('an enabled plugin registers its runtime', enabled.registrations.tools.length === 3)
check('an enabled plugin registers its command', enabled.registrations.commands.length === 1)

const disabled = createStubContext()
plugin.apply(disabled, { dshHome: ROOT, enabled: false })
check('a disabled plugin registers no tools', disabled.registrations.tools.length === 0)
check('a disabled plugin registers no index', disabled.registrations.contexts.length === 0)
check('a disabled plugin still registers its command', disabled.registrations.commands.length === 1)

const bad = createStubContext()
let rejected = false
try {
  plugin.apply(bad, { dshHome: ROOT, retrievalTopK: 0 })
} catch (error) {
  rejected = error instanceof TypeError
}
check('an unusable configuration fails loud at load', rejected)
check('a rejected load registers nothing', bad.registrations.tools.length === 0)

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
