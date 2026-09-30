/**
 * The resolved settings this plugin runs with.
 *
 * Field names and defaults come from `config.ts`, which is also where they are
 * validated; this declaration exists so that the modules receiving settings can
 * name them. `memoryDir` is not a default — it is resolved from `dshHome` — but it
 * is part of what a caller holds.
 *
 * @module dsh-memory/types/config
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
  /** Phase 2's settings. */
  consolidation: MemoryConsolidationSettings
}
