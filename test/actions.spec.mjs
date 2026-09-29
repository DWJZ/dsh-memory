/**
 * Memory operation suite.
 *
 * Each assertion here is a promise the contract makes about a mutation: an
 * identity that survives a restatement, a retirement that leaves exactly one
 * active record, a project whose records no other project can reach, and a
 * refusal to store what looks like a credential.
 *
 * Usage: `node test/actions.spec.mjs`.
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const actions = await import(pathToFileURL(join(PLUGIN, 'src/actions.js')).href)
const { readStore } = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.js')).href)
const { userLayout, projectLayout, tombstoneLayout } = await import(pathToFileURL(join(PLUGIN, 'src/paths.js')).href)
const { findSecret } = await import(pathToFileURL(join(PLUGIN, 'src/redact.js')).href)
const { newProjectId } = await import(pathToFileURL(join(PLUGIN, 'src/schema.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const AT = '2026-09-26T00:00:00.000Z'
const BASE_MS = Date.parse(AT)
const ROOT = mkdtempSync(join(tmpdir(), 'dsh-memory-actions-'))
const MEMORY = join(ROOT, 'memory')
mkdirSync(MEMORY, { recursive: true })
const PROJECT_A = newProjectId()
const PROJECT_B = newProjectId()
const warnings = []

const OPTIONS = {
  scopes: { user: userLayout(MEMORY), project: id => projectLayout(MEMORY, id) },
  tombstones: tombstoneLayout(MEMORY),
  lockTimeoutMs: 3000,
  staleLockMs: 60000,
  maxEvidencePerMemory: 3,
  logger: { warn: message => warnings.push(message) },
}

/** Options whose clock is fixed, so timestamps are compared rather than observed. */
const clocked = offsetMs => ({ ...OPTIONS, now: () => BASE_MS + offsetMs })

/** One provenance entry the host would build from the current turn. */
const evidence = (overrides = {}) => ({
  session_id: 'session-1',
  event_seqs: [7],
  kind: 'user',
  quote: '记住，这个项目使用 pnpm',
  observed_at: AT,
  ...overrides,
})

/** Every record currently stored for one project. */
const recordsOf = projectId => readStore(projectLayout(MEMORY, projectId).storePath).records

/** One stored record. */
const recordOf = (projectId, id) => recordsOf(projectId).find(record => record.id === id)

/** The generated view of one project. */
const viewOf = projectId => readFileSync(projectLayout(MEMORY, projectId).viewPath, 'utf8')

/** Every tombstone written so far. */
const tombstones = () => {
  const text = readFileSync(tombstoneLayout(MEMORY).path, 'utf8')
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}

/** Whether any file under the Memory root still contains this text. */
const memoryTreeContains = (text) => {
  for (const entry of readdirSync(MEMORY, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(entry.parentPath ?? entry.path, entry.name)
    if (readFileSync(path, 'utf8').includes(text)) return true
  }
  return false
}

/** Whether the thunk rejects, optionally matching a message fragment. */
const rejects = async (thunk, fragment) => {
  try {
    await thunk()
    return false
  } catch (error) {
    return fragment === undefined || String(error.message).includes(fragment)
  }
}

console.log('memory_add')
const added = await actions.addMemory(clocked(0), {
  content: '该项目使用 pnpm',
  scope: 'project',
  category: 'state',
  projectId: PROJECT_A,
  evidence: evidence(),
})
check('the action is added', added.action === 'added')
check('the id is a Memory id', String(added.id).startsWith('mem_'))
check('the revision advanced', added.revision === 1)
check('one record is stored', recordsOf(PROJECT_A).length === 1)
const stored = recordOf(PROJECT_A, added.id)
check('confidence is fixed at 1.0 by the writer', stored.confidence === 1.0)
check('the record is active', stored.status === 'active')
check('the record holds no successor', stored.superseded_by === null)
check('the project is recorded', stored.project_id === PROJECT_A)
check('provenance is attached by the host', stored.evidence.length === 1 && stored.evidence[0].kind === 'user')
check('the view lists the new fact', viewOf(PROJECT_A).includes('该项目使用 pnpm'))

console.log('duplicate_exact_noop')
const repeated = await actions.addMemory(clocked(1000), {
  content: '该项目使用 pnpm',
  scope: 'project',
  category: 'state',
  projectId: PROJECT_A,
})
check('a repeated fact is refused', repeated.action === 'noop')
check('the reason is duplicate', repeated.reason === 'duplicate')
check('the existing id is reported', repeated.id === added.id)
check('nothing new is stored', recordsOf(PROJECT_A).length === 1)
const spaced = await actions.addMemory(clocked(2000), {
  content: '  该项目使用    pnpm  ',
  scope: 'project',
  category: 'state',
  projectId: PROJECT_A,
})
check('a whitespace-only difference is still a duplicate', spaced.reason === 'duplicate')
const otherCategory = await actions.addMemory(clocked(3000), {
  content: '该项目使用 pnpm',
  scope: 'project',
  category: 'decision',
  projectId: PROJECT_A,
})
check('the same text in another category is a different Memory', otherCategory.action === 'added')

console.log('duplicate_case_difference_not_noop')
await actions.addMemory(clocked(4000), {
  content: 'Model-X is the encoder',
  scope: 'project',
  category: 'reference',
  projectId: PROJECT_A,
})
const lowercased = await actions.addMemory(clocked(5000), {
  content: 'model-x is the encoder',
  scope: 'project',
  category: 'reference',
  projectId: PROJECT_A,
})
check('a case difference is not a duplicate', lowercased.action === 'added')
check('case variants are kept distinct', lowercased.id !== undefined)

console.log('memory_update_explicit_target')
const before = recordOf(PROJECT_A, added.id)
const updated = await actions.updateMemory(clocked(60000), {
  id: added.id,
  content: '该项目已迁移到 pnpm',
  projectId: PROJECT_A,
  evidence: evidence({ session_id: 'session-2', event_seqs: [12] }),
})
check('the action is updated', updated.action === 'updated')
check('the identity is kept', updated.id === added.id)
const after = recordOf(PROJECT_A, added.id)
check('the content changed', after.content === '该项目已迁移到 pnpm')
check('created_at is preserved', after.created_at === before.created_at)
check('updated_at advanced', after.updated_at > before.updated_at)
check('provenance accumulates', after.evidence.length === 2)
check('the newest provenance is last', after.evidence[1].session_id === 'session-2')
check('the view shows the restated fact', viewOf(PROJECT_A).includes('该项目已迁移到 pnpm'))

console.log('update_target_scope_inherited and update_target_category_inherited')
check('scope is inherited from the target', after.scope === 'project')
check('project is inherited from the target', after.project_id === PROJECT_A)
check('category is inherited from the target', after.category === 'state')

console.log('provenance is capped, keeping the newest')
for (let index = 0; index < 4; index += 1) {
  await actions.updateMemory(clocked(70000 + index * 1000), {
    id: added.id,
    content: `该项目已迁移到 pnpm (${String(index)})`,
    projectId: PROJECT_A,
    evidence: evidence({ session_id: `late-${String(index)}` }),
  })
}
const capped = recordOf(PROJECT_A, added.id)
check('provenance stops at the configured cap', capped.evidence.length === 3)
check('the oldest provenance is dropped', !capped.evidence.some(entry => entry.session_id === 'session-1'))
check('the second-oldest provenance is dropped too',
  !capped.evidence.some(entry => entry.session_id === 'session-2'))
check('the surviving window is the newest three',
  capped.evidence.map(entry => entry.session_id).join(',') === 'late-1,late-2,late-3')

console.log('memory_supersede_explicit_target')
const beforeSupersede = readStore(projectLayout(MEMORY, PROJECT_A).storePath).revision
const superseded = await actions.supersedeMemory(clocked(90000), {
  id: added.id,
  content: '该项目使用 pnpm 作为包管理器',
  projectId: PROJECT_A,
  evidence: evidence({ session_id: 'session-9' }),
})
check('the action is superseded', superseded.action === 'superseded')
check('the retired id is reported', superseded.superseded_id === added.id)
check('the replacement is a new Memory', superseded.id !== added.id)
check('exactly one revision was spent', superseded.revision === beforeSupersede + 1)
const retired = recordOf(PROJECT_A, added.id)
const replacement = recordOf(PROJECT_A, superseded.id)
check('the old record is superseded', retired.status === 'superseded')
check('the old record names its successor', retired.superseded_by === superseded.id)
check('the replacement is active', replacement.status === 'active')
check('the replacement holds no successor', replacement.superseded_by === null)
check('the old record keeps its timestamps', retired.created_at === before.created_at)
check('exactly one active record carries the fact',
  recordsOf(PROJECT_A).filter(record => record.status === 'active' && record.content.includes('包管理器')).length === 1)
check('the index shows the new fact', viewOf(PROJECT_A).includes('该项目使用 pnpm 作为包管理器'))
check('the index hides the retired fact', !viewOf(PROJECT_A).includes('该项目已迁移到 pnpm (3)'))

console.log('supersede_target_scope_inherited and supersede_target_category_inherited')
check('scope is inherited from the target', replacement.scope === retired.scope)
check('project is inherited from the target', replacement.project_id === retired.project_id)
check('category is inherited from the target', replacement.category === retired.category)

console.log('stale_target_fails_conflict')
check('superseding a retired Memory is a conflict',
  await rejects(() => actions.supersedeMemory(clocked(100000), {
    id: added.id,
    content: 'again',
    projectId: PROJECT_A,
  }), 'cannot be modified'))
check('updating a retired Memory is a conflict',
  await rejects(() => actions.updateMemory(clocked(101000), {
    id: added.id,
    content: 'again',
    projectId: PROJECT_A,
  }), 'cannot be modified'))
check('a conflict changes nothing',
  recordOf(PROJECT_A, added.id).status === 'superseded')
check('an unknown id is refused',
  await rejects(() => actions.updateMemory(clocked(102000), {
    id: 'mem_absent',
    content: 'x',
    projectId: PROJECT_A,
  }), 'not visible'))

console.log('project_isolation')
check('another project cannot reach the record',
  await rejects(() => actions.updateMemory(clocked(103000), {
    id: superseded.id,
    content: 'hijacked',
    projectId: PROJECT_B,
  }), 'not visible'))
check('another project cannot archive the record',
  await rejects(() => actions.archiveMemory(clocked(104000), { id: superseded.id, projectId: PROJECT_B }), 'not visible'))
check('the record is untouched', recordOf(PROJECT_A, superseded.id).content === '该项目使用 pnpm 作为包管理器')

console.log('user scope spans projects')
const userRecord = await actions.addMemory(clocked(105000), {
  content: '用户偏好中文解释，技术术语保留英文',
  scope: 'user',
  category: 'preference',
  projectId: PROJECT_A,
  evidence: evidence(),
})
check('a user Memory is stored in the user scope',
  readStore(userLayout(MEMORY).storePath).records.length === 1)
check('a user Memory carries no project', recordOf(PROJECT_A, userRecord.id) === undefined)
const userVisibleFromB = await actions.updateMemory(clocked(106000), {
  id: userRecord.id,
  content: '用户偏好中文解释，代码与技术术语保留英文',
  projectId: PROJECT_B,
})
check('a user Memory is reachable from any project', userVisibleFromB.action === 'updated')
check('the user Memory stayed in the user scope',
  readStore(userLayout(MEMORY).storePath).records[0].content.includes('代码与技术术语'))

console.log('memory_archive')
const archived = await actions.archiveMemory(clocked(107000), { id: superseded.id, projectId: PROJECT_A })
check('the action is archived', archived.action === 'archived')
check('the status is archived', recordOf(PROJECT_A, superseded.id).status === 'archived')
check('the record stays in the canonical store', recordOf(PROJECT_A, superseded.id) !== undefined)
check('the index drops it', !viewOf(PROJECT_A).includes('包管理器'))
check('archiving twice is a conflict',
  await rejects(() => actions.archiveMemory(clocked(108000), { id: superseded.id, projectId: PROJECT_A }), 'cannot be modified'))

console.log('memory_forget')
const forgottenId = lowercased.id
const forgotten = await actions.forgetMemory(clocked(109000), { id: forgottenId, projectId: PROJECT_A })
check('the action is forgotten', forgotten.action === 'forgotten')
check('the record is gone from the store', recordOf(PROJECT_A, forgottenId) === undefined)
check('the index drops it', !viewOf(PROJECT_A).includes('model-x is the encoder'))
check('nothing under the Memory root still holds its content',
  !memoryTreeContains('model-x is the encoder'))
check('forgetting an absent Memory is refused',
  await rejects(() => actions.forgetMemory(clocked(110000), { id: forgottenId, projectId: PROJECT_A }), 'not visible'))

console.log('memory_clear')
await actions.addMemory(clocked(111000), { content: 'B one', scope: 'project', category: 'state', projectId: PROJECT_B })
await actions.addMemory(clocked(112000), { content: 'B two', scope: 'project', category: 'state', projectId: PROJECT_B })
const cleared = await actions.clearScope(clocked(113000), { scope: 'project', projectId: PROJECT_B })
check('the action is cleared', cleared.action === 'cleared')
check('the count is reported', cleared.count === 2)
check('the store is empty', recordsOf(PROJECT_B).length === 0)
check('the view is empty too', viewOf(PROJECT_B).includes('No active Memory.'))
check('clearing an empty scope is a no-op',
  (await actions.clearScope(clocked(114000), { scope: 'project', projectId: PROJECT_B })).action === 'noop')

console.log('secret refusal')
const dirty = await actions.addMemory(clocked(115000), {
  content: 'the deployment key is sk-abcdefghijklmnopqrstuvwxyz012345',
  scope: 'project',
  category: 'reference',
  projectId: PROJECT_B,
})
check('content holding a credential is refused', dirty.action === 'noop')
check('the reason names the detection', String(dirty.reason).startsWith('secret-detected'))
check('nothing was stored', recordsOf(PROJECT_B).length === 0)

const dirtyQuote = await actions.addMemory(clocked(116000), {
  content: 'GitHub credential 存在 macOS Keychain',
  scope: 'project',
  category: 'reference',
  projectId: PROJECT_B,
  evidence: evidence({ quote: '记住，旧 token 是 ghp_abcdefghijklmnopqrstuvwxyz0123456789' }),
})
check('a credential in the quote is refused', dirtyQuote.action === 'noop')
check('a refused quote leaves nothing behind', !memoryTreeContains('ghp_abcdefghijklmnopqrstuvwxyz0123456789'))
check('the refusal is reported rather than logged as content', !warnings.some(message => message.includes('ghp_')))

console.log('secret_after_quote_limit_rejected and secret_crossing_quote_boundary_rejected')
const longSecret = `sk-${'A'.repeat(24)}`
const fullMessage = `记住，部署用的 key 是 ${longSecret} 请务必保密`
const truncatedQuote = fullMessage.slice(0, 20)
check('the truncated fragment alone would pass a naive scan', findSecret(truncatedQuote) === undefined)
check('the fragment still carries the start of the credential', truncatedQuote.includes('sk-'))
check('the complete message is what the pre-truncation scan sees', findSecret(fullMessage) !== undefined)
const boundary = await actions.addMemory(clocked(117000), {
  content: '部署使用一个长期凭据',
  scope: 'project',
  category: 'reference',
  projectId: PROJECT_B,
  evidence: evidence({ quote: truncatedQuote }),
  sourceTexts: [fullMessage],
})
check('a credential beyond the truncation point is still refused', boundary.action === 'noop')
check('nothing from the message survived', !memoryTreeContains('AAAA'))

console.log('validation and missing project scope')
check('project scope without a project is refused',
  await rejects(() => actions.addMemory(clocked(118000), { content: 'x', scope: 'project', category: 'state' }), 'requires a project'))
check('an empty content is refused',
  await rejects(() => actions.addMemory(clocked(119000), { content: '   ', scope: 'user', category: 'state' }), 'must not be empty'))
check('an over-long content is refused',
  await rejects(() => actions.addMemory(clocked(120000), { content: '记'.repeat(501), scope: 'user', category: 'state' }), 'at most 500'))
check('an unknown category is refused',
  await rejects(() => actions.addMemory(clocked(121000), { content: 'x', scope: 'user', category: 'misc' }), 'category must be one of'))

console.log('forget keeps the supersession chain sound')
const chainA = await actions.addMemory(clocked(122000), {
  content: 'chain step one', scope: 'project', category: 'state', projectId: PROJECT_A,
})
const chainB = await actions.supersedeMemory(clocked(123000), {
  id: chainA.id, content: 'chain step two', projectId: PROJECT_A,
})
const chainC = await actions.supersedeMemory(clocked(124000), {
  id: chainB.id, content: 'chain step three', projectId: PROJECT_A,
})
check('the chain is three records deep',
  recordOf(PROJECT_A, chainA.id).superseded_by === chainB.id
  && recordOf(PROJECT_A, chainB.id).superseded_by === chainC.id)

const droppedMiddle = await actions.forgetMemory(clocked(125000), { id: chainB.id, projectId: PROJECT_A })
check('the middle of the chain is deleted', droppedMiddle.action === 'forgotten')
check('the predecessor now names the survivor',
  recordOf(PROJECT_A, chainA.id).superseded_by === chainC.id)
check('the predecessor is still superseded',
  recordOf(PROJECT_A, chainA.id).status === 'superseded')
check('the surviving store still validates', recordsOf(PROJECT_A).length >= 2)

check('deleting the head of the chain archives its predecessor',
  await actions.forgetMemory(clocked(126000), { id: chainC.id, projectId: PROJECT_A })
    .then(outcome => outcome.action === 'forgotten'
      && recordOf(PROJECT_A, chainA.id).status === 'archived'
      && recordOf(PROJECT_A, chainA.id).superseded_by === null))

const userChain = await actions.addMemory(clocked(127000), {
  content: 'user chain step one', scope: 'user', category: 'state',
})
const userReplacement = await actions.supersedeMemory(clocked(128000), {
  id: userChain.id, content: 'user chain step two', projectId: PROJECT_A,
})
await actions.forgetMemory(clocked(129000), { id: userReplacement.id, projectId: PROJECT_A })
check('a user-scope predecessor is archived when its successor goes',
  readStore(userLayout(MEMORY).storePath).records.find(record => record.id === userChain.id)?.status === 'archived')

console.log('the evidence cap bounds the writer, not the record')
const capOptions = { ...clocked(130000), maxEvidencePerMemory: 2 }
const trimmed = await actions.addMemory(capOptions, {
  content: 'evidence capped', scope: 'user', category: 'state', evidence: evidence({ quote: 'first' }),
})
await actions.updateMemory(capOptions, { id: trimmed.id, content: 'evidence capped', evidence: evidence({ quote: 'second' }) })
await actions.updateMemory(capOptions, { id: trimmed.id, content: 'evidence capped', evidence: evidence({ quote: 'third' }) })
const cappedRecord = readStore(userLayout(MEMORY).storePath).records.find(record => record.id === trimmed.id)
check('the writer keeps only the newest entries', cappedRecord.evidence.length === 2)
check('the newest entry is kept', cappedRecord.evidence.at(-1).quote === 'third')
check('the oldest entry was evicted', !cappedRecord.evidence.some(entry => entry.quote === 'first'))

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
