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
