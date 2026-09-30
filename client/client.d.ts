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
  start(context: unknown, match: unknown): unknown
  /** Fold a later event into an open row. */
  update(context: { state: unknown }, match: unknown): unknown
  /** Build the node the ledger renders. */
  buildViewNode(context: { state: unknown }): unknown
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
