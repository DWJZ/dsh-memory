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
import { CONSOLIDATION_SYSTEM_PROMPT, buildRequest } from './policy.js'

/**
 * Ask the model for one operation plan.
 *
 * Streaming is consumed rather than collected through a helper: this plugin
 * carries no harness dependency at runtime, so it reads the chunk sequence the
 * adapter produces and keeps the text.
 * @param ctx - Cordis context of this plugin's fiber.
 * @param {object} request - the consolidation request.
 * @param request.session - the Session being consolidated.
 * @param request.sessionId - its id.
 * @param request.fromSeq - first seq in the window.
 * @param request.toSeq - last seq in the window.
 * @param request.entries - the normalized trajectory.
 * @param request.existing - active Memory the model may target.
 * @param request.maxOutputTokens - largest answer to accept.
 * @param request.signal - cancellation signal from the maintenance task.
 * @returns the model's answer text.
 * @throws when the route is unknown, the call fails, or it produces no text.
 */
export async function callConsolidator(ctx, request) {
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
  const options = {
    provider,
    model,
    system: CONSOLIDATION_SYSTEM_PROMPT,
    messages: [userMessage],
    maxTokens: request.maxOutputTokens,
    sessionId: request.sessionId,
    signal: request.signal,
  }

  let text = ''
  let reason
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    if (chunk?.type === 'finish') reason = chunk.reason
  }
  // A stream can end having already produced parseable JSON and still not have
  // succeeded: a provider failure is normalized into a terminal `error` or
  // `aborted` finish, and a truncated answer arrives as `max-tokens`. Reading the
  // text without the reason would commit a plan the model never finished making,
  // and then advance the mark over it.
  if (reason === undefined) throw new Error('dsh-memory: the consolidation call ended without a finish reason')
  if (reason.kind === 'error' || reason.kind === 'aborted') {
    const failure = reason.failure
    throw new Error(`dsh-memory: the consolidation call ended as ${reason.kind}: ${String(failure?.code ?? 'unknown')}: ${String(failure?.message ?? 'no message')}`)
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
