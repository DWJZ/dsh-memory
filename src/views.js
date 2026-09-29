/**
 * The generated `MEMORY.md` view.
 *
 * `memories.json` is the source of truth; this file is derived, human-readable,
 * and disposable. Two rules follow from that and are both implemented here:
 * the view shows only active Memory, so a reader never mistakes a superseded
 * decision for a current one, and a failed rebuild never fails the mutation that
 * triggered it — otherwise a caller retrying on failure would ADD a second copy.
 *
 * The rebuild reads the latest canonical state under the store lock rather than
 * reusing the state that triggered it, so a slow writer cannot overwrite a newer
 * view with an older one.
 *
 * @module dsh-memory/views
 */

import { readStore, writeAtomic, withStore } from './jsonstore.js'
import { withLock } from './lock.js'
import { CATEGORY_PRIORITY, activeRecords } from './retention.js'

/** Marker identifying the revision a view was rendered from. */
const REVISION_MARKER = 'dsh-memory: revision'

/**
 * Render one scope's active Memory as Markdown.
 * @param records - every record in the scope, including inactive ones.
 * @param {object} options - render inputs.
 * @param options.revision - canonical revision the render reflects.
 * @returns the complete file content.
 */
export function renderMemoryView(records, options = {}) {
  const revision = options.revision ?? 0
  const active = activeRecords(records)
  const lines = [
    '# Memory',
    '',
    '<!-- This file is generated from memories.json and will be overwritten. -->',
    `<!-- ${REVISION_MARKER} ${String(revision)} -->`,
    '',
  ]
  if (active.length === 0) {
    lines.push('No active Memory.')
    lines.push('')
    return lines.join('\n')
  }
  for (const category of CATEGORY_PRIORITY) {
    const group = active.filter(record => record.category === category)
    if (group.length === 0) continue
    lines.push(`## ${category}`, '')
    for (const record of group) lines.push(`- ${record.content}`)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Regenerate one scope's view from the latest canonical state.
 * @param {object} options - layout, lock thresholds, and optional logger.
 * @param options.storePath - absolute path of `memories.json`.
 * @param options.lockPath - absolute path of the store lock file.
 * @param options.viewPath - absolute path of `MEMORY.md`.
 * @param options.lockTimeoutMs - how long to wait for the lock.
 * @param options.staleLockMs - age at which a lock becomes reclaimable.
 * @returns the revision the view now reflects.
 * @throws when the lock cannot be taken or the view cannot be written.
 */
export async function rebuildView(options) {
  return withLock(options, () => {
    const store = readStore(options.storePath)
    writeAtomic(options.viewPath, renderMemoryView(store.records, { revision: store.revision }))
    return { revision: store.revision }
  })
}

/**
 * Commit one mutation, then refresh the view without letting the view decide the
 * mutation's outcome.
 * @param options - layout, lock thresholds, and optional logger.
 * @param operation - receives the latest store, returns `{ result, changed, records }`.
 * @returns the mutation result, the committed revision, and whether the view is stale.
 */
export async function mutateAndRefreshView(options, operation) {
  const outcome = await withStore(options, operation)
  let viewStale = false
  try {
    await rebuildView(options)
  } catch (error) {
    viewStale = true
    options.logger?.warn(`dsh-memory: memory-view-stale: ${options.viewPath}: ${String(error?.message ?? error)}`)
  }
  return { result: outcome.result, revision: outcome.revision, viewStale }
}
