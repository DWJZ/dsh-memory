/**
 * Commit suite: that automatic operations travel the same Phase 1 path an
 * explicit request does, and that the three outcomes stay distinguishable.
 *
 * Usage: `node test/consolidation-commit.spec.mjs`.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { commitOperations } = await import(pathToFileURL(join(PLUGIN, 'src/consolidation/commit.js')).href)
const { readStore } = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.js')).href)
const { userLayout, projectLayout, tombstoneLayout } = await import(pathToFileURL(join(PLUGIN, 'src/paths.js')).href)
const { newProjectId } = await import(pathToFileURL(join(PLUGIN, 'src/schema.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-reflection-consolidation-commit-'))
const MEMORY = join(ROOT, 'memory')
mkdirSync(MEMORY, { recursive: true })
const PROJECT = newProjectId()
const warnings = []
let clock = Date.parse('2026-09-29T00:00:00.000Z')
const OPTIONS = {
  scopes: { user: userLayout(MEMORY), project: id => projectLayout(MEMORY, id) },
  tombstones: tombstoneLayout(MEMORY),
  lockTimeoutMs: 3000,
  staleLockMs: 60000,
  maxEvidencePerMemory: 8,
  logger: { warn: message => warnings.push(message) },
  now: () => clock,
}

/** The provenance validate.js would have constructed. */
const provenance = (seqs, overrides = {}) => ({
  kind: 'user',
  session_id: 'session_a',
  event_seqs: seqs,
  quote: '以后这个项目用 pnpm',
  observed_at: '2026-09-29T00:00:00.000Z',
  ...overrides,
})
/** One accepted addition. */
const addition = (overrides = {}) => ({
  action: 'add',
  scope: 'project',
  category: 'state',
  content: 'The project uses pnpm.',
  confidence: 0.94,
  projectId: PROJECT,
  evidence: provenance([201, 203]),
  ...overrides,
})
const projectRecords = () => readStore(projectLayout(MEMORY, PROJECT).storePath).records
const userRecords = () => readStore(userLayout(MEMORY).storePath).records

console.log('an accepted addition is committed through Phase 1')
const added = await commitOperations(OPTIONS, [addition()])
check('one addition is counted', added.committed.add === 1)
check('nothing was skipped', added.skipped.length === 0)
check('nothing failed', added.failures.length === 0)
check('the record is in the project store', projectRecords().length === 1)
const stored = projectRecords()[0]
check('the content is stored', stored.content === 'The project uses pnpm.')
check('the scope is stored', stored.scope === 'project')
check('the category is stored', stored.category === 'state')
check('the project is attached', stored.project_id === PROJECT)
check('the status is active', stored.status === 'active')
check('the created time comes from the injected clock',
  stored.created_at === '2026-09-29T00:00:00.000Z')

console.log('the provenance is the one the plugin built')
check('exactly one evidence entry is stored', stored.evidence.length === 1)
check('the evidence kind is kept', stored.evidence[0].kind === 'user')
check('the session is kept', stored.evidence[0].session_id === 'session_a')
check('the cited seqs are kept', stored.evidence[0].event_seqs.join(',') === '201,203')
check('the quote is kept', stored.evidence[0].quote === '以后这个项目用 pnpm')

console.log('a duplicate is skipped, not failed')
const duplicate = await commitOperations(OPTIONS, [addition()])
check('nothing new is counted', duplicate.committed.add === 0)
check('the duplicate is reported as skipped', duplicate.skipped.length === 1)
check('the reason names the duplication', duplicate.skipped[0].reason === 'duplicate')
check('the store is unchanged', projectRecords().length === 1)
check('a duplicate is not a failure', duplicate.failures.length === 0)

console.log('a user-scope fact goes to the user store')
const userFact = await commitOperations(OPTIONS, [addition({
  scope: 'user',
  category: 'preference',
  projectId: undefined,
  content: 'Use Chinese for technical explanations.',
})])
check('the addition is counted', userFact.committed.add === 1)
check('it landed in the user store', userRecords().length === 1)
check('the project store is untouched', projectRecords().length === 1)

console.log('update keeps the record it acts on')
const targetId = userRecords()[0].id
const updated = await commitOperations(OPTIONS, [{
  action: 'update',
  scope: 'user',
  category: 'preference',
  target_id: targetId,
  content: 'Use concise Chinese for technical explanations.',
  confidence: 0.9,
  evidence: provenance([210]),
}])
check('the update is counted', updated.committed.update === 1)
check('the record count is unchanged', userRecords().length === 1)
check('the content was refined', userRecords()[0].content === 'Use concise Chinese for technical explanations.')
check('the id is unchanged', userRecords()[0].id === targetId)
check('the provenance accumulated', userRecords()[0].evidence.length === 2)
check('the newest citation is recorded',
  userRecords()[0].evidence.at(-1).event_seqs.join(',') === '210')

console.log('supersede retires the target and writes the replacement')
const superseded = await commitOperations(OPTIONS, [{
  action: 'supersede',
  scope: 'project',
  category: 'state',
  target_id: projectRecords()[0].id,
  content: 'The project now uses pnpm.',
  confidence: 0.96,
  projectId: PROJECT,
  evidence: provenance([220], { kind: 'tool', quote: 'packageManager: pnpm@10' }),
}])
check('the supersede is counted', superseded.committed.supersede === 1)
check('a replacement was added', projectRecords().length === 2)
const retired = projectRecords().find(record => record.id !== superseded.applied[0].outcome.id)
check('the old record is retired', retired.status === 'superseded')
check('the old record names its replacement',
  retired.superseded_by === superseded.applied[0].outcome.id)
check('the replacement is active',
  projectRecords().find(record => record.id === superseded.applied[0].outcome.id).status === 'active')
check('the retirement did not add evidence to the old record', retired.evidence.length === 1)

console.log('the project path reaches the same actions')
const targetProjectId = projectRecords().find(record => record.status === 'active').id
const projectUpdate = await commitOperations(OPTIONS, [{
  action: 'update',
  scope: 'project',
  category: 'state',
  target_id: targetProjectId,
  content: 'The project uses pnpm, pinned to 10.',
  confidence: 0.88,
  projectId: PROJECT,
  evidence: provenance([400]),
}])
check('a project-scope update commits', projectUpdate.committed.update === 1, JSON.stringify(projectUpdate.failures))
check('it did not fail as invisible', projectUpdate.failures.length === 0)
const updatedProject = projectRecords().find(record => record.id === targetProjectId)
check('the project record was refined', updatedProject?.content === 'The project uses pnpm, pinned to 10.')
check('its id was preserved', updatedProject?.id === targetProjectId)
check('its project is unchanged', updatedProject?.project_id === PROJECT)
check('its evidence accumulated', updatedProject?.evidence.length >= 2)

console.log('an explicit restatement is nearly certain')
const loweredForRestatement = await commitOperations(OPTIONS, [{
  action: 'add', scope: 'project', category: 'state',
  content: 'A fact the consolidator was unsure about.', confidence: 0.7,
  projectId: PROJECT, evidence: provenance([392]),
}])
check('the uncertain record is stored as such', loweredForRestatement.committed.add === 1)
const restatedByUser = await commitOperations(OPTIONS, [{
  action: 'update', scope: 'project', category: 'state',
  target_id: projectRecords().find(record => record.content === 'A fact the consolidator was unsure about.').id,
  content: 'A fact the user restated.',
  projectId: PROJECT, evidence: provenance([393]),
}])
check('an explicit restatement is recorded', restatedByUser.committed.update === 1)
check('and it is nearly certain, not uncertain and not absolute',
  projectRecords().find(record => record.content === 'A fact the user restated.')?.confidence === 0.95,
  String(projectRecords().find(record => record.content === 'A fact the user restated.')?.confidence))
const autoUpdate = await commitOperations(OPTIONS, [{
  action: 'update', scope: 'project', category: 'state',
  target_id: projectRecords().find(record => record.content === 'A fact the user restated.').id,
  content: 'A fact the consolidator refined.',
  confidence: 0.81,
  projectId: PROJECT, evidence: provenance([394]),
}])
check('an automatic update still keeps the value the review approved',
  autoUpdate.committed.update === 1
  && projectRecords().find(record => record.content === 'A fact the consolidator refined.')?.confidence === 0.81)

console.log('the reviewed confidence is what gets stored')
const scored = await commitOperations(OPTIONS, [addition({
  content: 'A fact the consolidator was only fairly sure about.',
  confidence: 0.83,
})])
check('the addition is counted', scored.committed.add === 1)
check('the stored confidence is the reviewed one',
  projectRecords().find(record => record.content === 'A fact the consolidator was only fairly sure about.')
    ?.confidence === 0.83)
const refinedScored = await commitOperations(OPTIONS, [{
  action: 'update',
  scope: 'project',
  category: 'state',
  target_id: projectRecords().find(record => record.confidence === 0.83).id,
  content: 'A fact the consolidator is now sure about.',
  confidence: 0.97,
  projectId: PROJECT,
  evidence: provenance([403]),
}])
check('an update moves the confidence to the reviewed value',
  refinedScored.committed.update === 1
  && projectRecords().find(record => record.content === 'A fact the consolidator is now sure about.')
    ?.confidence === 0.97)
const explicit = await commitOperations(OPTIONS, [{
  action: 'add',
  scope: 'user',
  category: 'state',
  content: 'A fact the user asked for.',
  projectId: undefined,
  evidence: provenance([404]),
}])
check('a write with no stated confidence is certain',
  explicit.committed.add === 1
  && userRecords().find(record => record.content === 'A fact the user asked for.')?.confidence === 1)
const badScore = await commitOperations(OPTIONS, [{ ...addition({ content: 'bad score' }), confidence: 2 }])
check('an unusable confidence is reported as a failure',
  badScore.failures.length === 1 && String(badScore.failures[0].message).includes('confidence'),
  JSON.stringify(badScore.failures))
check('and nothing was written for it', !projectRecords().some(record => record.content === 'bad score'))

console.log('one project cannot reach another project\'s Memory')
const OTHER_PROJECT = newProjectId()
const seeded = await commitOperations(OPTIONS, [{
  action: 'add',
  scope: 'project',
  category: 'state',
  content: 'Another project\'s fact.',
  confidence: 0.9,
  projectId: OTHER_PROJECT,
  evidence: provenance([401]),
}])
check('the other project has its own record', seeded.committed.add === 1)
const otherRecords = () => readStore(projectLayout(MEMORY, OTHER_PROJECT).storePath).records
const crossProject = await commitOperations(OPTIONS, [{
  action: 'update',
  scope: 'project',
  category: 'state',
  target_id: otherRecords()[0].id,
  content: 'not mine to update',
  confidence: 0.9,
  projectId: PROJECT,
  evidence: provenance([402]),
}])
check('a target in another project cannot be updated from this one', crossProject.committed.update === 0)
check('it is reported as a failure rather than silently skipped', crossProject.failures.length === 1)
check('the other project record was left exactly as it was',
  otherRecords()[0].content === 'Another project\'s fact.')

console.log('Phase 1 screening is still the last line of defence')
const smuggled = await commitOperations(OPTIONS, [addition({
  content: 'the key is sk-abcdefghijklmnopqrstuvwxyz012345',
  evidence: provenance([230], { quote: 'sk-abcdefghijklmnopqrstuvwxyz012345' }),
})])
check('a secret is refused even when it reaches commit',
  smuggled.skipped.some(entry => entry.reason.startsWith('secret-detected')))
check('nothing was written for it', smuggled.committed.add === 0)
check('the refusal is not logged as content',
  !warnings.some(message => message.includes('sk-abcdefghijklmnop')))

console.log('a failing operation is reported and the rest proceed')
const mixed = await commitOperations(OPTIONS, [
  addition({ content: 'first fact', evidence: provenance([240]) }),
  { ...addition({ content: 'second fact' }), target_id: 'mem_missing', action: 'supersede' },
  addition({ content: 'third fact', evidence: provenance([241]) }),
])
check('the two good operations committed', mixed.committed.add === 2)
check('the bad one failed', mixed.failures.length === 1)
check('the failure names what it tried', mixed.failures[0].operation.content === 'second fact')
check('the failure carries a message', String(mixed.failures[0].message).length > 0)
check('the later operation still ran',
  projectRecords().some(record => record.content === 'third fact'))

console.log('every operation is accounted for')
const total = mixed.applied.length + mixed.failures.length
check('each proposed operation appears once', total === 3)
check('the counts match the applied writes',
  mixed.committed.add === mixed.applied.filter(entry => entry.outcome?.action === 'added').length)

console.log('an empty plan writes nothing')
const empty = await commitOperations(OPTIONS, [])
check('nothing committed', empty.committed.add === 0 && empty.committed.update === 0 && empty.committed.supersede === 0)
check('nothing failed', empty.failures.length === 0)

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
