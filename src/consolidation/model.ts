/**
 * One consolidation model call.
 *
 * The call reuses the Session's own route — whatever provider and model the
 * conversation is already using — rather than naming one in configuration. The
 * consolidator is reading a trajectory that model produced, so asking the same
 * model to judge it needs no second opinion and no second credential.
 *
 * `purpose` is deliberately not passed: its type is a closed set of the
 * harness's own special call sites, and consolidation is an ordinary call.
 *
 * Usage: `const answer = await callConsolidator(ctx, request)`.
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CONSOLIDATION_SYSTEM_PROMPT, buildRequest } from './policy.js'
import { failureCode, failureMessage } from '../errors.js'

/** The terminal reason a stream reports, as far as this call reads it. */
interface StreamFinish {
  readonly kind: string
  readonly failure?: { readonly code?: string; readonly message?: string } | undefined
}

/** The route a Session resolved, which the call reuses. */
interface SessionRoute {
  readonly provider?: string | undefined
  readonly model?: string | undefined
}

/**
 * What the Session must offer: its id, its resolved route, and its sequence.
 *
 * `requestHeader` is called unconditionally, not probed: a Session that has not
 * started yet raises its own error from that call, and replacing it with this
 * plugin's "no route" message would hide why the call could not be made.
 */
export interface ConsolidationSession {
  requestHeader(): { readonly config?: SessionRoute | undefined } | undefined
}

/** One request to the consolidation model. */
export interface ConsolidationRequest {
  /**
   * The Session being consolidated, when the caller has one. An absent Session
   * and a Session without a resolved route both end as "no resolved model route",
   * which is why the lookup short-circuits here rather than throwing.
   */
  session?: ConsolidationSession | undefined
  /** Its id, stamped onto the call so the adapter can attribute it. */
  sessionId: string
  /** First seq in the window. */
  fromSeq: number
  /** Last seq in the window. */
  toSeq: number
  /** The normalized trajectory, as `batchWindow` produced it. */
  entries: readonly unknown[]
  /** Active Memory the model may target. */
  existing: readonly unknown[]
  /** Largest answer to accept. */
  maxOutputTokens: number
  /** Cancellation from the maintenance task. */
  signal?: AbortSignal | undefined
}

/**
 * Ask the model for one operation plan.
 *
 * Streaming is consumed rather than collected through a helper: this plugin
 * carries no harness dependency at runtime, so it reads the chunk sequence the
 * adapter produces and keeps the text.
 * @param ctx - Cordis context of this plugin's fiber.
 * @param request - the consolidation request.
 * @returns the model's answer text.
 * @throws when the route is unknown, the call fails, or it produces no text.
 */
export async function callConsolidator(ctx: Context, request: ConsolidationRequest): Promise<string> {
  const route = request.session?.requestHeader()?.config
  const provider = route?.provider
  const model = route?.model
  if (typeof provider !== 'string' || typeof model !== 'string') {
    throw new Error('dsh-memory: this Session has no resolved model route to consolidate with')
  }

  const userMessage = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: buildRequest(request) }],
    source: { kind: 'dsh-memory-consolidation' },
  }

  let text = ''
  let reason: StreamFinish | undefined
  for await (const chunk of ctx.llm.stream({
    provider,
    model,
    system: CONSOLIDATION_SYSTEM_PROMPT,
    messages: [userMessage],
    maxTokens: request.maxOutputTokens,
    sessionId: request.sessionId,
    signal: request.signal,
  })) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    if (chunk.type === 'finish') reason = chunk.reason
  }
  // A stream can end having already produced parseable JSON and still not have
  // succeeded: a provider failure is normalized into a terminal `error` or
  // `aborted` finish, and a truncated answer arrives as `max-tokens`. Reading the
  // text without the reason would commit a plan the model never finished making,
  // and then advance the mark over it.
  if (reason === undefined) throw new Error('dsh-memory: the consolidation call ended without a finish reason')
  if (reason.kind === 'error' || reason.kind === 'aborted') {
    const failure = reason.failure
    throw new Error(`dsh-memory: the consolidation call ended as ${reason.kind}: ${failureCode(failure) ?? 'unknown'}: ${failureMessage(failure)}`)
  }
  // Consolidation declares no tools, so `tool-calls` is as unfinished as a
  // truncation. The reason map is merge-extensible, so anything not named here
  // fails the batch rather than being treated as success by default.
  if (reason.kind !== 'stop') {
    throw new Error(`dsh-memory: the consolidation call ended as ${String(reason.kind)}, which is not a completed answer`)
  }
  if (text.trim() === '') throw new Error('dsh-memory: the consolidation model produced no text')
  return text
}
