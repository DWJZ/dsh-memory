/**
 * Valid records for the suites.
 *
 * Identity is minted rather than written by hand: a store now refuses an id that
 * this plugin could not have produced, which is what keeps a project id from
 * becoming a path outside the Memory root. Suites that need a specific id pass
 * one in.
 *
 * Usage: `import { memoryRecord, projectId, AT } from './fixtures/records.mjs'`.
 */

import { newMemoryId, newProjectId } from '../../src/schema.js'

/** One canonical timestamp the suites reuse. */
export const AT = '2026-09-26T00:00:00.000Z'

/** A later canonical timestamp, for ordering assertions. */
export const LATER = '2026-09-27T00:00:00.000Z'

/**
 * One valid Memory record.
 * @param overrides - fields to replace.
 * @returns the record.
 */
export function memoryRecord(overrides = {}) {
  return {
    id: newMemoryId(),
    scope: 'user',
    project_id: null,
    category: 'state',
    content: 'a fact',
    confidence: 1,
    evidence: [],
    created_at: AT,
    updated_at: AT,
    status: 'active',
    superseded_by: null,
    ...overrides,
  }
}

/**
 * One valid project-scoped record.
 * @param projectIdValue - the owning project.
 * @param overrides - fields to replace.
 * @returns the record.
 */
export function projectMemoryRecord(projectIdValue, overrides = {}) {
  return memoryRecord({ scope: 'project', project_id: projectIdValue, ...overrides })
}

/**
 * Mint one project id.
 * @returns a project id.
 */
export function projectId() {
  return newProjectId()
}

/**
 * Mint one Memory id.
 * @returns a Memory id.
 */
export function memoryId() {
  return newMemoryId()
}
