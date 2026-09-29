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
 * @param options.without - services to withhold, so an injection stays pending
 *   the way Cordis leaves one whose dependencies have not mounted yet.
 * @param options.logger - logger to record messages with.
 * @returns the stub context and its registration record.
 */
export function createStubContext(options = {}) {
  const registrations = { contexts: [], sections: [], tools: [], commands: [], listeners: new Map(), disposeCalls: 0 }
  const withheld = new Set(options.without ?? [])
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

  /**
   * Whether one service is currently available.
   * @param name - the service name.
   * @returns true when the service has mounted and is not withheld.
   */
  const isAvailable = (name) => {
    if (withheld.has(name)) return false
    return (options.services ?? {})[name] !== undefined || ctx[name] !== undefined
  }

  const ctx = {
    logger,
    warnings,
    infos,
    registrations,
    get: name => (isAvailable(name) ? (options.services ?? {})[name] ?? ctx[name] : undefined),
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
     * it removes them. Modelled faithfully in two respects the lifecycle tests
     * depend on: a callback whose dependencies have not mounted yet stays
     * pending rather than running, and a disposed fiber never runs at all —
     * Cordis reports `DISPOSED` for it, so no later mount can revive it.
     * @param deps - the services the callback requires.
     * @param callback - the plugin body, called with the scoped context.
     * @returns a fiber-like object with `dispose`.
     */
    inject(deps, callback) {
      registrations.injections = registrations.injections ?? []
      const entry = { deps, callback, state: 'pending', added: { contexts: [], tools: [] } }
      registrations.injections.push(entry)
      const fiber = {
        deps,
        dispose: async () => {
          if (entry.state === 'disposed') return
          entry.state = 'disposed'
          registrations.fiberDisposals = (registrations.fiberDisposals ?? 0) + 1
          for (const contextEntry of entry.added.contexts) remove(registrations.contexts, contextEntry)
          for (const toolEntry of entry.added.tools) remove(registrations.tools, toolEntry)
        },
      }
      if (deps.every(isAvailable)) startInjection(entry)
      return fiber
    },
    systemPrompt: {
      section(entry) {
        registrations.sections.push(entry)
        return counted(() => {
          const index = registrations.sections.indexOf(entry)
          if (index >= 0) registrations.sections.splice(index, 1)
        })
      },
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
   * Start one pending injection, if it is still pending.
   * @param entry - the injection record.
   */
  const startInjection = (entry) => {
    if (entry.state !== 'pending') return
    entry.state = 'active'
    runInjection(entry)
  }

  /**
   * Mount services an injection was waiting for, as Cordis does when a
   * dependency appears late. A pending fiber starts; a disposed one never does.
   * @param names - the service names to mount.
   * @returns the number of injections that started.
   */
  ctx.provideServices = (...names) => {
    for (const name of names) withheld.delete(name)
    let started = 0
    for (const entry of registrations.injections ?? []) {
      if (entry.state !== 'pending' || !entry.deps.every(isAvailable)) continue
      startInjection(entry)
      started += 1
    }
    return started
  }

  /**
   * Re-run every active injection, as Cordis does when an injected service
   * remounts. Neither a pending nor a disposed fiber comes back this way.
   * @returns the number of injections re-run.
   */
  ctx.remountServices = () => {
    let rerun = 0
    for (const entry of registrations.injections ?? []) {
      if (entry.state !== 'active') continue
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
