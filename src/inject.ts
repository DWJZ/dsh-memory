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
 * @module dsh-reflection/inject
 */

import { truncateChars } from './schema.js'
import type { Context } from '@deepseek-ai/cordis'
import type { Provenance } from './types/memory.js'

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

/** Stable name of the Memory policy section. */
export const MEMORY_POLICY_NAME = 'memory:policy'

/**
 * Where the policy sits among the prompt sections.
 *
 * The harness allocates named positions for its own sections; a local plugin has
 * no name there, so this is a literal like the index context order. It lands
 * just before the tool sections, so the model reads the rule before the tool
 * catalogue that acts on it.
 */
export const MEMORY_POLICY_ORDER = 950

/**
 * The boundary between the two paths into Memory.
 *
 * This is a prompt section rather than part of the tool description because a
 * description only speaks once the model is already considering the tool. A real
 * run showed the model deciding on its own that a statement was worth keeping and
 * calling `memory_remember` on it, which takes that decision away from
 * consolidation and makes what Memory holds depend on the model's tool-calling
 * habits. The rule belongs in front of the turn, not attached to the call.
 */
export const MEMORY_POLICY_TEXT = [
  'Memory has two separate paths, and they are not interchangeable.',
  '',
  'Call `memory_remember` only when the user explicitly asks for something to be remembered,',
  'saved, or kept for later sessions — "记住", "记一下", "remember this", "save this to memory".',
  '',
  'Do not call it because information looks important, durable, useful, or likely to matter later.',
  'When the user merely states a preference, a project fact, or a decision without asking for it to be kept,',
  'leave it to the consolidation subsystem, which reads the finished turn and decides whether it becomes Memory.',
  'Persisting it yourself instead removes that judgement from the subsystem, and makes what Memory holds depend',
  'on your own reading of the turn.',
].join('\n')

/**
 * Register the Memory policy section.
 * @param ctx - the injection scope that owns the runtime.
 * @returns the disposer that removes the section.
 */
export function registerMemoryPolicy(ctx: Context) {
  return ctx.systemPrompt.section({
    name: MEMORY_POLICY_NAME,
    order: MEMORY_POLICY_ORDER,
    text: MEMORY_POLICY_TEXT,
  })
}

/**
 * Register the always-visible Memory index.
 * @param ctx - Cordis context of this plugin's fiber.
 * @param render - builds the index text for one agent; must be synchronous.
 * @returns the exact disposer that removes the contribution.
 */
export function registerMemoryIndex(ctx: Context, render: (agent: MemoryAgent) => string): () => void {
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
export function createTurnTracker(ctx: Context) {
  const bySession = new Map()

  const stateOf = (sessionId: string) => {
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
    inputFor(sessionId: string) {
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
 * @param {object} options - evidence inputs.
 * @param options.evidenceQuoteMaxChars - largest retained quote, in code points.
 * @param options.now - clock source.
 * @returns the evidence entry and the complete texts to screen.
 */
export function buildProvenance(
  agent: MemoryAgent,
  tracker: ReturnType<typeof createTurnTracker>,
  options: { evidenceQuoteMaxChars: number; now?: (() => number) | undefined },
): Provenance {
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
function isHumanInput(message: { source?: { kind?: string } } | null | undefined): boolean {
  return message?.source?.kind === 'user'
}

/**
 * Join the text blocks of one message.
 * @param message - the message to read.
 * @returns its text content.
 */
function textOfMessage(message: { content?: unknown } | null | undefined) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}
