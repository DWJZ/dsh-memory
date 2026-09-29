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
 * @param request - the consolidation request.
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
  let finished = false
  for await (const chunk of ctx.llm.stream(options)) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    if (chunk?.type === 'finish') finished = true
  }
  if (!finished) throw new Error('dsh-memory: the consolidation call ended without a finish reason')
  if (text.trim() === '') throw new Error('dsh-memory: the consolidation model produced no text')
  return text
}
