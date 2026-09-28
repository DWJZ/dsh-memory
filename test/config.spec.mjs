/**
 * Configuration suite: defaults, fail-loud validation, and the cross-field rule
 * a per-field schema cannot express.
 *
 * Usage: `node test/config.spec.mjs`.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { DEFAULTS, resolveConfig } = await import(pathToFileURL(join(PLUGIN, 'src/config.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

/** Whether resolving this config throws a TypeError, and whether it names the field. */
const rejects = (raw, field) => {
  try {
    resolveConfig(raw, {})
    return false
  } catch (error) {
    return error instanceof TypeError && (field === undefined || error.message.includes(field))
  }
}

/** Resolve with a fixed environment so assertions never read this machine's home. */
const resolveWith = raw => resolveConfig(raw, { DSH_HOME: '/tmp/dsh-memory-config-spec' })

console.log('defaults')
const base = resolveWith({})
check('enabled defaults to true', base.enabled === true)
check('the memory root is derived', base.memoryDir === join('/tmp/dsh-memory-config-spec', 'memory'))
check('the index budget defaults to 6000 bytes', base.indexBudgetBytes === 6000)
check('the split defaults to 0.4 / 0.6',
  base.indexBudgetSplit.user === 0.4 && base.indexBudgetSplit.project === 0.6)
check('retrievalTopK defaults to 8', base.retrievalTopK === 8)
check('projectRootMarkers defaults to .git',
  base.projectRootMarkers.length === 1 && base.projectRootMarkers[0] === '.git')
check('every documented default is resolved',
  Object.keys(DEFAULTS).every(key => base[key] !== undefined))

console.log('every default is overridable')
const overridden = resolveWith({
  enabled: false,
  indexBudgetBytes: 1234,
  indexBudgetSplit: { user: 0.25, project: 0.75 },
  retrievalTopK: 3,
  projectRootMarkers: ['.git', '.hg'],
  lockTimeoutMs: 250,
  staleLockMs: 500,
  maxEvidencePerMemory: 2,
  exportInlineMaxBytes: 999,
  evidenceQuoteMaxChars: 10,
})
check('enabled', overridden.enabled === false)
check('indexBudgetBytes', overridden.indexBudgetBytes === 1234)
check('indexBudgetSplit', overridden.indexBudgetSplit.user === 0.25 && overridden.indexBudgetSplit.project === 0.75)
check('retrievalTopK', overridden.retrievalTopK === 3)
check('projectRootMarkers', overridden.projectRootMarkers.join(',') === '.git,.hg')
check('lockTimeoutMs', overridden.lockTimeoutMs === 250)
check('staleLockMs', overridden.staleLockMs === 500)
check('maxEvidencePerMemory', overridden.maxEvidencePerMemory === 2)
check('exportInlineMaxBytes', overridden.exportInlineMaxBytes === 999)
check('evidenceQuoteMaxChars', overridden.evidenceQuoteMaxChars === 10)

console.log('invalid values fail loud and name the field')
check('enabled rejects a non-boolean', rejects({ enabled: 'yes' }, 'enabled'))
check('indexBudgetBytes rejects a negative value', rejects({ indexBudgetBytes: -1 }, 'indexBudgetBytes'))
check('retrievalTopK rejects zero', rejects({ retrievalTopK: 0 }, 'retrievalTopK'))
check('retrievalTopK rejects a fraction below the minimum', rejects({ retrievalTopK: 0.5 }, 'retrievalTopK'))
check('lockTimeoutMs rejects zero', rejects({ lockTimeoutMs: 0 }, 'lockTimeoutMs'))
check('staleLockMs rejects a negative value', rejects({ staleLockMs: -5 }, 'staleLockMs'))
check('maxEvidencePerMemory rejects zero', rejects({ maxEvidencePerMemory: 0 }, 'maxEvidencePerMemory'))
check('exportInlineMaxBytes rejects zero', rejects({ exportInlineMaxBytes: 0 }, 'exportInlineMaxBytes'))
check('evidenceQuoteMaxChars rejects a negative value', rejects({ evidenceQuoteMaxChars: -1 }, 'evidenceQuoteMaxChars'))
check('a numeric field rejects NaN', rejects({ indexBudgetBytes: Number.NaN }, 'indexBudgetBytes'))
check('a numeric field rejects Infinity', rejects({ indexBudgetBytes: Number.POSITIVE_INFINITY }, 'indexBudgetBytes'))
check('projectRootMarkers rejects an empty array', rejects({ projectRootMarkers: [] }, 'projectRootMarkers'))
check('projectRootMarkers rejects a blank marker', rejects({ projectRootMarkers: [''] }, 'projectRootMarkers'))
check('projectRootMarkers rejects a path', rejects({ projectRootMarkers: ['etc/git'] }, 'projectRootMarkers'))
check('projectRootMarkers rejects a non-array', rejects({ projectRootMarkers: '.git' }, 'projectRootMarkers'))

console.log('indexBudgetSplit sums to 1 within tolerance')
check('0.4 / 0.6 is accepted', resolveWith({ indexBudgetSplit: { user: 0.4, project: 0.6 } }).indexBudgetSplit.project === 0.6)
check('0.5 / 0.5 is accepted', resolveWith({ indexBudgetSplit: { user: 0.5, project: 0.5 } }).indexBudgetSplit.user === 0.5)
check('0.1 / 0.2 + 0.7 is accepted within tolerance',
  resolveWith({ indexBudgetSplit: { user: 0.30000000000000004, project: 0.7 } }).indexBudgetSplit.user > 0.3)
check('0.4 / 0.5 is rejected', rejects({ indexBudgetSplit: { user: 0.4, project: 0.5 } }, 'sum to 1'))
check('0.9 / 0.9 is rejected', rejects({ indexBudgetSplit: { user: 0.9, project: 0.9 } }, 'sum to 1'))
check('a negative share is rejected', rejects({ indexBudgetSplit: { user: -0.1, project: 1.1 } }, 'indexBudgetSplit.user'))
check('a non-object split is rejected', rejects({ indexBudgetSplit: 1 }, 'indexBudgetSplit'))
check('an array split is rejected', rejects({ indexBudgetSplit: [0.4, 0.6] }, 'indexBudgetSplit'))

console.log('resolution does not mutate the caller or the defaults')
const raw = { indexBudgetSplit: { user: 0.5, project: 0.5 }, projectRootMarkers: ['.git'] }
const once = resolveConfig(raw, {})
raw.projectRootMarkers.push('.hg')
raw.indexBudgetSplit.user = 0.9
check('a resolved marker list is a copy', once.projectRootMarkers.length === 1)
check('a resolved split is a copy', once.indexBudgetSplit.user === 0.5)
check('the module defaults are untouched',
  DEFAULTS.indexBudgetSplit.user === 0.4 && DEFAULTS.projectRootMarkers.length === 1)

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
