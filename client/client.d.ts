/**
 * The surface the Web client hands a plugin bundle.
 *
 * The client loads a bundle by calling one global envelope with an id and a
 * factory; the factory receives a CommonJS-style `require` for the client modules
 * it names. Nothing here renders DOM, so the DOM library is needed only because
 * the envelope lives on `window`.
 */

/** The lazy-CommonJS envelope one plugin bundle is loaded through. */
interface DshModuleLoader {
  /**
   * Register a bundle.
   * @param envelope - the bundle id, and the factory that builds its exports.
   */
  load(envelope: { id: string; factory: (require: (id: string) => unknown) => void }): void
}

interface Window {
  /** Injected by the Web client before any bundle is loaded. */
  __ModuleLoader__: DshModuleLoader
}

/** A namespace's translation function. */
type Translate = (key: string, params?: Record<string, unknown>) => string

/** The locale service a Client context exposes. */
interface DshClientLocale {
  /**
   * Bind one namespace's translations.
   * @param namespace - the dictionary namespace this bundle registered.
   * @returns the translate function for that namespace.
   */
  bind(namespace: string): Translate
  /**
   * Register dictionaries for one namespace.
   * @param namespace - the namespace name.
   * @param dictionaries - one table per language.
   * @returns the disposer that unregisters them.
   */
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
}

/** One read-only row of the Trajectory ledger, as the conversation service takes it. */
interface DshTrajectoryRow {
  /** The row kind the ledger groups by. */
  kind: string
  /** The ledger this row belongs to. */
  target: string
  /** Whether one event starts a row, and under which id. */
  match(event: { type: string; seq: number; data?: unknown }): { id: string; role: string } | null
  /** Fold one matched event into the row's state. */
  start(context: DshLedgerNode, match: DshRowMatch): unknown
  /** Fold a later event into an open row. */
  update(context: DshLedgerNode, match: DshRowMatch): unknown
  /** Build the node the ledger renders. */
  buildViewNode(context: DshLedgerNode): unknown
}

/** This plugin's Client context. */
interface DshClientContext {
  /**
   * Register a contribution; the runtime disposes it with the fiber.
   * @param callback - the registration, or its disposer.
   * @param label - a diagnostic label.
   */
  effect(callback: () => void | (() => void), label?: string): void
  /** The locale service. */
  locale: DshClientLocale
  /** The conversation service, where trajectory rows are registered. */
  uiConversation: {
    events: {
      /**
       * Register a row definition.
       * @param definition - what events it folds, and how it renders.
       * @returns the disposer that unregisters it.
       */
      register(definition: DshTrajectoryRow): () => void
    }
  }
}

/** The event a row matched, as the ledger hands it over. */
interface DshRowMatch {
  /** The Session event the row matched. */
  event: {
    /** Its type. */
    type: string
    /** Its sequence number. */
    seq: number
    /** Its payload, unread until the row decides what to do with it. */
    data?: unknown
    /** When it happened, when the log recorded it. */
    time?: unknown
  }
}

/** What one trajectory row is built from. */
interface TrajectoryRowOptions {
  /** The row kind, as the ledger groups it. */
  kind: string
  /** The Session event type this row folds. */
  eventType: string
  /** Prefix of the row id. */
  idPrefix: string
  /** Ledger emphasis for one payload. */
  toneOf(payload: Record<string, unknown>): string
  /** The one-line summary for one payload. */
  summarize(payload: Record<string, unknown>, t: Translate): string
  /** This namespace's translate function. */
  translate: Translate
}

/** The bundle's exports. The offline smoke test drives these directly. */
interface DshMemoryClientExports {
  /** Register the dictionaries and the two ledger rows. */
  apply(ctx: DshClientContext): void
  /** The client services this bundle waits for. */
  inject: string[]
  /** One-line summary of a consolidation run. */
  consolidationSummary(payload: Record<string, unknown>, t: Translate): string
  /** One-line summary of a project attribution. */
  projectSummary(payload: Record<string, unknown>, t: Translate): string
  /** Ledger emphasis for a consolidation status. */
  statusTone(status: unknown): string
  /** Build the consolidation row definition. */
  createConsolidationRow(translate: Translate): DshTrajectoryRow
  /** Build the project row definition. */
  createProjectRow(translate: Translate): DshTrajectoryRow
  /** The Session event type the consolidation row folds. */
  CONSOLIDATION_EVENT: string
  /** The Session event type the project row folds. */
  PROJECT_EVENT: string
}

/** What the ledger hands a row while it folds or renders one node. */
interface DshLedgerNode {
  /**
   * The state this row folded so far: what its fold produced, or undefined
   * before the first event matched.
   */
  state: { seq: number; time: number; payload: unknown } | undefined
  /** The row's key in the ledger. */
  key: string
  /** The row kind. */
  kind: string
  /** The row id. */
  id: string
  /** Where the row started, as the ledger recorded it. */
  start: { location?: unknown } | null | undefined
}
