/**
 * How this plugin names a project, and what it remembers about one.
 *
 * The plugin derives a project's identity from the directory a Session runs in,
 * because the Session itself carries no project field. A project root is found by
 * walking up to the nearest marker (the same list `@deepseek-ai/dsh-agent-instructions`
 * resolves instruction scopes with), and the registry remembers every path that
 * has referred to the entry so a renamed or moved directory can still be
 * recognized.
 *
 * @module dsh-memory/identity
 */

/**
 * One project, as `registry.ts` validates and stores it.
 *
 * `canonical_root` is the path the entry was created for; `aliases` holds earlier
 * paths that resolved to the same entry, which is what keeps a move from looking
 * like a new project.
 */
export interface ProjectEntry {
  /** Stable id, generated once when the entry is created. */
  project_id: string
  /** Absolute canonical path this entry was created for. */
  canonical_root: string
  /** Earlier paths that resolved to this entry. */
  aliases: string[]
  /** Harness workspace ids seen for this project, when the host has one. */
  workspace_ids: string[]
}

/** The registry file's contents. */
export interface ProjectRegistry {
  schema_version: number
  revision: number
  projects: ProjectEntry[]
}

/** Which lookup decided a project, for the attribution record. */
export type ProjectMatch = 'registry' | 'workspace' | 'marker'
