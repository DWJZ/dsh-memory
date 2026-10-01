/**
 * The resolved settings this plugin runs with.
 *
 * Field names and defaults come from `config.ts`, which is also where they are
 * validated; this declaration exists so that the modules receiving settings can
 * name them. `memoryDir` is not a default — it is resolved from `dshHome` — but it
 * is part of what a caller holds.
 *
 * @module dsh-reflection/types/config
 */

/** Phase 2's own settings, as `consolidationSetting` resolves them. */
export interface MemoryConsolidationSettings {
  /** Whether automatic learning runs at all. */
  enabled: boolean
  /** Whether a run may write. `false` stops learning on its own without spending tokens. */
  autoCommit: boolean
  /** How long an idle agent waits before its turn is consolidated. */
  debounceMs: number
  /** A proposal below this is dropped rather than stored. */
  minConfidence: number
  /** Largest window offered to the model, in events. */
  maxRelevantEventsPerBatch: number
  /** UTF-8 ceiling for the rendered trajectory. */
  maxTrajectoryBytesPerBatch: number
  /** Cap on the plan the model may return. */
  maxOutputTokens: number
}

/** The diagnostic sink a deployment injects. */
export interface MemoryLogger {
  /** Report something that went wrong but did not stop the plugin. */
  warn(message: string | Error): void
  /** Report something worth knowing. */
  info?(message: string): void
  /** Report detail a deployment asked for. */
  debug?(message: string): void
}

/** Everything this plugin resolves from its own configuration and the deployment. */
export interface MemorySettings {
  /** The runtime switch, after the persisted file wins over `cordis.yml`. */
  enabled: boolean
  /** Whether this plugin may write rows into the Session log. */
  sessionEvents: boolean
  /** The harness home the Memory root is resolved from. */
  dshHome: string
  /** The Memory root itself. */
  memoryDir: string
  /** Largest injected index, in UTF-8 bytes. */
  indexBudgetBytes: number
  /** How the index budget is split between the user and the project. */
  indexBudgetSplit: { user: number; project: number }
  /** How many records a search returns. */
  retrievalTopK: number
  /** Markers that identify a project root, kept in step with the harness. */
  projectRootMarkers: string[]
  /** How long to wait for a lock before reporting the file. */
  lockTimeoutMs: number
  /** Age at which a lock is treated as abandoned. */
  staleLockMs: number
  /** How many citations one record keeps. */
  maxEvidencePerMemory: number
  /** Largest export rendered inline rather than written to a file. */
  exportInlineMaxBytes: number
  /** Longest citation quote, in characters. */
  evidenceQuoteMaxChars: number
  /**
   * The host name written into lock records and tombstones.
   *
   * Taken from the plugin configuration when a deployment names one, and from the
   * machine otherwise, so a shared Memory root still records who wrote what.
   */
  host: string
  /**
   * Whether a recorded process is still alive.
   *
   * `process.kill` by default; a deployment or a test may pass its own, which is the
   * only way this can be exercised without real processes.
   */
  kill: typeof process.kill
  /** The diagnostic sink the runtime injected, when it did. */
  logger?: MemoryLogger | undefined
  /** Phase 2's settings. */
  consolidation: MemoryConsolidationSettings
}
