/**
 * The shapes this plugin's own storage and actions exchange.
 *
 * Declared here rather than inferred at each use, because the same record travels
 * through the store, the derived view, the injected index, the search results and
 * the actions that write it. Field names are the ones the canonical schema
 * validates (`src/schema.js`), which is the authority for what a record holds.
 *
 * @module dsh-memory/types
 */

/** Which store a record lives in. */
export type MemoryScope = 'user' | 'project'

/** The closed set `schema.js` accepts. */
export type MemoryCategory = 'preference' | 'feedback' | 'decision' | 'lesson' | 'state' | 'reference'

/** One citation behind a record, built by the plugin rather than supplied by a model. */
export interface EvidenceEntry {
  /** Where the citation came from: a human turn, an assistant turn, or a tool result. */
  kind: string
  /** The Session the cited event belongs to. */
  session_id: string
  /** The cited event sequence numbers. */
  event_seqs: number[]
  /** The quoted text, already truncated and screened. */
  quote: string
  /** When the citation was observed, ISO-8601. */
  observed_at: string
}

/**
 * One Memory.
 *
 * `status` is a string rather than a closed union because it is validated by the
 * schema at the durable boundary, and a wider type here would not make a
 * hand-edited file any safer.
 */
export interface MemoryRecord {
  id: string
  scope: MemoryScope
  category: MemoryCategory
  status: string
  content: string
  confidence: number
  project_id?: string | null
  created_at: string
  updated_at: string
  evidence: EvidenceEntry[]
  superseded_by?: string | null
}

/** One store file's contents. */
export interface MemoryStore {
  schema_version: number
  revision: number
  records: MemoryRecord[]
}

/** Where one scope's files live, as `paths.ts` resolves them. */
export interface ScopeLayout {
  dir: string
  storePath: string
  lockPath: string
  viewPath: string
}

/**
 * What one Phase 1 action needs to run.
 *
 * This module forwards these to the actions without reading them; the fields are
 * the ones the actions and their suites actually set.
 */
export interface ActionOptions {
  /** The two scope layouts. The project layout is resolved per project id. */
  scopes: { user: ScopeLayout; project: (projectId: string) => ScopeLayout }
  /** The tombstone ledger and its lock. */
  tombstones: { path: string; lockPath: string }
  /** How long to wait for a lock before reporting the file. */
  lockTimeoutMs: number
  /** Age at which a lock is treated as abandoned. */
  staleLockMs: number
  /** How many citations one record keeps. */
  maxEvidencePerMemory: number
  /** Diagnostic sink. */
  logger?: { warn(message: string | Error): void; info?(message: string): void } | undefined
  /** Written into tombstones, naming who removed a record. */
  host?: string | undefined
  /** Probes whether a pid is alive; injectable so tests need no real process. */
  kill?: ((pid: number, signal?: number | string) => boolean) | undefined
  /** Injectable clock, in epoch milliseconds. */
  now?: (() => number) | undefined
}

/**
 * What `add` needs: the content, and the scope and category it lands in.
 *
 * Split per action rather than shared: a bag with every field optional is what
 * made the compiler unable to tell a complete call from an incomplete one.
 */
export interface AddInput {
  /** The fact to store. */
  content: string
  /** Which store it belongs to. */
  scope: MemoryScope
  /** What kind of record it is. */
  category: MemoryCategory
  /** Required for a project record. */
  projectId?: string | null | undefined
  /** The citation to attach. */
  evidence?: EvidenceEntry | undefined
  /** Untruncated text the citation came from, screened again at the write. */
  sourceTexts?: string[] | undefined
  /** Automatic writes state their reviewed confidence; explicit ones do not. */
  confidence?: number | undefined
}

/** What `update` and `supersede` need: the record to act on, and the new content. */
export interface TargetedInput {
  /** The record being rewritten. */
  id: string
  /** The content that replaces it. */
  content: string
  /** The project that record lives in, inherited from the reviewed target. */
  projectId?: string | null | undefined
  /** The citation to accumulate. */
  evidence?: EvidenceEntry | undefined
  /** Untruncated text the citation came from, screened again at the write. */
  sourceTexts?: string[] | undefined
  /** Automatic writes state their reviewed confidence; explicit ones do not. */
  confidence?: number | undefined
}

/** Any input one of the three actions takes. */
export type ActionInput = AddInput | TargetedInput

/**
 * One operation a reviewed plan may carry.
 *
 * A tagged union, not a bag: an `add` carries the scope and category it lands in,
 * and a rewrite carries the id it targets. The validator refuses anything else
 * before this point, so the tags are what a consumer switches on.
 */
export type AutoOperation = AddOperation | TargetedOperation

/** Store a new fact. */
export interface AddOperation {
  action: 'add'
  /** The fact to store. */
  content: string
  /** Which store it belongs to. */
  scope: MemoryScope
  /** What kind of record it is. */
  category: MemoryCategory
  /** Required for a project record. */
  projectId?: string | null | undefined
  /** The citation to attach. */
  evidence?: EvidenceEntry | undefined
  /** Untruncated text the citation came from, screened again at the write. */
  sourceTexts?: string[] | undefined
  /** The confidence the review assigned. */
  confidence?: number | undefined
}

/** Rewrite or retire an existing record. */
export interface TargetedOperation {
  action: 'update' | 'supersede'
  /** The record being rewritten or retired. */
  target_id: string
  /** The content that replaces it. */
  content: string
  /** Inherited from the reviewed target; never taken from the model. */
  projectId?: string | null | undefined
  /** The citation to accumulate. */
  evidence?: EvidenceEntry | undefined
  /** Untruncated text the citation came from, screened again at the write. */
  sourceTexts?: string[] | undefined
  /** The confidence the review assigned. */
  confidence?: number | undefined
}
