/**
 * Scripted model adapter for the cross-session integration suite.
 *
 * It decides from the request it is given rather than from a recorded fixture:
 * a turn whose user text asks to remember something produces a Memory write, and
 * every other turn produces a plain answer. Each request is recorded verbatim so
 * the suite can assert on what the model was actually sent.
 *
 * Two guards keep it honest and bounded: a turn that already carries this
 * adapter's own call is answered with text, so a rejected call is never issued
 * again forever, and the session-title agent — which also sees the user's words —
 * is answered without tools.
 *
 * Test-only: nothing ships this file.
 */

import { appendFileSync, statSync } from 'node:fs'
// Imported by path because a plugin under `plugins/` has no workspace link to the
// harness packages, and this adapter exists only for the test harness.
import {
  LlmAdapter,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type StreamChunk,
  type ToolCallId,
} from '../../../../packages/llm/llm/src/index.ts'

/** The route this adapter owns. */
const PROVIDER = 'dsh-reflection-mock'

/** Context capacity this route declares; compaction pressure is computed against it. */
const WINDOW_TOKENS = Number(process.env.DSH_MEMORY_MOCK_WINDOW ?? 1_000_000)

/** Tokens the mock reports per call; the token meter reads this, so pressure follows it. */
const USAGE_TOKENS = Number(process.env.DSH_MEMORY_MOCK_USAGE ?? 1)

/** Where each request is recorded, when the harness set it. */
const LOG = process.env.DSH_MEMORY_MOCK_LOG

/** Largest log this adapter will write, so a runaway loop cannot fill the disk. */
const LOG_LIMIT_BYTES = 4 * 1024 * 1024

/** Source kind of the auxiliary agent that names a session. */
const TITLE_AGENT_SOURCE = 'dsh-session-title-llm'

/** Text that makes the model act; the suite sets it per scenario. */
const TRIGGER = process.env.DSH_MEMORY_MOCK_TRIGGER ?? '记住'

/** Arguments for a direct `memory_remember` call. */
const REMEMBER_ARGS = process.env.DSH_MEMORY_MOCK_REMEMBER ?? JSON.stringify({
  mode: 'add',
  content: '该项目使用 pnpm',
  scope: 'project',
  category: 'state',
})

/** Whether this run must search first and then supersede what it finds. */
const SUPERSEDE = process.env.DSH_MEMORY_MOCK_SUPERSEDE === '1'

/** Query used by the search step of a supersede run. */
const SEARCH_QUERY = process.env.DSH_MEMORY_MOCK_QUERY ?? 'package manager'

/** Marker that identifies the consolidation call's system prompt. */
const CONSOLIDATION_MARKER = 'You maintain long-term Memory'

/** What a scripted consolidation run should learn, when it should learn anything. */
const LEARNED = process.env.DSH_MEMORY_MOCK_LEARNED

/** Record one request exactly as the model received it. */
function record(options: GenerateOptions): void {
  if (LOG === undefined) return
  try {
    if (statSync(LOG).size > LOG_LIMIT_BYTES) return
  } catch {
    // The first write of this run creates the file.
  }
  appendFileSync(LOG, `${JSON.stringify({
    provider: options.provider,
    model: options.model,
    system: options.system ?? null,
    tools: (options.tools ?? []).map(tool => tool.name),
    messages: options.messages,
  })}\n`)
}

/** A plain answer, which ends the turn. */
function* answer(text: string): Generator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: USAGE_TOKENS, outputTokens: USAGE_TOKENS } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** One tool call, as the provider would stream it. */
function* call(name: string, args: unknown, callId: string): Generator<StreamChunk> {
  const encoded = JSON.stringify(args)
  const id = callId as ToolCallId
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id, name, argumentsDelta: encoded }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: encoded } }
  yield { type: 'usage', usage: { inputTokens: USAGE_TOKENS, outputTokens: USAGE_TOKENS } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

/**
 * Read the first Memory id a tool result reported.
 *
 * The result arrives as a JSON string inside the transcript, so its quotes are
 * escaped; matching the identifier itself survives that.
 * @param transcript - the serialized conversation.
 * @returns the id, or undefined when the search found nothing.
 */
function firstMemoryId(transcript: string): string | undefined {
  return /mem_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u.exec(transcript)?.[0]
}

/** One scripted adapter instance. */
class MemoryMockAdapter extends LlmAdapter {
  /**
   * Declare this route's context capacity. Compaction computes its pressure against
   * the routed model's window, so a small window is what makes compaction fire.
   * @param provider - one provider route owned by this adapter.
   * @param model - exact model id.
   * @returns the route identity plus the capacity it declares.
   */
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, context: { contextWindow: WINDOW_TOKENS } }
  }

  /**
   * Answer one request from its own content.
   * @param options - the request the model received.
   * @returns the streamed response.
   */
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    record(options)
    const transcript = JSON.stringify(options.messages)

    // The title agent sees the same user text but has no Memory tools; answering
    // it with a tool call would fail the very turn it exists to name.
    if (transcript.includes(TITLE_AGENT_SOURCE)) {
      yield * answer('session title')
      return
    }
    // Automatic consolidation is a different kind of call: it carries the memory
    // policy as its system prompt and asks for a plan rather than a turn. The
    // plan cites a sequence number the payload actually contains, as a real
    // consolidator would.
    if ((options.system ?? '').includes(CONSOLIDATION_MARKER)) {
      if (LEARNED === undefined) {
        yield * answer('{"operations":[]}')
        return
      }
      const text = String(options.messages?.[0]?.content?.[0]?.text ?? '')
      const seq = Number(/"seq":(\d+)/u.exec(text)?.[1] ?? -1)
      yield * answer(JSON.stringify({
        operations: [{
          action: 'add',
          scope: 'project',
          category: 'state',
          content: LEARNED,
          confidence: 0.95,
          evidence_event_seqs: [seq],
        }],
      }))
      return
    }
    // One call per transcript: a write that the plugin refused must not be
    // retried, or the turn would never end. The check looks for the tool-call
    // block itself, because the Memory policy section legitimately mentions the
    // tool by name in the prompt and a substring test would mistake the rule for
    // a call that had already happened.
    const alreadyCalled = transcript.includes('"name":"memory_remember"')
    if (!transcript.includes(TRIGGER) || alreadyCalled) {
      yield * answer('acknowledged')
      return
    }
    if (SUPERSEDE) {
      if (!transcript.includes('memory_search')) {
        yield * call('memory_search', { query: SEARCH_QUERY }, 'call_dsh_memory_search')
        return
      }
      const target = firstMemoryId(transcript)
      if (target !== undefined) {
        const replacement = JSON.parse(REMEMBER_ARGS) as { content: string }
        yield * call('memory_remember', {
          mode: 'supersede',
          target_id: target,
          content: replacement.content,
        }, 'call_dsh_memory_supersede')
        return
      }
    }
    yield * call('memory_remember', JSON.parse(REMEMBER_ARGS), 'call_dsh_memory_remember')
  }
}

/** Stable Cordis plugin name. */
export const name = 'dsh-reflection-mock-llm'

/** The adapter registry this plugin contributes to. */
export const inject = ['llm']

/**
 * Register the scripted route.
 * @param ctx - Cordis context of this plugin's fiber.
 */
export function apply(ctx: { llm: { registerAdapter(providers: string[], adapter: LlmAdapter): unknown } }): void {
  ctx.llm.registerAdapter([PROVIDER], new MemoryMockAdapter())
}
