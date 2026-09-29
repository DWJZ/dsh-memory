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
    /**
     * Load one injection-scoped plugin, as Cordis does.
     *
     * The returned fiber owns the registrations its callback makes, so disposing
     * it removes them. Modelling that is the point: a stub that returned a bare
     * disposer could not show whether a service remount resurrects registrations
     * after a disable.
     * @param deps - the services the callback requires.
     * @param callback - the plugin body, called with the scoped context.
     * @returns a fiber-like object with `dispose`.
     */
    inject(deps, callback) {
      registrations.injections = registrations.injections ?? []
      const entry = { deps, callback, disposed: false, added: { contexts: [], tools: [] } }
      registrations.injections.push(entry)
      const fiber = {
        deps,
        dispose: async () => {
          if (entry.disposed) return
          entry.disposed = true
          registrations.fiberDisposals = (registrations.fiberDisposals ?? 0) + 1
          for (const contextEntry of entry.added.contexts) remove(registrations.contexts, contextEntry)
          for (const toolEntry of entry.added.tools) remove(registrations.tools, toolEntry)
        },
      }
      const missing = deps.filter(name => (options.services ?? {})[name] === undefined && ctx[name] === undefined)
      if (missing.length > 0) {
        entry.disposed = true
        return fiber
      }
      runInjection(entry)
      return fiber
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
   * Run one injection's callback and record what it registered.
   * @param entry - the injection record.
   */
  const runInjection = (entry) => {
    const beforeContexts = registrations.contexts.length
    const beforeTools = registrations.tools.length
    entry.callback(ctx)
    entry.added = {
      contexts: registrations.contexts.slice(beforeContexts),
      tools: registrations.tools.slice(beforeTools),
    }
  }

  /**
   * Re-run every live injection, as Cordis does when an injected service
   * remounts. A disposed fiber must not come back this way.
   * @returns the number of injections re-run.
   */
  ctx.remountServices = () => {
    let rerun = 0
    for (const entry of registrations.injections ?? []) {
      if (entry.disposed) continue
      runInjection(entry)
      rerun += 1
    }
    return rerun
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
 * Run every disposer one plugin instance registered through `ctx.effect`, then
 * settle the async ones.
 * @param ctx - the stub context.
 * @returns fulfillment once every disposer has settled.
 */
export async function disposeEffects(ctx) {
  for (const dispose of [...ctx.registrations.effectDisposers ?? []].reverse()) await dispose()
}

/**
 * Drop one entry from a registration list.
 * @param list - the list to edit.
 * @param entry - the entry to remove.
 */
function remove(list, entry) {
  const index = list.indexOf(entry)
  if (index >= 0) list.splice(index, 1)
}
