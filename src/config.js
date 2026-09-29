/**
 * Plugin configuration: defaults, validation, and normalization.
 *
 * Every deployment-varying choice lives here so a deployment changes it from
 * `cordis.patch.yml` instead of editing code. Invalid values fail loud at load
 * and name the offending field; the cross-field rule a per-field schema cannot
 * express (the index budget split must sum to 1) is checked here too.
 *
 * `memoryDir` is deliberately absent: Memory must be under the harness home, so
 * the location is derived and a deployment cannot point it elsewhere.
 *
 * @module dsh-memory/config
 */

import { resolveDshHome, resolveMemoryDir } from './paths.js'

/** Every setting a deployment may override, with its default. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  dshHome: '',
  indexBudgetBytes: 6000,
  indexBudgetSplit: { user: 0.4, project: 0.6 },
  retrievalTopK: 8,
  projectRootMarkers: ['.git'],
  lockTimeoutMs: 10000,
  staleLockMs: 60000,
  maxEvidencePerMemory: 8,
  exportInlineMaxBytes: 24000,
  evidenceQuoteMaxChars: 200,
})

/** Tolerance for the floating-point index budget split sum. */
const SPLIT_TOLERANCE = 1e-9

/**
 * Normalize the plugin configuration, failing loud on an unusable value.
 * @param config - raw config object from cordis.yml, possibly absent.
 * @param env - environment used to resolve `$DSH_HOME`.
 * @returns the settings this plugin runs with, including the derived locations.
 */
export function resolveConfig(config, env = process.env) {
  const raw = config ?? {}
  const dshHome = resolveDshHome(raw.dshHome, env)
  return {
    enabled: booleanSetting(raw.enabled, DEFAULTS.enabled, 'enabled'),
    dshHome,
    memoryDir: resolveMemoryDir(dshHome),
    indexBudgetBytes: integerSetting(raw.indexBudgetBytes, DEFAULTS.indexBudgetBytes, 'indexBudgetBytes', 0),
    indexBudgetSplit: splitSetting(raw.indexBudgetSplit),
    retrievalTopK: integerSetting(raw.retrievalTopK, DEFAULTS.retrievalTopK, 'retrievalTopK', 1),
    projectRootMarkers: markersSetting(raw.projectRootMarkers),
    lockTimeoutMs: integerSetting(raw.lockTimeoutMs, DEFAULTS.lockTimeoutMs, 'lockTimeoutMs', 1),
    staleLockMs: integerSetting(raw.staleLockMs, DEFAULTS.staleLockMs, 'staleLockMs', 1),
    maxEvidencePerMemory: integerSetting(raw.maxEvidencePerMemory, DEFAULTS.maxEvidencePerMemory, 'maxEvidencePerMemory', 1),
    exportInlineMaxBytes: integerSetting(raw.exportInlineMaxBytes, DEFAULTS.exportInlineMaxBytes, 'exportInlineMaxBytes', 1),
    evidenceQuoteMaxChars: integerSetting(raw.evidenceQuoteMaxChars, DEFAULTS.evidenceQuoteMaxChars, 'evidenceQuoteMaxChars', 0),
  }
}

/**
 * Read one counted or measured setting.
 *
 * Bytes, entries, results, and milliseconds are all counts: a fractional value
 * would be silently truncated somewhere downstream, so it is refused here where
 * the deployment can see why.
 * @param value - raw value from cordis.yml.
 * @param fallback - value used when the setting is absent.
 * @param field - setting name, named in the failure.
 * @param minimum - smallest accepted value.
 * @returns the validated integer.
 */
function integerSetting(value, fallback, field, minimum) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < minimum) {
    throw new TypeError(`dsh-memory: config ${field} must be an integer >= ${String(minimum)}, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read one boolean setting.
 * @param value - raw value from cordis.yml.
 * @param fallback - value used when the setting is absent.
 * @param field - setting name, named in the failure.
 * @returns the validated boolean.
 */
function booleanSetting(value, fallback, field) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') {
    throw new TypeError(`dsh-memory: config ${field} must be a boolean, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read one numeric setting.
 * @param value - raw value from cordis.yml.
 * @param fallback - value used when the setting is absent.
 * @param field - setting name, named in the failure.
 * @param minimum - smallest accepted value.
 * @returns the validated number.
 */
function numberSetting(value, fallback, field, minimum) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) {
    throw new TypeError(`dsh-memory: config ${field} must be a number >= ${String(minimum)}, got ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * Read the index budget split, which must be non-negative and sum to 1.
 * @param value - raw value from cordis.yml.
 * @returns the validated split.
 */
function splitSetting(value) {
  if (value === undefined) return { ...DEFAULTS.indexBudgetSplit }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`dsh-memory: config indexBudgetSplit must be an object, got ${JSON.stringify(value)}`)
  }
  const user = numberSetting(value.user, DEFAULTS.indexBudgetSplit.user, 'indexBudgetSplit.user', 0)
  const project = numberSetting(value.project, DEFAULTS.indexBudgetSplit.project, 'indexBudgetSplit.project', 0)
  if (Math.abs(user + project - 1) >= SPLIT_TOLERANCE) {
    throw new TypeError(`dsh-memory: config indexBudgetSplit must sum to 1, got ${String(user + project)}`)
  }
  return { user, project }
}

/**
 * Read the project root markers.
 * @param value - raw value from cordis.yml.
 * @returns the validated marker list.
 */
function markersSetting(value) {
  if (value === undefined) return [...DEFAULTS.projectRootMarkers]
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`dsh-memory: config projectRootMarkers must be a non-empty array, got ${JSON.stringify(value)}`)
  }
  for (const marker of value) {
    if (typeof marker !== 'string' || marker.trim() === '' || marker.includes('/')) {
      throw new TypeError(`dsh-memory: config projectRootMarkers entries must be non-empty file names, got ${JSON.stringify(marker)}`)
    }
  }
  return [...value]
}
