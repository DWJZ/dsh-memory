/**
 * The plugin's own persisted switch.
 *
 * `enabled` lives in a file this plugin owns rather than in the profile's Cordis
 * patch, because persisting it through `ctx.settings` would require the
 * `volatile` field support of a vendored, private package — and a locally
 * installed plugin deliberately carries no runtime dependency. The Memory
 * directory already belongs to this plugin, so the switch lives beside it.
 *
 * The file wins over the deployment's `cordis.yml` value, because it records the
 * last explicit choice a user made with `/memory enable` or `/memory disable`.
 *
 * @module dsh-memory/settings
 */

import { existsSync, readFileSync } from 'node:fs'
import { writeAtomic } from './jsonstore.js'
import { pluginConfigPath } from './paths.js'

/**
 * Read this plugin's own configuration file.
 * @param memoryDir - the Memory root.
 * @returns the stored object, or an empty object when the file is absent.
 * @throws when the file exists but is not a JSON object.
 */
export function readPluginConfig(memoryDir) {
  const path = pluginConfigPath(memoryDir)
  if (!existsSync(path)) return {}
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`dsh-memory: ${path} is not valid JSON: ${String(error?.message ?? error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`dsh-memory: ${path} must hold a JSON object`)
  }
  return parsed
}

/**
 * Read the persisted switch.
 * @param memoryDir - the Memory root.
 * @returns the stored value, or undefined when nothing has been stored yet.
 */
export function readStoredEnabled(memoryDir) {
  const stored = readPluginConfig(memoryDir).enabled
  return typeof stored === 'boolean' ? stored : undefined
}

/**
 * Resolve the switch the plugin should run with.
 * @param memoryDir - the Memory root.
 * @param configured - the value from `cordis.yml`.
 * @returns the stored value when there is one, otherwise the configured value.
 */
export function resolveEnabled(memoryDir, configured) {
  return readStoredEnabled(memoryDir) ?? configured
}

/**
 * Persist the switch.
 * @param memoryDir - the Memory root.
 * @param enabled - the value to store.
 * @throws when the file cannot be written.
 */
export function writeEnabled(memoryDir, enabled) {
  const existing = readPluginConfig(memoryDir)
  writeAtomic(pluginConfigPath(memoryDir), `${JSON.stringify({ ...existing, enabled }, null, 2)}\n`)
}
