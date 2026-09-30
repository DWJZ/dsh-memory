/**
 * Harness-home resolution.
 *
 * Memory belongs to the harness, not to a project, so its location is derived
 * from the harness home instead of being configurable: every run resolves
 * `resolveMemoryDir(resolveDshHome(...))`. A locally installed plugin imports
 * no harness package, so this mirrors `@deepseek-ai/dsh-home-paths` rather than
 * calling it, and follows the same precedence: explicit setting, then
 * `$DSH_HOME`, then `~/.dsh`.
 *
 * @module dsh-memory/paths
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isProjectId } from './schema.js'
import type { ScopeLayout } from './types/memory.js'

/**
 * Expand a leading `~` against the current user's home directory.
 * @param value - a path, possibly starting with `~`.
 * @returns the path with `~` and `~/` expanded; other paths are unchanged.
 */
export function expandHome(value: string): string {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * Resolve the harness home for one plugin instance.
 * @param configured - the `dshHome` setting, when the deployment set one.
 * @param env - environment to read `DSH_HOME` from.
 * @returns an absolute harness home.
 */
export function resolveDshHome(configured: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = nonEmpty(configured)
  if (explicit !== undefined) return resolve(expandHome(explicit))
  const fromEnv = nonEmpty(env.DSH_HOME)
  if (fromEnv !== undefined) return resolve(expandHome(fromEnv))
  return join(homedir(), '.dsh')
}

/**
 * Resolve the single directory that holds every scope's Memory.
 * @param dshHome - an absolute harness home, as returned by {@link resolveDshHome}.
 * @returns the absolute path of the Memory root, always below `dshHome`.
 */
export function resolveMemoryDir(dshHome: string): string {
  return join(resolve(expandHome(dshHome)), 'memory')
}

/**
 * Resolve the three files one scope owns inside its directory.
 * @param scopeDir - the directory holding one scope's Memory.
 * @returns the canonical store, its lock, and the generated view.
 */
export function scopeLayout(scopeDir: string): ScopeLayout {
  const dir = resolve(expandHome(scopeDir))
  return {
    dir,
    storePath: join(dir, 'memories.json'),
    lockPath: join(dir, 'memories.json.lock'),
    viewPath: join(dir, 'MEMORY.md'),
  }
}

/**
 * Resolve the registry file and its lock.
 * @param memoryDir - the Memory root.
 * @returns the registry path and its lock path.
 */
export function registryLayout(memoryDir: string) {
  const dir = resolve(expandHome(memoryDir))
  return {
    dir,
    registryPath: join(dir, 'registry.json'),
    lockPath: join(dir, 'registry.json.lock'),
  }
}

/**
 * Resolve the consolidation progress file and its lock.
 *
 * Progress lives beside the Memory it tracks so one harness home has one
 * answer to "how far has this Session been consolidated".
 * @param memoryDir - the Memory root.
 * @returns the state path and its lock path.
 */
export function consolidationLayout(memoryDir: string) {
  const dir = resolve(expandHome(memoryDir))
  return {
    dir,
    statePath: join(dir, 'consolidation-state.json'),
    lockPath: join(dir, 'consolidation-state.json.lock'),
  }
}

/**
 * Resolve one project's layout below the Memory root.
 *
 * A project id becomes a directory name, so it is checked here rather than
 * trusted: a registry that was edited by hand must not be able to point this
 * layout at a directory outside the Memory root.
 * @param memoryDir - the Memory root.
 * @param projectId - the project whose Memory this is.
 * @returns the store, lock, and view paths for that project.
 * @throws {TypeError} when the id is not a project id.
 */
export function projectLayout(memoryDir: string, projectId: string | null | undefined) {
  if (!isProjectId(projectId)) {
    throw new TypeError(`dsh-memory: project id must be a project id, got ${JSON.stringify(projectId)}`)
  }
  return scopeLayout(join(resolve(expandHome(memoryDir)), 'projects', projectId))
}

/**
 * Resolve the user scope's layout.
 * @param memoryDir - the Memory root.
 * @returns the store, lock, and view paths for user Memory.
 */
export function userLayout(memoryDir: string) {
  return scopeLayout(join(resolve(expandHome(memoryDir)), 'user'))
}

/**
 * Resolve the shared tombstone log and its lock.
 * @param memoryDir - the Memory root.
 * @returns the tombstone log path and its lock path.
 */
export function tombstoneLayout(memoryDir: string) {
  const dir = resolve(expandHome(memoryDir))
  return {
    path: join(dir, 'tombstones.jsonl'),
    lockPath: join(dir, 'tombstones.jsonl.lock'),
  }
}

/**
 * Resolve the file holding this plugin's own `enabled` switch.
 * @param memoryDir - the Memory root.
 * @returns the absolute path of the plugin's configuration file.
 */
export function pluginConfigPath(memoryDir: string) {
  return join(resolve(expandHome(memoryDir)), 'config.json')
}

/**
 * Read one optional non-empty string setting.
 * @param value - the raw setting.
 * @returns the trimmed value, or undefined when unset or blank.
 */
function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}
