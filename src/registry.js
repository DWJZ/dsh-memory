/**
 * Stable project identity.
 *
 * A project is identified by an id, never by its path: projects move, and a
 * record that stored a path would go stale the moment one did. The registry maps
 * paths to ids, and stores every path as a normalized absolute lexical path so a
 * path that no longer exists (a relink's old root) stays resolvable as history
 * instead of failing a `realpath` call.
 *
 * Resolution has four steps, and the second one may *create* a project: a
 * workspace that is not a Git repository still deserves project Memory. Because
 * two harness processes can open the same new directory at once, checking and
 * creating happen inside one registry lock — otherwise both would mint an id.
 *
 * @module dsh-memory/registry
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { writeAtomic } from './jsonstore.js'
import { withLock } from './lock.js'
import { newProjectId, isProjectId, isTimestamp } from './schema.js'

/** Registry format version this build writes; an unknown version is refused. */
export const REGISTRY_SCHEMA_VERSION = 1

/**
 * Build an empty registry.
 * @returns a registry with no projects.
 */
export function emptyRegistry() {
  return { schema_version: REGISTRY_SCHEMA_VERSION, revision: 0, projects: [] }
}

/**
 * Read the project registry and validate every entry it holds.
 *
 * Registry entries decide which directory a project's Memory lives in, so a
 * document that was edited by hand or left by an older build is refused here
 * rather than trusted downstream.
 * @param registryPath - absolute path of `registry.json`.
 * @returns the stored registry, or an empty one when the file is absent.
 * @throws when the file is unreadable, malformed, or violates the entry schema.
 */
export function readRegistry(registryPath) {
  if (!existsSync(registryPath)) return emptyRegistry()
  let parsed
  try {
    parsed = JSON.parse(readFileSync(registryPath, 'utf8'))
  } catch (error) {
    throw new Error(`dsh-memory: ${registryPath} is not valid JSON: ${String(error?.message ?? error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`dsh-memory: ${registryPath} must hold a JSON object`)
  }
  if (parsed.schema_version !== REGISTRY_SCHEMA_VERSION) {
    throw new Error(`dsh-memory: ${registryPath} has schema_version ${JSON.stringify(parsed.schema_version)}, this build writes ${String(REGISTRY_SCHEMA_VERSION)}`)
  }
  if (!Number.isInteger(parsed.revision) || parsed.revision < 0) {
    throw new Error(`dsh-memory: ${registryPath} has an invalid revision ${JSON.stringify(parsed.revision)}`)
  }
  if (!Array.isArray(parsed.projects)) {
    throw new Error(`dsh-memory: ${registryPath} must hold a projects array`)
  }
  validateRegistry(parsed)
  return parsed
}

/**
 * Validate every project entry of one registry document.
 *
 * Uniqueness of the lexical roots is part of the schema rather than a
 * convention: the resolver picks the longest ancestor, so two projects claiming
 * one path would make which project a session belongs to depend on array order.
 * @param registry - the parsed registry document.
 * @throws {TypeError} when any entry is invalid or two entries claim one path.
 */
export function validateRegistry(registry) {
  const ids = new Set()
  const roots = new Map()
  for (const entry of registry.projects) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new TypeError('dsh-memory: a registry entry must be an object')
    }
    if (!isProjectId(entry.project_id)) {
      throw new TypeError(`dsh-memory: project_id must be a project id, got ${JSON.stringify(entry.project_id)}`)
    }
    if (ids.has(entry.project_id)) {
      throw new TypeError(`dsh-memory: project ${entry.project_id} appears more than once`)
    }
    ids.add(entry.project_id)
    if (typeof entry.canonical_root !== 'string' || !isAbsolute(entry.canonical_root)) {
      throw new TypeError(`dsh-memory: project ${entry.project_id} must have an absolute canonical_root, got ${JSON.stringify(entry.canonical_root)}`)
    }
    for (const field of ['aliases', 'workspace_ids']) {
      if (!Array.isArray(entry[field]) || entry[field].some(value => typeof value !== 'string')) {
        throw new TypeError(`dsh-memory: project ${entry.project_id} ${field} must be an array of strings`)
      }
    }
    for (const root of projectRoots(entry)) {
      if (!isAbsolute(root)) {
        throw new TypeError(`dsh-memory: project ${entry.project_id} has a non-absolute root ${JSON.stringify(root)}`)
      }
      const owner = roots.get(root)
      if (owner !== undefined && owner !== entry.project_id) {
        throw new TypeError(`dsh-memory: ${root} is claimed by both ${owner} and ${entry.project_id}`)
      }
      roots.set(root, entry.project_id)
    }
    for (const field of ['created_at', 'updated_at']) {
      if (!isTimestamp(entry[field])) {
        throw new TypeError(`dsh-memory: project ${entry.project_id} ${field} must be an ISO-8601 UTC timestamp`)
      }
    }
  }
}

/**
 * Every path one project entry owns.
 * @param entry - one registry entry.
 * @returns the canonical root followed by its aliases.
 */
export function projectRoots(entry) {
  return [entry.canonical_root, ...entry.aliases]
}

/**
 * Resolve a path to its real identity, when it exists.
 * @param path - the path to resolve.
 * @param deps - filesystem seams, injectable for tests.
 * @returns the real path, or undefined when the path does not exist.
 */
export function realIdentity(path, deps = {}) {
  const realpath = deps.realpath ?? realpathSync
  try {
    return realpath(path)
  } catch {
    return undefined
  }
}

/**
 * Find the project that already owns one path.
 *
 * Ownership is tested on two keys: the normalized absolute lexical path, which
 * works for a root that no longer exists, and the real path identity, which
 * catches two different lexical paths that are the same directory through a
 * symlink.
 * @param projects - every registry entry.
 * @param candidate - the path to look up.
 * @param deps - filesystem seams, injectable for tests.
 * @returns the owning entry, or undefined when no project owns the path.
 */
export function ownerOf(projects, candidate, deps = {}) {
  const lexical = resolve(candidate)
  const real = realIdentity(candidate, deps)
  for (const entry of projects) {
    for (const stored of projectRoots(entry)) {
      if (resolve(stored) === lexical) return entry
      if (real === undefined) continue
      const storedReal = realIdentity(stored, deps)
      if (storedReal !== undefined && storedReal === real) return entry
    }
  }
  return undefined
}

/**
 * Find the project whose root is the longest ancestor of one working directory.
 *
 * A session usually runs in a subdirectory of its project, so the match is an
 * ancestor match rather than equality; taking the longest root makes a nested
 * project win over the outer one that contains it. A root that no longer exists
 * cannot match a working directory and is skipped.
 * @param projects - every registry entry.
 * @param cwd - the session working directory.
 * @param deps - filesystem seams, injectable for tests.
 * @returns the matching entry, or undefined when no project contains the directory.
 */
export function matchProject(projects, cwd, deps = {}) {
  const exists = deps.exists ?? existsSync
  const cwdReal = realIdentity(cwd, deps)
  if (cwdReal === undefined) return undefined
  let best
  let bestLength = -1
  for (const entry of projects) {
    for (const stored of projectRoots(entry)) {
      if (!exists(stored)) continue
      const rootReal = realIdentity(stored, deps)
      if (rootReal === undefined) continue
      const rel = relative(rootReal, cwdReal)
      const contains = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
      if (!contains) continue
      if (rootReal.length > bestLength) {
        best = entry
        bestLength = rootReal.length
      } else if (rootReal.length === bestLength && best !== undefined && entry.project_id < best.project_id) {
        best = entry
      }
    }
  }
  return best
}

/**
 * Walk up from one directory to the nearest project root marker.
 * @param cwd - the directory to start from.
 * @param markers - file or directory names that identify a project root.
 * @param deps - filesystem seams, injectable for tests.
 * @returns the marker directory, or undefined when none is found.
 */
export function findProjectRoot(cwd, markers, deps = {}) {
  const exists = deps.exists ?? existsSync
  let current = resolve(cwd)
  for (;;) {
    if (markers.some(marker => exists(join(current, marker)))) return current
    const parent = resolve(current, '..')
    if (parent === current) return undefined
    current = parent
  }
}

/**
 * Resolve the project for one directory, registering it when it is new.
 *
 * The existence check happens after the ownership check on purpose: a path that
 * a relink turned into a stale alias still belongs to its project even though it
 * is no longer on disk.
 * @param options - registry location, lock thresholds, and logger.
 * @param options.registryPath - absolute path of `registry.json`.
 * @param options.lockPath - absolute path of the registry lock file.
 * @param options.lockTimeoutMs - how long to wait for the registry lock.
 * @param options.staleLockMs - age at which a lock becomes reclaimable.
 * @param root - the directory to register.
 * @param workspaceId - the workspace that prompted this lookup, when one is known.
 * @returns the owning project and whether this call created it.
 * @throws when the directory does not exist and no project owns it.
 */
export async function resolveOrRegisterProject(options, root, workspaceId) {
  const requested = resolve(root)
  return withLock(options, () => {
    const registry = readRegistry(options.registryPath)
    const existing = ownerOf(registry.projects, requested, options)
    if (existing !== undefined) {
      const adopted = adoptWorkspace(existing, workspaceId, options)
      if (adopted !== existing) {
        commit(options, registry, registry.projects.map(entry => entry.project_id === existing.project_id ? adopted : entry))
      }
      return { project: describeProject(adopted, options), created: false }
    }
    if (!existsSync(requested)) {
      throw new Error(`dsh-memory: cannot register ${requested}: it does not exist`)
    }
    const at = nowIso(options)
    const entry = {
      project_id: newProjectId(),
      canonical_root: requested,
      aliases: [],
      workspace_ids: workspaceId === undefined ? [] : [workspaceId],
      created_at: at,
      updated_at: at,
    }
    commit(options, registry, [...registry.projects, entry])
    return { project: describeProject(entry, options), created: true }
  })
}

/**
 * Resolve the project one session works in, following the contract's order.
 * @param options - registry location, lock thresholds, marker names, and logger.
 * @param options.registryPath - absolute path of `registry.json`.
 * @param options.lockPath - absolute path of the registry lock file.
 * @param options.lockTimeoutMs - how long to wait for the registry lock.
 * @param options.staleLockMs - age at which a lock becomes reclaimable.
 * @param options.projectRootMarkers - names that identify a project root.
 * @param request - the session's location and the workspace it belongs to.
 * @param request.cwd - the session working directory.
 * @param request.workspaceRoot - a known workspace root, when the runtime has one.
 * @param request.workspaceId - that workspace's id, when known.
 * @returns the project, or null when the session has no project scope.
 */
export async function resolveProject(options, request) {
  const cwd = resolve(request.cwd)
  const registry = readRegistry(options.registryPath)
  const known = matchProject(registry.projects, cwd, options)
  if (known !== undefined) return describeProject(known, options)

  if (request.workspaceRoot !== undefined) {
    const workspace = await resolveOrRegisterProject(options, request.workspaceRoot, request.workspaceId)
    return workspace.project
  }

  const markerRoot = findProjectRoot(cwd, options.projectRootMarkers ?? ['.git'], options)
  if (markerRoot === undefined) return null
  const discovered = await resolveOrRegisterProject(options, markerRoot, request.workspaceId)
  return discovered.project
}

/**
 * Bind a directory to a project, returning the existing one when it is known.
 * @param options - registry location, lock thresholds, and logger.
 * @param path - the directory to bind.
 * @returns the bound project and whether this call created it.
 */
export async function bindProject(options, path) {
  return resolveOrRegisterProject(options, path)
}

/**
 * Point a project at the directory it now lives in.
 *
 * The old path is matched lexically against what the registry stored rather than
 * resolved on disk: the whole reason to relink is that the old directory is
 * gone, so requiring it to exist would make the command unusable exactly when it
 * is needed.
 * @param options - registry location, lock thresholds, and logger.
 * @param oldPath - the directory the project used to live in.
 * @param newPath - the directory it lives in now; must exist.
 * @returns the updated project.
 * @throws when no project owns the old path, or another project owns the new one.
 */
export async function relinkProject(options, oldPath, newPath) {
  const previous = resolve(oldPath)
  const next = resolve(newPath)
  return withLock(options, () => {
    const registry = readRegistry(options.registryPath)
    const found = locateForRelink(registry.projects, previous, options)
    if (found === undefined) {
      throw new Error(`dsh-memory: no project is registered at ${previous}`)
    }
    if (!existsSync(next)) {
      throw new Error(`dsh-memory: cannot relink to ${next}: it does not exist`)
    }
    const conflicting = ownerOf(registry.projects, next, options)
    if (conflicting !== undefined && conflicting.project_id !== found.project_id) {
      throw new Error(`dsh-memory: ${next} already belongs to project ${conflicting.project_id}`)
    }
    if (previous === next) return { project: describeProject(found, options), changed: false }

    const aliases = [...new Set([...found.aliases, previous])].filter(alias => alias !== next)
    const updated = { ...found, canonical_root: next, aliases, updated_at: nowIso(options) }
    commit(options, registry, registry.projects.map(entry => entry.project_id === found.project_id ? updated : entry))
    return { project: describeProject(updated, options), changed: true }
  })
}

/**
 * Read every registered project for display.
 * @param registryPath - absolute path of `registry.json`.
 * @param deps - filesystem seams, injectable for tests.
 * @returns each project with its roots and which of them are still present.
 */
export function listProjects(registryPath, deps = {}) {
  const exists = deps.exists ?? existsSync
  const registry = readRegistry(registryPath)
  return registry.projects.map(entry => ({
    ...describeProject(entry, deps),
    missing_roots: projectRoots(entry).filter(root => !exists(root)),
  }))
}

/**
 * Write one registry revision.
 * @param options - registry location.
 * @param registry - the registry as read.
 * @param projects - the projects to store.
 */
function commit(options, registry, projects) {
  writeAtomic(options.registryPath, `${JSON.stringify({
    schema_version: REGISTRY_SCHEMA_VERSION,
    revision: registry.revision + 1,
    projects,
  }, null, 2)}\n`)
}

/**
 * Add one workspace id to an entry, when it is new.
 * @param entry - the registry entry.
 * @param workspaceId - the workspace to record, when known.
 * @param options - clock source.
 * @returns the same entry, or an updated copy.
 */
function adoptWorkspace(entry, workspaceId, options) {
  if (workspaceId === undefined || entry.workspace_ids.includes(workspaceId)) return entry
  return { ...entry, workspace_ids: [...entry.workspace_ids, workspaceId], updated_at: nowIso(options) }
}

/**
 * Find the entry one relink refers to.
 * @param projects - every registry entry.
 * @param previous - the normalized absolute lexical old path.
 * @param deps - filesystem seams, injectable for tests.
 * @returns the owning entry, or undefined.
 */
function locateForRelink(projects, previous, deps) {
  const exact = projects.find(entry => projectRoots(entry).some(root => resolve(root) === previous))
  if (exact !== undefined) return exact
  // When the old directory still exists, a symlinked spelling of it also counts.
  return ownerOf(projects, previous, deps)
}

/**
 * Project one registry entry for callers.
 * @param entry - the registry entry.
 * @param deps - filesystem seams, injectable for tests.
 * @returns the entry's identity and current roots.
 */
function describeProject(entry, deps) {
  const exists = deps.exists ?? existsSync
  return {
    project_id: entry.project_id,
    canonical_root: entry.canonical_root,
    aliases: [...entry.aliases],
    workspace_ids: [...entry.workspace_ids],
    roots: projectRoots(entry),
    present_roots: projectRoots(entry).filter(root => exists(root)),
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  }
}

/**
 * Current time as a registry timestamp.
 * @param options - clock source.
 * @returns an ISO-8601 UTC instant with millisecond precision.
 */
function nowIso(options) {
  return new Date((options.now ?? Date.now)()).toISOString()
}
