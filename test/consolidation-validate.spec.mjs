/**
 * Validation suite: what may be committed, what is dropped, and why the plugin
 * builds provenance instead of accepting it.
 *
 * Usage: `node test/consolidation-validate.spec.mjs`.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const validate = await import(pathToFileURL(join(PLUGIN, 'src/consolidation/validate.js')).href)
const { findSecret } = await import(pathToFileURL(join(PLUGIN, 'src/redact.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

/** A human turn event. */
const human = (seq, text) => ({ seq, type: 'user/message', data: { content: [{ type: 'text', text }], source: { kind: 'user' } } })
/** A tool result event. */
const toolResult = (seq, text) => ({ seq, type: 'tool/result', data: { message: { content: [{ type: 'text', text }] } } })
/** An assistant message event. */
const assistant = (seq, text) => ({ seq, type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } })

const EVENTS = [human(201, '以后这个项目用 pnpm'), toolResult(203, 'packageManager: pnpm@10'), assistant(206, '已切换')]
const EVENTS_BY_SEQ = new Map(EVENTS.map(event => [event.seq, event]))
const ACTIVE = [{
  id: 'mem_old',
  scope: 'project',
  project_id: 'proj_a',
  category: 'state',
  content: 'The project uses npm.',
  status: 'active',
}]

/**
 * The judging context these tests vary.
 * @param overrides - fields to replace.
 * @returns the context.
 */
const context = (overrides = {}) => ({
  fromSeq: 201,
  toSeq: 206,
  visibleSeqs: new Set([201, 203, 206]),
  eventsBySeq: EVENTS_BY_SEQ,
  existing: ACTIVE,
  projectId: 'proj_a',
  sessionId: 'session_a',
  minConfidence: validate.DEFAULT_MIN_CONFIDENCE,
  quoteMaxChars: 200,
  maxEvidencePerMemory: 8,
  now: () => Date.parse('2026-09-29T00:00:00.000Z'),
  ...overrides,
})

/**
 * Review one proposal against a context.
 * @param operation - the proposal.
 * @param overrides - context fields to replace.
 * @returns the review outcome.
 */
const review = (operation, overrides) => validate.reviewOperation(operation, context(overrides))

/** A valid project-scope addition. */
const addition = (overrides = {}) => ({
  action: 'add',
  scope: 'project',
  category: 'state',
  content: 'The project uses pnpm.',
  confidence: 0.94,
  evidence_event_seqs: [201, 203],
  ...overrides,
})

console.log('a well-grounded addition is accepted')
const accepted = review(addition())
check('the operation is accepted', accepted.kind === 'accepted', JSON.stringify(accepted))
check('the scope is kept', accepted.operation?.scope === 'project')
check('the project is attached', accepted.operation?.projectId === 'proj_a')
check('the confidence is kept', accepted.operation?.confidence === 0.94)

console.log('provenance is built, not accepted')
check('the cited seqs are recorded in order',
  accepted.operation?.evidence.event_seqs.join(',') === '201,203')
check('a repeated citation is stored once',
  review(addition({ evidence_event_seqs: [203, 201, 203] })).operation?.evidence.event_seqs.join(',') === '201,203')
check('the session is recorded', accepted.operation?.evidence.session_id === 'session_a')
check('the quote comes from the cited events',
  accepted.operation?.evidence.quote.includes('以后这个项目用 pnpm'))
check('a human statement outranks the tool result', accepted.operation?.evidence.kind === 'user')
check('a tool-only citation is labelled as tool',
  review(addition({ evidence_event_seqs: [203] })).operation?.evidence.kind === 'tool')
check('an assistant-only citation is labelled as the agent',
  review(addition({ evidence_event_seqs: [206] })).operation?.evidence.kind === 'agent')
check('the observation time is recorded',
  accepted.operation?.evidence.observed_at === '2026-09-29T00:00:00.000Z')
check('the model cannot supply its own quote',
  review(addition({ quote: 'totally different text' })).operation?.evidence.quote.includes('以后这个项目用 pnpm'))
check('a long quote is truncated to the limit',
  review(addition({ evidence_event_seqs: [201] }), { quoteMaxChars: 4 }).operation?.evidence.quote === '以后这个…')

console.log('evidence must be real and seen')
check('no citations is refused',
  review(addition({ evidence_event_seqs: [] })).reason === 'evidence_event_seqs must be a non-empty array')
check('a missing citation list is refused',
  review(addition({ evidence_event_seqs: undefined })).reason.includes('non-empty array'))
check('a non-integer citation is refused',
  review(addition({ evidence_event_seqs: ['201'] })).reason.includes('integers'))
check('a seq before the window is refused',
  review(addition({ evidence_event_seqs: [200] })).reason.includes('outside the window'))
check('a seq after the window is refused',
  review(addition({ evidence_event_seqs: [999] })).reason.includes('outside the window'))
check('a seq the model never saw is refused',
  review(addition({ evidence_event_seqs: [205] })).reason.includes('was not shown to the model'))
check('a seq with no event behind it is refused',
  review(addition({ evidence_event_seqs: [202] }), { visibleSeqs: new Set([201, 202, 203, 206]) }).reason
    .includes('no event behind it'))

console.log('the confidence gate')
check('a low-confidence proposal is dropped',
  review(addition({ confidence: 0.5 })).reason.includes('below the floor 0.8'))
check('the floor is inclusive',
  review(addition({ confidence: 0.8 })).kind === 'accepted')
check('a missing confidence is refused',
  review(addition({ confidence: undefined })).reason.includes('[0, 1]'))
check('a confidence above 1 is refused',
  review(addition({ confidence: 1.5 })).reason.includes('[0, 1]'))
check('a raising floor drops what it should',
  review(addition({ confidence: 0.85 }), { minConfidence: 0.9 }).reason.includes('below the floor 0.9'))

console.log('content')
check('empty content is refused', review(addition({ content: '   ' })).reason === 'content is empty')
check('a missing content is refused', review(addition({ content: undefined })).reason === 'content is empty')
check('a multi-line fact is refused',
  review(addition({ content: 'one\ntwo' })).reason === 'content is not a single line')
check('an over-long fact is refused',
  review(addition({ content: 'x'.repeat(501) })).reason.includes('longer than 500'))
check('a 500-character fact is accepted', review(addition({ content: 'x'.repeat(500) })).kind === 'accepted')

console.log('actions')
check('an unknown action is refused',
  review(addition({ action: 'replace' })).reason === 'unknown action "replace"')
check('forget is refused', review(addition({ action: 'forget' })).reason.includes('not an automatic action'))
check('clear is refused', review(addition({ action: 'clear' })).reason.includes('not an automatic action'))
check('delete is refused', review(addition({ action: 'delete' })).reason.includes('not an automatic action'))
check('archive is refused', review(addition({ action: 'archive' })).reason.includes('not an automatic action'))
check('a non-object proposal is refused', review('add').reason === 'operation is not an object')
check('the automatic action list is exactly the documented four',
  validate.AUTO_ACTIONS.join(',') === 'add,update,supersede,noop')

console.log('scope and category')
check('an unknown scope is refused',
  review(addition({ scope: 'global' })).reason.includes('unknown scope'))
check('a missing scope is refused',
  review(addition({ scope: undefined })).reason.includes('unknown scope'))
check('a user-scope fact is accepted',
  review(addition({ scope: 'user' })).operation?.projectId === undefined)
check('project scope without a project is refused',
  review(addition(), { projectId: undefined }).reason.includes('needs a resolved project'))
check('project scope with a null project is refused too',
  review(addition(), { projectId: null }).reason.includes('needs a resolved project'))
check('an unknown category is refused',
  review(addition({ category: 'misc' })).reason.includes('unknown category'))
check('a missing category is refused',
  review(addition({ category: undefined })).reason.includes('unknown category'))

console.log('update and supersede act on what exists')
const superseding = { action: 'supersede', target_id: 'mem_old', content: 'The project now uses pnpm.', confidence: 0.95, evidence_event_seqs: [201] }
const supersedeReview = review(superseding)
check('a supersede against an active Memory is accepted', supersedeReview.kind === 'accepted')
check('it inherits the target scope', supersedeReview.operation?.scope === 'project')
check('it inherits the target category', supersedeReview.operation?.category === 'state')
check('it keeps the target id', supersedeReview.operation?.target_id === 'mem_old')
check('it keeps the target project', supersedeReview.operation?.projectId === 'proj_a')
check('a proposal cannot move the fact to another scope',
  review({ ...superseding, scope: 'user' }).operation?.scope === 'project')
check('a proposal cannot relabel the category',
  review({ ...superseding, category: 'preference' }).operation?.category === 'state')
check('an unknown target is refused',
  review({ ...superseding, target_id: 'mem_ghost' }).reason.includes('is not an active Memory'))
check('a missing target is refused',
  review({ ...superseding, target_id: undefined }).reason.includes('is not an active Memory'))
check('a superseded target is refused',
  review({ ...superseding, target_id: 'mem_old' }, {
    existing: [{ ...ACTIVE[0], status: 'superseded' }],
  }).reason.includes('is not an active Memory'))
check('an archived target is refused',
  review({ ...superseding, target_id: 'mem_old' }, {
    existing: [{ ...ACTIVE[0], status: 'archived' }],
  }).reason.includes('is not an active Memory'))
check('a Memory from another project is not targetable',
  review({ ...superseding, target_id: 'mem_elsewhere' }, {
    existing: [{ ...ACTIVE[0], id: 'mem_elsewhere', project_id: 'proj_other' }],
  }).kind === 'accepted')
check('update is accepted against an active Memory',
  review({ ...superseding, action: 'update' }).kind === 'accepted')

console.log('secrets never reach storage through consolidation')
check('a credential in the content is refused',
  review(addition({ content: 'the key is sk-abcdefghijklmnopqrstuvwxyz012345' })).reason.startsWith('secret-detected'))
check('a credential in the cited trajectory is refused',
  review(addition(), {
    eventsBySeq: new Map([...EVENTS_BY_SEQ, [201, human(201, 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789')]]),
  }).reason.startsWith('secret-detected'))
check('an ordinary fact is not mistaken for a secret', review(addition()).kind === 'accepted')

console.log('a credential cannot hide behind the quote limit')
// The quote is a truncation, so a credential straddling the cut would survive as
// a fragment that no longer matches any detector.
const longSecret = `sk-${'C'.repeat(40)}`
const secretEvent = human(300, `部署说明：先读文档，密钥是 ${longSecret}，请保密`)
const withSecret = (maxChars) => review(
  addition({ evidence_event_seqs: [300] }),
  { eventsBySeq: new Map([[300, secretEvent]]), visibleSeqs: new Set([300]), fromSeq: 300, toSeq: 300, quoteMaxChars: maxChars },
)
check('a credential inside the quote is refused', withSecret(200).reason.startsWith('secret-detected'))
check('a credential beyond the quote limit is refused', withSecret(40).reason.startsWith('secret-detected'))
// Truncating first is what makes this dangerous: the fragment that survives no
// longer matches any detector, so a scan of the quote alone would pass.
const naiveFragment = Array.from(secretEvent.data.content[0].text).slice(0, 12).join('')
check('a truncation-first scan would have missed the credential',
  findSecret(naiveFragment) === undefined && findSecret(secretEvent.data.content[0].text) !== undefined)
check('the untruncated source is what refuses it',
  withSecret(12).reason.startsWith('secret-detected'))
check('the accepted operation carries the untruncated source for the write to screen',
  Array.isArray(review(addition()).operation?.sourceTexts)
  && review(addition()).operation.sourceTexts.length > 0)

console.log('noop is a decision, not a failure')
const plan = validate.reviewPlan({ operations: [
  addition(),
  { action: 'noop', reason: 'transient task state' },
  addition({ content: 'too vague', confidence: 0.2 }),
  { action: 'forget', target_id: 'mem_old' },
] }, context())
check('the one good operation was accepted', plan.accepted.length === 1)
check('the noop is separated from the failures',
  plan.noopReasons.length === 1 && plan.noopReasons[0] === 'transient task state')
check('the dropped operations carry reasons', plan.rejected.length === 2)
check('a dropped operation names why',
  plan.rejected[0].reason.includes('below the floor') && plan.rejected[1].reason.includes('not an automatic action'))
console.log('a plan that cannot be read fails the batch')
let planRefused = false
try {
  validate.reviewPlan({ operations: 'all' }, context())
} catch (error) {
  planRefused = String(error.message).includes('operations array')
}
check('a non-array operations value throws', planRefused === true)
let missingRefused = false
try {
  validate.reviewPlan({}, context())
} catch {
  missingRefused = true
}
check('a plan with no operations key throws', missingRefused === true)

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
