/**
 * The injectable seams a few modules take as optional dependencies.
 *
 * These exist so the modules can be tested without touching the filesystem or the
 * clock. They are parameters with a `{}` default, which is also why they were
 * previously unreadable: an object literal default infers as `{}`, so every member
 * the module reads from it came back as a missing property.
 *
 * @module dsh-memory/types/seams
 */

/** Filesystem probes a resolver may take instead of the real ones. */
export interface FileProbe {
  /** Whether a path exists. */
  exists?(path: string): boolean
  /** The canonical spelling of a path, resolving symlinks. */
  realpath?(path: string): Promise<string> | string
}

/** What a temporary-file sweep takes. */
export interface SweepOptions {
  /** Age at which a temporary file is considered abandoned. */
  staleTempMs?: number
  /** Injectable clock in epoch milliseconds. */
  now?(): number
}

/** What a schema check takes. */
export interface CheckOptions {
  /** Largest accepted evidence list. */
  maxEvidencePerMemory?: number
}
