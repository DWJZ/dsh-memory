/**
 * When consolidation is allowed to run.
 *
 * Two facts decide that, and they are deliberately separate:
 *
 * - `idle` is an *opportunity*. The agent has stopped, so there is a window in
 *   which extra work is not felt.
 * - pending trajectory is a *reason*. Without it, an idle agent that has done
 *   nothing worth reading must not produce a model call.
 *
 * The timer lives here, outside the agent's maintenance phase. Sleeping inside
 * maintenance would block the agent for the whole debounce, which is the
 * opposite of what a debounce is for: wait until the user has probably stopped,
 * then take the agent's maintenance phase only for the work itself.
 *
 * Usage: `trigger.statusChanged(agent, 'idle')` from an `agent/status` listener.
 */

/** Debounce before an idle agent is consolidated, in milliseconds. */
export const DEFAULT_DEBOUNCE_MS = 10_000

/**
 * Build one trigger.
 *
 * `schedule` and `cancelSchedule` are injectable so the debounce can be tested
 * without waiting on a real clock.
 * @param {object} options - debounce policy and seams.
 * @param options.task - receives the agent once the debounce expires and the
 *   agent is still idle; its fulfillment ends the run.
 * @param options.debounceMs - how long to wait after the agent goes idle.
 * @param options.isIdle - whether an agent is still idle, injectable for tests.
 * @param options.schedule - timer starter, injectable for tests.
 * @param options.cancelSchedule - timer canceller, injectable for tests.
 * @param options.logger - optional `{ warn }` sink.
 * @returns the trigger.
 */
export function createTrigger(options) {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const schedule = options.schedule ?? ((run, ms) => setTimeout(run, ms))
  const cancelSchedule = options.cancelSchedule ?? (handle => { clearTimeout(handle) })
  const isIdle = options.isIdle ?? (agent => agent?.status === 'idle')
  const pending = new Map()
  const running = new Set()

  /**
   * The identity one agent is tracked under.
   * @param agent - the agent.
   * @returns its Session id, or undefined when it has none.
   */
  const keyOf = (agent) => {
    const id = agent?.session?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  /**
   * Drop one agent's pending debounce.
   * @param key - the agent's Session id.
   * @returns nothing.
   */
  const cancelPending = (key) => {
    const handle = pending.get(key)
    if (handle === undefined) return
    pending.delete(key)
    cancelSchedule(handle)
  }

  /**
   * Fire one agent's debounce.
   *
   * Everything that could have invalidated the opportunity is re-checked here,
   * because the debounce window is long enough for the agent to have started a
   * new turn, or for another run to have begun.
   * @param agent - the agent whose timer expired.
   * @param key - the agent's Session id.
   * @returns fulfillment once the task has settled.
   */
  const expire = async (agent, key) => {
    pending.delete(key)
    if (running.has(key)) return
    if (!isIdle(agent)) return
    running.add(key)
    try {
      await options.task(agent)
    } catch (failure) {
      // A failed consolidation must not escape into the status listener: the
      // mark stays put and the next idle period retries the same window.
      options.logger?.warn(`dsh-memory: consolidation failed for ${key}: ${String(failure?.message ?? failure)}`)
    } finally {
      running.delete(key)
    }
  }

  return {
    /**
     * React to one agent status change.
     * @param agent - the agent whose status changed.
     * @param status - its new status.
     * @returns nothing.
     */
    statusChanged(agent, status) {
      const key = keyOf(agent)
      if (key === undefined) return
      if (status !== 'idle') {
        cancelPending(key)
        return
      }
      if (pending.has(key) || running.has(key)) return
      // The promise is returned rather than discarded: a real timer ignores a
      // callback's value, and a test can await it to observe the run.
      pending.set(key, schedule(() => expire(agent, key), debounceMs))
    },

    /**
     * Whether an agent has a debounce waiting.
     * @param agent - the agent.
     * @returns true when a timer is pending.
     */
    isPending(agent) {
      const key = keyOf(agent)
      return key !== undefined && pending.has(key)
    },

    /**
     * Whether an agent is being consolidated right now.
     * @param agent - the agent.
     * @returns true when a run is in flight.
     */
    isRunning(agent) {
      const key = keyOf(agent)
      return key !== undefined && running.has(key)
    },

    /**
     * Drop every pending debounce.
     *
     * Called when the plugin unloads, so a timer cannot fire against a disposed
     * agent.
     * @returns nothing.
     */
    dispose() {
      for (const key of [...pending.keys()]) cancelPending(key)
    },
  }
}
