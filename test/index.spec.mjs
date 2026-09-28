/**
 * Index injection suite.
 *
 * Two properties carry the weight: the injected text never exceeds its byte
 * budget, and it only ever contains whole lines. A truncated fact would mislead
 * the model more than an absent one, and an over-budget index is paid for on
 * every turn.
 *
 * Usage: `node test/index.spec.mjs`.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { renderMemoryIndex, indexLine, byteLength, compareRecords } = await import(pathToFileURL(join(PLUGIN, 'src/retention.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const AT = '2026-09-26T00:00:00.000Z'

/** One record shaped well enough for rendering. */
const record = (overrides = {}) => ({
  id: 'mem_a',
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
})

/** N user records with predictable content. */
const many = (count, content, overrides = {}) => Array.from({ length: count }, (_, index) => record({
  id: `mem_${String(index)}`,
  content: `${content} ${String(index)}`,
  ...overrides,
}))

const render = (scopes, budgetBytes, split) => renderMemoryIndex(scopes, { budgetBytes, split })

console.log('index_generation')
const index = render({
  user: [record({ category: 'preference', content: '用户偏好中文解释' })],
  project: [record({ scope: 'project', project_id: 'proj_a', category: 'state', content: '该项目使用 pnpm' })],
}, 6000, { user: 0.4, project: 0.6 })
check('the envelope is present', index.startsWith('<memory-index>') && index.includes('</memory-index>'))
check('the user scope is labelled', index.includes('\nuser:\n'))
check('the project scope is labelled', index.includes('\nproject:\n'))
check('a line carries the category and the fact', index.includes('- [preference] 用户偏好中文解释'))
check('the project fact is present', index.includes('- [state] 该项目使用 pnpm'))
check('no id is injected', !index.includes('mem_'))
check('no confidence is injected', !index.includes('confidence'))
check('no timestamp is injected', !index.includes(AT))
check('no evidence is injected', !index.includes('session'))

console.log('an empty index is not an envelope')
check('both scopes empty renders nothing', render({ user: [], project: [] }, 6000, { user: 0.4, project: 0.6 }) === '')
check('missing scopes render nothing', render({}, 6000, { user: 0.4, project: 0.6 }) === '')
check('an inactive-only scope renders nothing',
  render({ user: [record({ status: 'archived' })], project: [] }, 6000, { user: 0.4, project: 0.6 }) === '')
check('a superseded record is excluded',
  render({ user: [record({ status: 'superseded', superseded_by: 'mem_x' })], project: [] }, 6000, { user: 0.4, project: 0.6 }) === '')
check('only the populated scope is labelled',
  !render({ user: [record()], project: [] }, 6000, { user: 0.4, project: 0.6 }).includes('project:'))

console.log('ordering matches the shared comparator')
const ordered = render({
  user: [
    record({ id: 'mem_ref', category: 'reference', content: 'reference fact' }),
    record({ id: 'mem_pref', category: 'preference', content: 'preference fact' }),
  ],
  project: [],
}, 6000, { user: 0.4, project: 0.6 })
check('a higher-priority category comes first',
  ordered.indexOf('preference fact') < ordered.indexOf('reference fact'))
check('the comparator agrees with the render order',
  compareRecords(record({ category: 'preference' }), record({ category: 'reference' })) < 0)

console.log('budget_limit')
const SOURCE = { user: many(20, '用户偏好条目'), project: many(20, '项目条目', { scope: 'project', project_id: 'proj_a' }) }
for (const budgetBytes of [0, 1, 50, 200, 1000, 3000]) {
  const rendered = render(SOURCE, budgetBytes, { user: 0.4, project: 0.6 })
  check(`a budget of ${String(budgetBytes)} bytes is respected`,
    byteLength(rendered) <= budgetBytes, `${String(byteLength(rendered))} bytes`)
}
check('a generous budget keeps every record',
  (render(SOURCE, 100000, { user: 0.4, project: 0.6 }).match(/^- /gmu) ?? []).length === 40)
check('a tiny budget keeps nothing rather than a shell',
  render(SOURCE, 10, { user: 0.4, project: 0.6 }) === '')

console.log('lines are never truncated')
const partial = render(SOURCE, 300, { user: 0.4, project: 0.6 })
const partialLines = partial.split('\n').filter(line => line.startsWith('- '))
const known = new Set([...SOURCE.user, ...SOURCE.project].map(indexLine))
check('every line is a complete record line', partialLines.every(line => known.has(line)))
check('no line was cut short', partialLines.every(line => !line.endsWith(' ')))
check('at least one line survived', partialLines.length > 0)

console.log('budget_ascii_bytes and budget_chinese_utf8_bytes')
// Both sources carry the same number of characters per line, so the only
// difference between them is what those characters cost in UTF-8 bytes.
const asciiSource = { user: many(8, 'abcdefghij'), project: [] }
const chineseSource = { user: many(8, '中文字条目内容啊啊啊'), project: [] }
const kept = (source, budgetBytes) => (render(source, budgetBytes, { user: 1, project: 0 }).match(/^- /gmu) ?? []).length
const fullAscii = render(asciiSource, 1_000_000, { user: 1, project: 0 })
const asciiBudget = byteLength(fullAscii)
check('an ASCII line is about its character count in bytes',
  byteLength(indexLine(asciiSource.user[0])) - 12 === 10)
check('a Chinese line costs about three bytes per character',
  byteLength(indexLine(chineseSource.user[0])) - 12 === 30)
check('ASCII keeps every line at its own full size', kept(asciiSource, asciiBudget) === 8)
check('a Chinese line costs more than an ASCII line of the same length',
  byteLength(indexLine(chineseSource.user[0])) > byteLength(indexLine(asciiSource.user[0])))
check('the same budget keeps fewer Chinese lines', kept(chineseSource, asciiBudget) < 8)

console.log('budget_exact_boundary and budget_over_by_one_byte')
const boundarySource = { user: many(4, 'boundary-fact'), project: [] }
const full = render(boundarySource, 100000, { user: 1, project: 0 })
const fullBytes = byteLength(full)
check('four lines are rendered when the budget is ample', (full.match(/^- /gmu) ?? []).length === 4)
check('a budget of exactly the rendered size keeps every line',
  render(boundarySource, fullBytes, { user: 1, project: 0 }) === full)
const overByOne = render(boundarySource, fullBytes - 1, { user: 1, project: 0 })
check('one byte less drops a whole line', (overByOne.match(/^- /gmu) ?? []).length === 3)
check('the shortened index still fits', byteLength(overByOne) <= fullBytes - 1)
check('the dropped line is the last one',
  overByOne.split('\n').filter(line => line.startsWith('- ')).at(-1) === indexLine(boundarySource.user[2]))

console.log('the split decides who yields first')
const CONTENDED_BUDGET = 250
const contended = render({
  user: many(6, 'user-entry'),
  project: many(6, 'project-entry', { scope: 'project', project_id: 'proj_a' }),
}, CONTENDED_BUDGET, { user: 0.4, project: 0.6 })
const countOf = (text, label) => {
  const after = text.split(`\n${label}:\n`)[1]
  if (after === undefined) return 0
  // A section ends at the next label or at the envelope, whichever comes first.
  const body = after.split(/\n(?:user|project):\n|<\/memory-index>/u)[0]
  return (body.match(/^- /gmu) ?? []).length
}
check('the budget forces both scopes to yield',
  countOf(contended, 'user') + countOf(contended, 'project') < 12)
check('the scope with the smaller share yields more lines',
  countOf(contended, 'project') > countOf(contended, 'user'))
check('both scopes still contribute', countOf(contended, 'user') > 0 && countOf(contended, 'project') > 0)
check('the contended index respects the budget', byteLength(contended) <= CONTENDED_BUDGET)
const tilted = render({
  user: many(6, 'user-entry'),
  project: many(6, 'project-entry', { scope: 'project', project_id: 'proj_a' }),
}, CONTENDED_BUDGET, { user: 0.9, project: 0.1 })
check('reversing the split reverses who yields',
  countOf(tilted, 'user') > countOf(contended, 'user'))
check('the tilted index respects the budget', byteLength(tilted) <= CONTENDED_BUDGET)

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
