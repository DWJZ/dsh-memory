/**
 * What one scope's index keeps, and in which order.
 *
 * The injected index and the generated `MEMORY.md` are both ordered here, so a
 * human reading the file and a model reading the index never see the same
 * records in different orders.
 *
 * Confidence deliberately plays no part: Phase 1 only ever writes 1.0, so it
 * carries no information to rank by.
 *
 * @module dsh-memory/retention
 */

/** Category order used for display; earlier categories survive trimming first. */
export const CATEGORY_PRIORITY = Object.freeze([
  'preference',
  'feedback',
  'decision',
  'lesson',
  'state',
  'reference',
])

/**
 * Rank of one category.
 * @param category - the record's category.
 * @returns the position in {@link CATEGORY_PRIORITY}; unknown categories sort last.
 */
export function categoryRank(category) {
  const index = CATEGORY_PRIORITY.indexOf(category)
  return index < 0 ? CATEGORY_PRIORITY.length : index
}

/**
 * Order two records for display: category priority, then most recently updated,
 * then id so the order is total and reproducible.
 * @param left - one record.
 * @param right - the other record.
 * @returns a negative number when `left` sorts first.
 */
export function compareRecords(left, right) {
  const byCategory = categoryRank(left.category) - categoryRank(right.category)
  if (byCategory !== 0) return byCategory
  if (left.updated_at !== right.updated_at) return left.updated_at < right.updated_at ? 1 : -1
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
}

/**
 * Keep the records ordinary retrieval and injection may see.
 * @param records - every record in one scope.
 * @returns the active records, ordered by {@link compareRecords}.
 */
export function activeRecords(records) {
  return records.filter(record => record.status === 'active').sort(compareRecords)
}

/**
 * One injected index line for a record.
 * @param record - the record to render.
 * @returns the line, carrying only the category and the fact.
 */
export function indexLine(record) {
  return `- [${record.category}] ${record.content}`
}

/**
 * Render the always-visible Memory index within a byte budget.
 *
 * The budget is measured in UTF-8 bytes, because a JavaScript string length
 * counts UTF-16 code units and would undercount Chinese by a factor of three.
 * Lines are dropped whole — a truncated fact would be worse than an absent one —
 * and `split` decides which scope yields first when both are over their share.
 *
 * When nothing fits, the index is empty rather than an empty shell: an envelope
 * with no content costs bytes every turn and tells the model nothing.
 * @param scopes - the active records of each scope.
 * @param scopes.user - user-scope records.
 * @param scopes.project - the current project's records.
 * @param options - budget inputs.
 * @param options.budgetBytes - the largest injected size, in UTF-8 bytes.
 * @param options.split - how the budget is divided when both scopes contend.
 * @returns the index text, or an empty string when nothing fits.
 */
export function renderMemoryIndex(scopes, options) {
  const split = options.split ?? { user: 0.5, project: 0.5 }
  let userLines = activeRecords(scopes.user ?? []).map(indexLine)
  let projectLines = activeRecords(scopes.project ?? []).map(indexLine)

  for (;;) {
    if (userLines.length === 0 && projectLines.length === 0) return ''
    const text = assembleIndex(userLines, projectLines)
    if (byteLength(text) <= options.budgetBytes) return text
    const target = contendedScope(userLines, projectLines, split)
    if (target === 'user') userLines = userLines.slice(0, -1)
    else projectLines = projectLines.slice(0, -1)
  }
}

/**
 * Assemble the index envelope around the surviving lines.
 * @param userLines - surviving user-scope lines.
 * @param projectLines - surviving project-scope lines.
 * @returns the complete injected text.
 */
function assembleIndex(userLines, projectLines) {
  const parts = ['<memory-index>', '']
  if (userLines.length > 0) parts.push('user:', ...userLines, '')
  if (projectLines.length > 0) parts.push('project:', ...projectLines, '')
  parts.push('</memory-index>', '')
  return parts.join('\n')
}

/**
 * Decide which scope yields one line.
 * @param userLines - surviving user-scope lines.
 * @param projectLines - surviving project-scope lines.
 * @param split - the configured share of each scope.
 * @returns the scope to drop from.
 */
function contendedScope(userLines, projectLines, split) {
  if (projectLines.length === 0) return 'user'
  if (userLines.length === 0) return 'project'
  const userShare = Math.max(split.user ?? 0, Number.EPSILON)
  const projectShare = Math.max(split.project ?? 0, Number.EPSILON)
  const userPressure = byteLength(userLines.join('\n')) / userShare
  const projectPressure = byteLength(projectLines.join('\n')) / projectShare
  return userPressure >= projectPressure ? 'user' : 'project'
}

/**
 * Measure text the way the budget is expressed.
 * @param text - the text to measure.
 * @returns its length in UTF-8 bytes.
 */
export function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}
