/**
 * Memory schema suite.
 *
 * Every rule here is a precondition for a record reaching `memories.json`, so
 * each assertion is about a record the store must refuse — or must accept — on
 * its way in.
 *
 * Usage: `node test/schema.spec.mjs`.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const schema = await import(pathToFileURL(join(PLUGIN, 'src/schema.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const AT = '2026-09-26T00:00:00.000Z'
const LATER = '2026-09-26T01:00:00.000Z'

/** One valid evidence entry. */
const evidence = (overrides = {}) => ({
  session_id: 'session-abc',
  event_seqs: [41],
  kind: 'user',
  quote: '记住，这个项目以后使用 pnpm',
  observed_at: AT,
  ...overrides,
})

/** One valid project-scoped record. */
const record = (overrides = {}) => ({
  id: schema.newMemoryId(),
  scope: 'project',
  project_id: schema.newProjectId(),
  category: 'state',
  content: '该项目使用 pnpm',
  confidence: 1.0,
  evidence: [evidence()],
  created_at: AT,
  updated_at: AT,
  status: 'active',
  superseded_by: null,
  ...overrides,
})

/** Whether validating this record throws, naming the field when given. */
const rejects = (candidate, field, maxEvidencePerMemory = 8) => {
  try {
    schema.validateMemory(candidate, { maxEvidencePerMemory })
    return false
  } catch (error) {
    return error instanceof TypeError && (field === undefined || error.message.includes(field))
  }
}

console.log('a well-formed record is accepted')
schema.validateMemory(record(), { maxEvidencePerMemory: 8 })
check('project scope with an evidence list and an active status', true)
schema.validateMemory(record({ scope: 'user', project_id: null, category: 'preference' }), { maxEvidencePerMemory: 8 })
check('user scope with a null project_id', true)
schema.validateMemory(record({ status: 'superseded', superseded_by: schema.newMemoryId() }), { maxEvidencePerMemory: 8 })
check('a superseded record naming its successor', true)
schema.validateMemory(record({ status: 'archived' }), { maxEvidencePerMemory: 8 })
check('an archived record', true)
schema.validateMemory(record({ evidence: [] }), { maxEvidencePerMemory: 8 })
check('a record with no evidence', true)
for (const category of schema.CATEGORIES) {
  schema.validateMemory(record({ category }), { maxEvidencePerMemory: 8 })
}
check('every declared category is accepted', true)
for (const kind of schema.EVIDENCE_KINDS) {
  schema.validateMemory(record({ evidence: [evidence({ kind })] }), { maxEvidencePerMemory: 8 })
}
check('every declared evidence kind is accepted', true)

console.log('invalid_schema')
check('a non-object is rejected', rejects('record'))
check('an array is rejected', rejects([]))
check('a missing id is rejected', rejects(record({ id: '' }), 'id'))
check('an unknown scope is rejected', rejects(record({ scope: 'session' }), 'scope'))
check('an unknown category is rejected', rejects(record({ category: 'misc' }), 'category'))
check('an unknown status is rejected', rejects(record({ status: 'deleted' }), 'status'))
check('a project record without project_id is rejected',
  rejects(record({ project_id: null }), 'project_id'))
check('a user record carrying a project_id is rejected',
  rejects(record({ scope: 'user', project_id: schema.newProjectId() }), 'project_id'))
check('an empty content is rejected', rejects(record({ content: '   ' }), 'content'))
check('multi-line content is rejected', rejects(record({ content: 'first\nsecond' }), 'content'))
check('content over 500 code points is rejected',
  rejects(record({ content: '记'.repeat(501) }), 'content'))
check('content of exactly 500 code points is accepted',
  !rejects(record({ content: '记'.repeat(500) }), 'content'))
check('content counts emoji as one code point',
  !rejects(record({ content: '😀'.repeat(500) }), 'content'))
check('a missing confidence is rejected', rejects(record({ confidence: undefined }), 'confidence'))
check('a non-numeric confidence is rejected', rejects(record({ confidence: '1.0' }), 'confidence'))
check('superseded without superseded_by is rejected',
  rejects(record({ status: 'superseded' }), 'superseded_by'))
check('an active record carrying superseded_by is rejected',
  rejects(record({ superseded_by: schema.newMemoryId() }), 'superseded_by'))
check('a malformed created_at is rejected', rejects(record({ created_at: '2026-09-26' }), 'created_at'))
check('a malformed updated_at is rejected', rejects(record({ updated_at: 'yesterday' }), 'updated_at'))
check('updated_at before created_at is rejected',
  rejects(record({ created_at: LATER, updated_at: AT }), 'updated_at'))
check('a non-array evidence is rejected', rejects(record({ evidence: {} }), 'evidence'))
check('too much evidence is rejected',
  rejects(record({ evidence: [evidence(), evidence()] }), 'evidence', 1))
check('evidence at the cap is accepted',
  !rejects(record({ evidence: [evidence(), evidence()] }), 'evidence', 2))
check('an unknown evidence kind is rejected',
  rejects(record({ evidence: [evidence({ kind: 'system' })] }), 'kind'))
check('an empty evidence session_id is rejected',
  rejects(record({ evidence: [evidence({ session_id: '' })] }), 'session_id'))
check('a non-string quote is rejected',
  rejects(record({ evidence: [evidence({ quote: 7 })] }), 'quote'))
check('a non-integer event seq is rejected',
  rejects(record({ evidence: [evidence({ event_seqs: [1.5] })] }), 'event_seqs'))
check('a negative event seq is rejected',
  rejects(record({ evidence: [evidence({ event_seqs: [-1] })] }), 'event_seqs'))
check('an empty event_seqs list is accepted',
  !rejects(record({ evidence: [evidence({ event_seqs: [] })] }), 'event_seqs'))
check('a malformed observed_at is rejected',
  rejects(record({ evidence: [evidence({ observed_at: 'now' })] }), 'observed_at'))

console.log('confidence_range_schema')
check('confidence 0 is accepted', !rejects(record({ confidence: 0 }), 'confidence'))
check('confidence 0.5 is accepted', !rejects(record({ confidence: 0.5 }), 'confidence'))
check('confidence 1 is accepted', !rejects(record({ confidence: 1 }), 'confidence'))
check('confidence -0.1 is rejected', rejects(record({ confidence: -0.1 }), 'confidence'))
check('confidence 1.1 is rejected', rejects(record({ confidence: 1.1 }), 'confidence'))
check('confidence NaN is rejected', rejects(record({ confidence: Number.NaN }), 'confidence'))

console.log('identity')
const first = schema.newMemoryId()
const second = schema.newMemoryId()
check('memory ids carry the mem_ prefix', first.startsWith('mem_'))
check('memory ids are unique', first !== second)
check('memory ids carry a uuid payload',
  /^mem_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(first))
check('project ids carry the proj_ prefix', schema.newProjectId().startsWith('proj_'))

console.log('normalizeContent')
check('surrounding whitespace is trimmed', schema.normalizeContent('  a  ') === 'a')
check('runs of whitespace collapse to one space', schema.normalizeContent('a \t\n b') === 'a b')
check('a decomposed sequence composes to NFC', schema.normalizeContent('e\u0301') === '\u00e9')
check('NFC keeps full-width forms distinct from half-width',
  schema.normalizeContent('ｐｎｐｍ') === 'ｐｎｐｍ' && schema.normalizeContent('ｐｎｐｍ') !== 'pnpm')
check('case is preserved', schema.normalizeContent('Model-X') === 'Model-X')
check('case is not folded', schema.normalizeContent('FOO') !== schema.normalizeContent('foo'))
check('an empty string normalizes to empty', schema.normalizeContent('   ') === '')

console.log('code-point limits')
check('charLength counts emoji as one', schema.charLength('a😀b') === 3)
check('truncateChars keeps whole code points', schema.truncateChars('a😀b', 2) === 'a😀')
check('truncateChars returns short input unchanged', schema.truncateChars('ab', 5) === 'ab')
check('truncateChars to zero yields empty', schema.truncateChars('ab', 0) === '')
check('isTimestamp accepts a canonical instant', schema.isTimestamp(AT))
check('isTimestamp rejects a date without time', !schema.isTimestamp('2026-09-26'))
check('isTimestamp rejects a non-UTC offset', !schema.isTimestamp('2026-09-26T00:00:00.000+08:00'))

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
