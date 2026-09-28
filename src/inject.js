/**
 * Context injection, and what the plugin knows about the current turn.
 *
 * Phase 1 injects one bounded index of active Memory and nothing else: there is
 * no per-turn retrieval, so the model asks for detail through `memory_search`
 * when it wants it. The index travels as runtime context, which the agent loop
 * logs as model history, so a replayed session reconstructs the same text.
 *
 * Reading the session log synchronously is deprecated, so the plugin learns the
 * current turn's input by observing `session/event`: the last human `user/message`
 * is captured when a turn starts, which binds provenance to the input that began
 * the turn rather than to whichever message happens to be last.
 *
 * @module dsh-memory/inject
 */

import { truncateChars } from './schema.js'

/** Context contribution name, unique across the harness. */
export const MEMORY_INDEX_NAME = 'memory:index'

/**
 * Position among runtime contexts.
 *
 * The plugin cannot ask for a centrally allocated name, so it names a literal
 * order. It sorts after the sandbox and approval policies, which describe the
 * turn's constraints, and before any tool guidance.
 */
export const MEMORY_INDEX_ORDER = 130

/**
 * Register the always-visible Memory index.
 * @param ctx - Cordis context of this plugin's fiber.
 * @param render - builds the index text for one agent; must be synchronous.
 * @returns the exact disposer that removes the contribution.
 */
export function registerMemoryIndex(ctx, render) {
  return ctx.systemPrompt.context({
    name: MEMORY_INDEX_NAME,
    order: MEMORY_INDEX_ORDER,
    text: (assembleContext) => {
      const agent = assembleContext.agent
      // A bare assemble (tests, diagnostics) has no session to describe.
      if (agent === undefined) return ''
      return render(agent)
    },
  })
}

/**
 * Track the human input of each session's current turn.
 *
 * Provenance must name the message the user actually sent, not a heuristic match
 * on text. Observing the event feed gives the message and its sequence number
 * without reading the log through an API new callers may not use.
 * @param ctx - Cordis context of this plugin's fiber.
 * @returns an observer with lookup by session and a disposer.
 */
export function createTurnTracker(ctx) {
  const bySession = new Map()

  const stateOf = (sessionId) => {
    const existing = bySession.get(sessionId)
    if (existing !== undefined) return existing
    const created = { lastHuman: undefined, turnInput: undefined }
    bySession.set(sessionId, created)
    return created
  }

  const disposeListener = ctx.on('session/event', (session, event) => {
    const state = stateOf(session.header.id)
    if (event.type === 'user/message') {
      if (isHumanInput(event.data)) state.lastHuman = { message: event.data, seq: event.seq }
      return
    }
    if (event.type === 'turn/start') {
      // The input that began this turn is whatever the user last sent.
      state.turnInput = state.lastHuman
    }
  })

  const disposeLifecycle = ctx.on('session/disposed', (session) => {
    bySession.delete(session.header.id)
  })

  return {
    /**
     * Read the input that began one session's current turn.
     * @param sessionId - the session to describe.
     * @returns the message and sequence number, or undefined when none is known.
     */
    inputFor(sessionId) {
      const state = bySession.get(sessionId)
      return state?.turnInput ?? state?.lastHuman
    },

    /**
     * Stop observing.
     * @returns nothing.
     */
    dispose() {
      disposeListener()
      disposeLifecycle()
      bySession.clear()
    },
  }
}

/**
 * Build the provenance entry for one remember call, plus the texts a write must
 * screen before truncation.
 *
 * `quote` and the session id are the primary provenance; the event sequence is
 * best effort and stays empty when it cannot be determined, because a guessed
 * reference would be worse than none. The complete message travels separately
 * from the truncated quote: a credential cut off at the truncation point would no
 * longer match any pattern while still carrying most of the secret.
 * @param agent - the agent performing the write.
 * @param tracker - the turn observer.
 * @param options - evidence inputs.
 * @param options.evidenceQuoteMaxChars - largest retained quote, in code points.
 * @param options.now - clock source.
 * @returns the evidence entry and the complete texts to screen.
 */
export function buildProvenance(agent, tracker, options) {
  const sessionId = agent?.session?.header?.id
  if (typeof sessionId !== 'string' || sessionId === '') {
    return { evidence: undefined, sourceTexts: [] }
  }
  const observedAt = new Date((options.now ?? Date.now)()).toISOString()
  const input = tracker.inputFor(sessionId)
  if (input === undefined) {
    return {
      evidence: { session_id: sessionId, event_seqs: [], kind: 'user', quote: '', observed_at: observedAt },
      sourceTexts: [],
    }
  }
  const fullText = textOfMessage(input.message)
  return {
    evidence: {
      session_id: sessionId,
      event_seqs: Number.isInteger(input.seq) ? [input.seq] : [],
      kind: 'user',
      quote: truncateChars(fullText, options.evidenceQuoteMaxChars),
      observed_at: observedAt,
    },
    sourceTexts: fullText === '' ? [] : [fullText],
  }
}

/**
 * Whether one message came from the user rather than from an injected context.
 * @param message - the candidate message.
 * @returns true when the message is human input.
 */
function isHumanInput(message) {
  return message?.source?.kind === 'user'
}

/**
 * Join the text blocks of one message.
 * @param message - the message to read.
 * @returns its text content.
 */
function textOfMessage(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}
