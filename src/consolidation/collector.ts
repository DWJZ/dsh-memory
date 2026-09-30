/**
 * The events this process has observed, kept per Session in seq order.
 *
 * Consolidation needs "the trajectory since the last mark", and the harness no
 * longer offers a supported way to read history out of a Session: the
 * synchronous readers are deprecated and new calls are prohibited. So the plugin
 * keeps its own projection instead, filled from the post-commit append feed the
 * same way Phase 1 already tracks provenance. It is the same shape the
 * deprecation note asks for — state maintained incrementally from newly
 * committed events, rather than a look back through the log.
 *
 * The consequence is worth stating plainly: this buffer only knows what it was
 * present to see. Events from before the plugin mounted, or from a Session
 * resumed in another process, are not here. {@link firstSeq} and
 * {@link droppedThrough} exist so the caller can tell the difference between
 * "nothing worth keeping" and "never observed", and record the latter as a gap
 * rather than letting the mark imply it was read.
 *
 * Usage: `const collector = createCollector(); ctx.on('session/event', (s, e) => collector.observe(s, e))`.
 */

/** Largest number of events retained per Session before the oldest are dropped. */
export const DEFAULT_MAX_BUFFERED_EVENTS = 5000

/**
 * Build one collector.
 * @param {object} options - buffer limits.
 * @param options.maxBufferedEvents - per-Session retention cap.
 * @returns the collector.
 */
export function createCollector(options = {}) {
  const limit = options.maxBufferedEvents ?? DEFAULT_MAX_BUFFERED_EVENTS
  const bySession = new Map()

  /**
   * One Session's buffer, created on first use.
   * @param sessionId - the Session.
   * @returns its buffer.
   */
  const bufferFor = (sessionId: string) => {
    let buffer = bySession.get(sessionId)
    if (buffer === undefined) {
      buffer = { events: [], droppedThrough: -1 }
      bySession.set(sessionId, buffer)
    }
    return buffer
  }

  return {
    /**
     * Record one committed event.
     *
     * Events arrive in seq order, and a repeat is ignored rather than appended:
     * two observations of one seq would otherwise be offered to the model twice.
     * @param session - the Session the event belongs to.
     * @param event - the committed event.
     * @returns nothing.
     */
    observe(session, event) {
      const sessionId = session?.id
      if (typeof sessionId !== 'string' || !Number.isInteger(event?.seq)) return
      const buffer = bufferFor(sessionId)
      const last = buffer.events.at(-1)
      if (last !== undefined && event.seq <= last.seq) return
      buffer.events.push(event)
      if (buffer.events.length > limit) {
        const dropped = buffer.events.splice(0, buffer.events.length - limit)
        buffer.droppedThrough = dropped.at(-1).seq
      }
    },

    /**
     * The observed events for one Session.
     * @param sessionId - the Session.
     * @returns its events, in seq order.
     */
    eventsFor(sessionId: string) {
      return bySession.get(sessionId)?.events ?? []
    },

    /**
     * The lowest seq this collector can still offer for one Session.
     * @param sessionId - the Session.
     * @returns the first retained seq, or undefined when nothing is buffered.
     */
    firstSeq(sessionId: string) {
      return bySession.get(sessionId)?.events[0]?.seq
    },

    /**
     * The highest seq dropped from one Session's buffer.
     * @param sessionId - the Session.
     * @returns the seq, or -1 when nothing was dropped.
     */
    droppedThrough(sessionId: string) {
      return bySession.get(sessionId)?.droppedThrough ?? -1
    },

    /**
     * Drop events a settled batch has already consumed.
     *
     * Called with the new mark, so the buffer holds pending work rather than
     * every event the Session ever produced.
     * @param sessionId - the Session.
     * @param throughSeq - the highest consumed seq.
     * @returns the number of events dropped.
     */
    dropConsumed(sessionId: string, throughSeq) {
      const buffer = bySession.get(sessionId)
      if (buffer === undefined) return 0
      const retained = buffer.events.filter(event => event.seq > throughSeq)
      const dropped = buffer.events.length - retained.length
      buffer.events = retained
      return dropped
    },

    /**
     * Forget one Session entirely.
     * @param sessionId - the Session.
     * @returns nothing.
     */
    forget(sessionId: string) {
      bySession.delete(sessionId)
    },

    /**
     * Forget every Session not named.
     * @param keep - Session ids to retain.
     * @returns the number of Sessions forgotten.
     */
    retain(keep) {
      let forgotten = 0
      for (const sessionId of [...bySession.keys()]) {
        if (keep.has(sessionId)) continue
        bySession.delete(sessionId)
        forgotten += 1
      }
      return forgotten
    },

    /**
     * Every Session this collector is holding events for.
     * @returns the Session ids.
     */
    sessions() {
      return [...bySession.keys()]
    },
  }
}
