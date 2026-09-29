/**
 * A stand-in Cordis context for the wiring suite.
 *
 * It records what a plugin registered and hands back the disposer Cordis would,
 * so a test can assert that disabling or unloading actually removes the
 * registration rather than leaving a callback behind.
 *
 * Usage: `import { createStubContext } from './stub-context.mjs'`.
 */

/**
 * Build one stub context.
 * @param options - overrides.
 * @param options.services - named services the plugin may look up with `ctx.get`.
 * @param options.logger - logger to record messages with.
 * @returns the stub context and its registration record.
 */
export function createStubContext(options = {}) {
  const registrations = { contexts: [], tools: [], commands: [], listeners: new Map(), disposeCalls: 0 }
  const warnings = []
  const infos = []
  const logger = options.logger ?? {
    info: message => infos.push(message),
    warn: message => warnings.push(message),
  }

  /**
   * Record one disposer so a test can count how often it ran.
   * @param remove - the removal to wrap.
   * @returns the same removal.
   */
  const counted = (remove) => {
    return () => {
      registrations.disposeCalls += 1
      return remove()
    }
  }

  const ctx = {
    logger,
    warnings,
    infos,
    registrations,
    get: name => (options.services ?? {})[name] ?? ctx[name],
    on(name, listener) {
      const list = registrations.listeners.get(name) ?? []
      list.push(listener)
      registrations.listeners.set(name, list)
      return counted(() => {
        const current = registrations.listeners.get(name) ?? []
        const index = current.indexOf(listener)
        if (index >= 0) current.splice(index, 1)
      })
    },
    effect(fn) {
      const dispose = fn()
      registrations.effectDisposers = registrations.effectDisposers ?? []
      registrations.effectDisposers.push(dispose)
      registrations.effects = (registrations.effects ?? 0) + 1
      return dispose
    },
    inject(deps, callback) {
      registrations.injections = registrations.injections ?? []
      registrations.injections.push({ deps, callback })
      const missing = deps.filter(name => (options.services ?? {})[name] === undefined && ctx[name] === undefined)
      if (missing.length > 0) return () => {}
      callback(ctx)
      return counted(() => {})
    },
    systemPrompt: {
      context(entry) {
        registrations.contexts.push(entry)
        return counted(() => {
          const index = registrations.contexts.indexOf(entry)
          if (index >= 0) registrations.contexts.splice(index, 1)
        })
      },
    },
    tools: {
      register(definition) {
        registrations.tools.push(definition)
        return counted(() => {
          const index = registrations.tools.indexOf(definition)
          if (index >= 0) registrations.tools.splice(index, 1)
        })
      },
    },
    commands: {
      register(definition) {
        registrations.commands.push(definition)
        return counted(() => {
          const index = registrations.commands.indexOf(definition)
          if (index >= 0) registrations.commands.splice(index, 1)
        })
      },
    },
  }

  /**
   * Deliver one event to the listeners registered for it.
   * @param name - the event name.
   * @param args - the listener arguments.
   * @returns the number of listeners invoked.
   */
  ctx.emit = (name, ...args) => {
    const list = [...(registrations.listeners.get(name) ?? [])]
    for (const listener of list) listener(...args)
    return list.length
  }

  /**
   * Deliver one serial event and await every listener, as the loop does.
   * @param name - the event name.
   * @param args - the listener arguments.
   * @returns fulfillment once every listener has settled.
   */
  ctx.emitAsync = async (name, ...args) => {
    const list = [...(registrations.listeners.get(name) ?? [])]
    for (const listener of list) await listener(...args)
  }

  return ctx
}

/**
 * Run every disposer one plugin instance registered through `ctx.effect`.
 * @param ctx - the stub context.
 * @returns nothing.
 */
export function disposeEffects(ctx) {
  for (const dispose of [...ctx.registrations.effectDisposers ?? []].reverse()) dispose()
}
