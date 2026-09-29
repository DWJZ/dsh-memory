/**
 * Project identity suite.
 *
 * A project id must survive its directory moving, two spellings of one directory
 * must not become two projects, and a working directory several levels below a
 * root must still find it. Each assertion here is one of those promises.
 *
 * Usage: `node test/registry.spec.mjs`.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const registry = await import(pathToFileURL(join(PLUGIN, 'src/registry.js')).href)
const { registryLayout, projectLayout, userLayout } = await import(pathToFileURL(join(PLUGIN, 'src/paths.js')).href)
const { readStore, withStore } = await import(pathToFileURL(join(PLUGIN, 'src/jsonstore.js')).href)
const { projectMemoryRecord, projectId: newProjectId } = await import('./fixtures/records.mjs')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const ROOT = mkdtempSync(join(tmpdir(), 'dsh-memory-registry-'))
const MEMORY = join(ROOT, 'memory')
mkdirSync(MEMORY, { recursive: true })
const LAYOUT = registryLayout(MEMORY)
const OPTIONS = { ...LAYOUT, projectRootMarkers: ['.git'], lockTimeoutMs: 3000, staleLockMs: 60000 }

/** Create a directory below the fixture root. */
const dir = (...parts) => {
  const path = join(ROOT, ...parts)
  mkdirSync(path, { recursive: true })
  return path
}

/** Read the raw registry, tolerating its absence. */
const projects = () => registry.readRegistry(LAYOUT.registryPath).projects

/** Whether the thunk rejects. */
const rejects = async (thunk, fragment) => {
  try {
    await thunk()
    return false
  } catch (error) {
    return fragment === undefined || String(error.message).includes(fragment)
  }
}

console.log('project_bind')
const alpha = dir('alpha')
const bound = await registry.bindProject(OPTIONS, alpha)
check('binding a plain directory creates a project', bound.created === true)
check('the id carries the proj_ prefix', bound.project.project_id.startsWith('proj_'))
check('the canonical root is the directory', bound.project.canonical_root === resolve(alpha))
check('the registry holds one project', projects().length === 1)

console.log('project_bind_existing_path_returns_existing')
const again = await registry.bindProject(OPTIONS, alpha)
check('binding the same directory returns the same project', again.project.project_id === bound.project.project_id)
check('binding the same directory creates nothing', again.created === false)
check('the registry still holds one project', projects().length === 1)
check('the registry revision advanced once per write',
  registry.readRegistry(LAYOUT.registryPath).revision === 1)

console.log('project_longest_ancestor_match')
const outer = dir('outer')
const inner = dir('outer', 'inner')
const nesting = dir('outer', 'inner', 'src')
const outerBound = await registry.bindProject(OPTIONS, outer)
const innerBound = await registry.bindProject(OPTIONS, inner)
const matched = registry.matchProject(projects(), nesting)
check('a nested directory matches the inner project', matched?.project_id === innerBound.project.project_id)
check('the inner project is not the outer one', innerBound.project.project_id !== outerBound.project.project_id)
check('a directory in the outer project still matches it',
  registry.matchProject(projects(), dir('outer', 'other'))?.project_id === outerBound.project.project_id)
check('a directory outside every project matches nothing',
  registry.matchProject(projects(), ROOT) === undefined)

console.log('relink')
const moved = dir('moved-to')
const relinked = await registry.relinkProject(OPTIONS, outer, moved)
check('relink keeps the project id', relinked.project.project_id === outerBound.project.project_id)
check('relink makes the new path canonical', relinked.project.canonical_root === resolve(moved))
check('relink keeps the old path as an alias', relinked.project.aliases.includes(resolve(outer)))
check('relink reports a change', relinked.changed === true)

console.log('project_relink_old_path_missing')
rmSync(outer, { recursive: true, force: true })
check('the old directory is gone', !existsSync(outer))
const insideMoved = dir('moved-to', 'sub')
const afterMove = await registry.resolveProject(OPTIONS, { cwd: insideMoved })
check('a session in the moved directory finds the project', afterMove?.project_id === outerBound.project.project_id)
const stillListed = registry.listProjects(LAYOUT.registryPath).find(entry => entry.project_id === outerBound.project.project_id)
check('the missing alias stays in the registry', stillListed.aliases.includes(resolve(outer)))
check('the missing root is reported as missing', stillListed.missing_roots.includes(resolve(outer)))

console.log('project_missing_alias_does_not_break_resolution')
const beta = dir('beta')
const betaBound = await registry.bindProject(OPTIONS, beta)
check('an unrelated project still resolves despite the missing alias',
  (await registry.resolveProject(OPTIONS, { cwd: beta }))?.project_id === betaBound.project.project_id)
check('matching a directory under a missing root is skipped, not fatal',
  registry.matchProject(projects(), join(outer, 'sub')) === undefined)

console.log('project_relink_target_conflict')
const claimed = dir('claimed')
const claimedBound = await registry.bindProject(OPTIONS, claimed)
check('relinking onto another project is refused',
  await rejects(() => registry.relinkProject(OPTIONS, moved, claimed), 'already belongs to'))
check('relinking from an unregistered path is refused',
  await rejects(() => registry.relinkProject(OPTIONS, dir('never-registered'), moved), 'no project is registered'))
check('relinking to a missing directory is refused',
  await rejects(() => registry.relinkProject(OPTIONS, moved, join(ROOT, 'absent')), 'does not exist'))

console.log('project_alias_unique')
const rebound = await registry.bindProject(OPTIONS, outer)
check('binding a stale alias returns its owning project', rebound.project.project_id === outerBound.project.project_id)
check('binding a stale alias creates nothing', rebound.created === false)
check('the aliased path is owned by exactly one project',
  projects().filter(entry => registry.projectRoots(entry).includes(resolve(outer))).length === 1)
check('re-binding an alias does not duplicate it',
  projects().find(entry => entry.project_id === outerBound.project.project_id)
    .aliases.filter(alias => alias === resolve(outer)).length === 1)
check('re-binding an alias does not hijack another project',
  (await registry.bindProject(OPTIONS, claimed)).project.project_id === claimedBound.project.project_id)

console.log('project_existing_symlink_realpath_conflict')
const realDir = dir('real-dir')
const linkDir = join(ROOT, 'link-dir')
symlinkSync(realDir, linkDir, 'dir')
const realBound = await registry.bindProject(OPTIONS, realDir)
const linkBound = await registry.bindProject(OPTIONS, linkDir)
check('a symlink to a registered directory resolves to it', linkBound.project.project_id === realBound.project.project_id)
check('the symlink creates no second project', linkBound.created === false)
check('one directory is one project',
  projects().filter(entry => registry.projectRoots(entry).some(root => resolve(root) === resolve(realDir) || resolve(root) === resolve(linkDir))).length === 1)

console.log('resolveProject falls back to markers, then to no scope')
const repo = dir('repo')
mkdirSync(join(repo, '.git'))
const deep = dir('repo', 'packages', 'core')
const discovered = await registry.resolveProject(OPTIONS, { cwd: deep })
check('a Git marker registers the repository root', discovered?.canonical_root === resolve(repo))
const plain = dir('plain-workspace')
const viaWorkspace = await registry.resolveProject(OPTIONS, { cwd: plain, workspaceRoot: plain, workspaceId: 'workspace-1' })
check('a workspace root registers a non-Git project', viaWorkspace?.canonical_root === resolve(plain))
check('the workspace id is recorded', viaWorkspace.workspace_ids.includes('workspace-1'))
const orphan = dir('no-project-here')
check('a directory with no marker has no project scope',
  await registry.resolveProject(OPTIONS, { cwd: orphan }) === null)

console.log('project_isolation')
const scopeA = projectLayout(MEMORY, betaBound.project.project_id)
const scopeB = projectLayout(MEMORY, claimedBound.project.project_id)
check('two projects resolve to different directories', scopeA.dir !== scopeB.dir)
check('the user scope is separate from every project',
  userLayout(MEMORY).dir !== scopeA.dir && userLayout(MEMORY).dir !== scopeB.dir)
check('a project layout lives below the projects directory',
  scopeA.dir.startsWith(join(MEMORY, 'projects')))
const storedRecord = projectMemoryRecord(betaBound.project.project_id)
await withStore(scopeA, current => ({ changed: true, records: [...current.records, storedRecord] }))
check('the record is stored under its own project',
  readStore(scopeA.storePath).records.some(record => record.id === storedRecord.id))
check('the other project sees nothing',
  readStore(scopeB.storePath).records.length === 0)
check('the other project has no store file', !existsSync(scopeB.storePath))

console.log('registry format refusal')
writeFileSync(LAYOUT.registryPath, JSON.stringify({ schema_version: 99, revision: 1, projects: [] }))
let versionError
try {
  registry.readRegistry(LAYOUT.registryPath)
} catch (error) {
  versionError = error
}
check('an unknown registry schema_version is refused', versionError !== undefined)
check('the refusal names the field', String(versionError?.message).includes('schema_version'))

console.log('a registry that violates its own schema is refused')
const writeRegistry = projects => {
  writeFileSync(LAYOUT.registryPath, JSON.stringify({ schema_version: 1, revision: 1, projects }, null, 2))
}
const at = new Date(0).toISOString()
const entry = (overrides = {}) => ({
  project_id: newProjectId(),
  canonical_root: '/tmp/dsh-memory-registry-entry',
  aliases: [],
  workspace_ids: [],
  created_at: at,
  updated_at: at,
  ...overrides,
})

writeRegistry([entry({ project_id: 'proj_not-a-uuid' })])
check('a hand-written project id is refused', await rejects(() => registry.readRegistry(LAYOUT.registryPath)))
check('the refusal names project_id',
  await rejects(() => registry.readRegistry(LAYOUT.registryPath), 'project_id'))

writeRegistry([entry({ canonical_root: 'relative/path' })])
check('a relative root is refused', await rejects(() => registry.readRegistry(LAYOUT.registryPath), 'absolute'))

const duplicate = entry()
writeRegistry([duplicate, { ...duplicate, project_id: newProjectId() }])
check('two projects claiming one path are refused',
  await rejects(() => registry.readRegistry(LAYOUT.registryPath), 'claimed by both'))

writeRegistry([entry({ aliases: 'not-an-array' })])
check('a non-array alias list is refused', await rejects(() => registry.readRegistry(LAYOUT.registryPath), 'aliases'))

writeRegistry([entry({ updated_at: 'yesterday' })])
check('a malformed timestamp is refused', await rejects(() => registry.readRegistry(LAYOUT.registryPath), 'updated_at'))

writeRegistry([entry({ project_id: '../escape' })])
check('a path-shaped project id is refused',
  await rejects(() => registry.readRegistry(LAYOUT.registryPath), 'project id'))

console.log('a project id cannot become a path outside the Memory root')
check('projectLayout refuses a traversal id',
  await rejects(() => projectLayout(MEMORY, '../escape'), 'project id'))
check('projectLayout refuses a bare name',
  await rejects(() => projectLayout(MEMORY, 'escape'), 'project id'))
check('projectLayout accepts a minted id',
  projectLayout(MEMORY, newProjectId()).dir.startsWith(join(MEMORY, 'projects')))

console.log('one directory cannot become two projects')
const claimDir = join(ROOT, 'real-project')
const claimLink = join(ROOT, 'linked-project')
mkdirSync(claimDir, { recursive: true })
symlinkSync(claimDir, claimLink)
writeRegistry([
  entry({ canonical_root: claimDir }),
  entry({ canonical_root: claimLink }),
])
check('two roots that are one directory are refused',
  await rejects(() => registry.readRegistry(LAYOUT.registryPath), 'the same directory'))
writeRegistry([entry({ canonical_root: claimDir, aliases: [claimLink] })])
check('one entry listing its own directory twice is tolerated, since it resolves to one project',
  registry.readRegistry(LAYOUT.registryPath).projects.length === 1)
writeRegistry([entry({ canonical_root: claimDir })])
check('a single project on the real directory is accepted',
  registry.readRegistry(LAYOUT.registryPath).projects.length === 1)

rmSync(ROOT, { recursive: true, force: true })
console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
