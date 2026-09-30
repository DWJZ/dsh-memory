/**
 * Commit a reviewed plan through the Phase 1 actions.
 *
 * There is no second storage path. Every operation becomes the same
 * `addMemory` / `updateMemory` / `supersedeMemory` call an explicit request
 * makes, so it takes the same lock, passes the same secret screening, is checked
 * against the same canonical schema, and rebuilds the same derived view.
 *
 * Three outcomes are distinguished, because the caller's next move depends on
 * which one happened:
 *
 * - `committed` — Memory changed.
 * - `skipped` — the action declined to write: a duplicate, or a target that
 *   moved between review and commit. Memory is unchanged and nothing is wrong;
 *   re-running would reach the same conclusion, so this must not hold the
 *   progress mark back.
 * - `failed` — the write itself did not happen. This is what keeps the mark in
 *   place so the window is retried.
 *
 * Usage: `const outcome = await commitOperations(options, accepted)`.
 */

import type { ActionOptions, AutoOperation } from '../types/memory.js'
import { addMemory, supersedeMemory, updateMemory } from '../actions.js'
import type { ReviewedOperation } from './validate.js'

/** Actions that leave Memory unchanged without anything having gone wrong. */
const NON_WRITES = Object.freeze(['noop', 'conflict'])

/** What one Phase 1 action reports back. */
interface ActionOutcome {
  /** `noop` or `conflict` when the action declined, absent when it wrote. */
  action?: string | undefined
  /** The record the action touched, when it named one. */
  id?: string | null | undefined
  /** Why it declined, when it did. */
  reason?: unknown
}

/** One operation, paired with what committing it produced. */
export interface AppliedOperation {
  operation: AutoOperation
  outcome: ActionOutcome | undefined
}

/** The tally `commitOperations` reports. */
export interface CommitOutcome {
  /** Writes that changed Memory, by action. */
  committed: { add: number; update: number; supersede: number }
  /** Operations the actions declined, with the reason. */
  skipped: { operation: AutoOperation; reason: string }[]
  /** Operations whose write did not happen. */
  failures: { operation: AutoOperation; message: string }[]
  /** Every operation and its result, in proposal order. */
  applied: AppliedOperation[]
}

/**
 * Write every accepted operation, one at a time.
 *
 * A failure does not stop the remaining operations: Phase 1 has already
 * committed whatever came before, so stopping would leave the same partial state
 * with less information about what happened. The caller decides what a partial
 * commit means for progress.
 * @param options - Phase 1 action options: scopes, thresholds, and logger.
 * @param operations - the accepted operations, in proposal order.
 * @returns the tally, the per-operation results, and any failures.
 */
export async function commitOperations(
  options: ActionOptions,
  operations: readonly ReviewedOperation[],
): Promise<CommitOutcome> {
  const committed = { add: 0, update: 0, supersede: 0 }
  const skipped: CommitOutcome['skipped'] = []
  const failures: CommitOutcome['failures'] = []
  const applied: AppliedOperation[] = []
  for (const operation of operations) {
    try {
      const outcome: ActionOutcome | undefined = await apply(options, operation)
      applied.push({ operation, outcome })
      if (outcome?.action === undefined || NON_WRITES.includes(outcome.action)) {
        const reason = outcome?.reason
        skipped.push({
          operation,
          reason: typeof reason === 'string' ? reason : outcome?.action ?? 'declined',
        })
        continue
      }
      committed[operation.action] += 1
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      failures.push({ operation, message })
    }
  }
  return { committed, skipped, failures, applied }
}

/**
 * Route one operation to its Phase 1 action.
 * @param options - Phase 1 action options.
 * @param operation - the accepted operation.
 * @returns the action's result.
 */
function apply(options: ActionOptions, operation: AutoOperation): Promise<ActionOutcome> {
  switch (operation.action) {
    case 'add':
      return addMemory(options, {
        content: operation.content,
        scope: operation.scope,
        category: operation.category,
        projectId: operation.projectId,
        evidence: operation.evidence,
        sourceTexts: operation.sourceTexts,
        confidence: operation.confidence,
      })
    case 'update':
      // The project comes from the reviewed target, never from the model, and it
      // has to be passed on: `updateMemory` uses it to decide which scopes the
      // target may be found in, so omitting it makes a project target invisible
      // and turns a valid update into a failed operation.
      return updateMemory(options, {
        id: operation.target_id,
        content: operation.content,
        projectId: operation.projectId,
        evidence: operation.evidence,
        sourceTexts: operation.sourceTexts,
        confidence: operation.confidence,
      })
    case 'supersede':
      return supersedeMemory(options, {
        id: operation.target_id,
        content: operation.content,
        projectId: operation.projectId,
        evidence: operation.evidence,
        sourceTexts: operation.sourceTexts,
        confidence: operation.confidence,
      })
    default:
      // The union says these three are all that arrive, because the validator
      // refuses anything else first. This stays as the runtime guard for a caller
      // that reaches here without validating model output.
      throw new Error(`dsh-memory: ${String((operation as { action: unknown }).action)} is not an automatic action`)

}
}
