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

import { MIN_TRAJECTORY_BYTES_PER_BATCH } from './consolidation/normalize.js'
import { resolveDshHome, resolveMemoryDir } from './paths.js'
import type { PluginConfig } from './settings.js'
import type { MemoryConsolidationSettings, MemoryLogger, MemorySettings } from './types/config.js'
import { hostname } from 'node:os'

/** Every setting a deployment may override, with its default. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  dshHome: '',
  indexBudgetBytes: 6000,
  indexBudgetSplit: { user: 0.4, project: 0.6 },
  retrievalTopK: 8,
  // The same list `@deepseek-ai/dsh-agent-instructions` resolves a project root
  // with. A local plugin cannot read that resolved config, so the two are kept in
  // step by naming the same field and changing it in the same place: if they
  // disagree, the harness and Memory disagree about what a project is.
  /**
   * Whether this plugin may write rows into the Session log at all.
   *
   * Off by default. The harness does not offer third-party plugins a supported
   * way to append Session events: this uses an unknown type carrying the
   * envelope's `ignorable` marker, which a reader accepts only when it does not
   * know the type. That is a side door rather than an interface, so a deployment
   * opts in rather than discovering rows it never asked for.
   */
  sessionEvents: false,
  projectRootMarkers: ['.git'],
  lockTimeoutMs: 10000,
  staleLockMs: 60000,
  maxEvidencePerMemory: 8,
  exportInlineMaxBytes: 24000,
  evidenceQuoteMaxChars: 200,
  consolidation: Object.freeze({
    enabled: true,
    autoCommit: true,
    debounceMs: 10000,
    minConfidence: 0.8,
    maxRelevantEventsPerBatch: 200,
    maxTrajectoryBytesPerBatch: 65536,
    maxOutputTokens: 2048,
  }),
})

/** Tolerance for the floating-point index budget split sum. */
const SPLIT_TOLERANCE = 1e-9

/**
 * Normalize the plugin configuration, failing loud on an unusable value.
 * @param config - raw config object from cordis.yml, possibly absent.
 * @param env - environment used to resolve `$DSH_HOME`.
 * @returns the settings this plugin runs with, including the derived locations.
 */
export function resolveConfig(
  config: PluginConfig,
  env: NodeJS.ProcessEnv = process.env,
  logger?: MemoryLogger,
): MemorySettings {
  const raw = config ?? {}
  const dshHome = resolveDshHome(raw.dshHome, env)
  return {
    enabled: booleanSetting(raw.enabled, DEFAULTS.enabled, 'enabled'),
    sessionEvents: booleanSetting(raw.sessionEvents, DEFAULTS.sessionEvents, 'sessionEvents'),
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
    consolidation: consolidationSetting(raw.consolidation),
    host: hostSetting(raw.host),
    kill: process.kill,
    logger,
  }
}

/**
 * The host name to record.
 *
 * A deployment that shares a Memory root names its hosts; anything else is the
 * machine's own name.
 * @param value - the configured value, if any.
 * @returns the name to record.
 */
function hostSetting(value: unknown): string {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  return hostname()
}

/**
 * Read the automatic-consolidation settings.
 *
 * Nested rather than flat because they answer one question together, and because
 * a deployment that turns consolidation off should not have to restate the six
 * numbers it no longer uses.
 * @param value - raw value from cordis.yml.
 * @returns the validated settings.
 * @throws {TypeError} when a field is present and unusable.
 */
function consolidationSetting(value: unknown): MemoryConsolidationSettings {
  const fallback = DEFAULTS.consolidation
  if (value === undefined) return { ...fallback }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`dsh-memory: config consolidation must be an object, got ${JSON.stringify(value)}`)
  }
  // Configuration arrives unvalidated; each field is narrowed where it is read.
  const source = value as Record<string, unknown>
  const minConfidence = numberSetting(source.minConfidence, fallback.minConfidence, 'consolidation.minConfidence', 0)
  if (minConfidence > 1) {
    throw new TypeError(`dsh-memory: config consolidation.minConfidence must be at most 1, got ${JSON.stringify(source.minConfidence)}`)
  }
  return {
    enabled: booleanSetting(source.enabled, fallback.enabled, 'consolidation.enabled'),
    autoCommit: booleanSetting(source.autoCommit, fallback.autoCommit, 'consolidation.autoCommit'),
    debounceMs: integerSetting(source.debounceMs, fallback.debounceMs, 'consolidation.debounceMs', 0),
    minConfidence,
    maxRelevantEventsPerBatch: integerSetting(source.maxRelevantEventsPerBatch, fallback.maxRelevantEventsPerBatch, 'consolidation.maxRelevantEventsPerBatch', 1),
    maxTrajectoryBytesPerBatch: integerSetting(source.maxTrajectoryBytesPerBatch, fallback.maxTrajectoryBytesPerBatch, 'consolidation.maxTrajectoryBytesPerBatch', MIN_TRAJECTORY_BYTES_PER_BATCH),
    maxOutputTokens: integerSetting(source.maxOutputTokens, fallback.maxOutputTokens, 'consolidation.maxOutputTokens', 1),
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
function integerSetting(value: unknown, fallback: number, field: string, minimum: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
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
function booleanSetting(value: unknown, fallback: boolean, field: string): boolean {
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
function numberSetting(value: unknown, fallback: number, field: string, minimum: number): number {
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
function splitSetting(value: unknown): { user: number; project: number } {
  const source = value as Record<string, unknown>
  if (value === undefined) return { ...DEFAULTS.indexBudgetSplit }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`dsh-memory: config indexBudgetSplit must be an object, got ${JSON.stringify(value)}`)
  }
  const user = numberSetting(source.user, DEFAULTS.indexBudgetSplit.user, 'indexBudgetSplit.user', 0)
  const project = numberSetting(source.project, DEFAULTS.indexBudgetSplit.project, 'indexBudgetSplit.project', 0)
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
function markersSetting(value: unknown): string[] {
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
