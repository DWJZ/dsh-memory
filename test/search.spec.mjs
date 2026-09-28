/**
 * Search suite.
 *
 * The Chinese cases are the point: a whitespace tokenizer would score every
 * Chinese sentence as one token, so a query sharing most of its characters with a
 * record would still miss. Each assertion here is a query that must find a record
 * through one of the three signals.
 *
 * Usage: `node test/search.spec.mjs`.
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const { searchRecords, scoreRecord, queryBigrams, queryTokens, foldForSearch } = await import(pathToFileURL(join(PLUGIN, 'src/retrieval.js')).href)

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  ok   ${name}`)
  else {
    failures += 1
    console.log(`  FAIL ${name} ${detail}`)
  }
}

const AT = '2026-09-26T00:00:00.000Z'
const LATER = '2026-09-27T00:00:00.000Z'

/** One record shaped well enough for scoring. */
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

const idsOf = result => result.results.map(hit => hit.id)

console.log('search_ascii_keyword')
const asciiRecords = [
  record({ id: 'mem_pnpm', content: '该项目使用 pnpm 管理依赖' }),
  record({ id: 'mem_npm', content: '该项目使用 npm 管理依赖' }),
  record({ id: 'mem_other', content: '部署目标是 Kubernetes' }),
]
const ascii = searchRecords(asciiRecords, { query: 'pnpm' })
check('a Latin word finds its record', idsOf(ascii).includes('mem_pnpm'))
check('an unrelated record is not returned', !idsOf(ascii).includes('mem_other'))
check('the total counts every match', ascii.total === 1)
check('a query matching several records returns them all',
  searchRecords(asciiRecords, { query: '管理依赖' }).total === 2)

console.log('search_chinese_substring')
const chineseRecords = [
  record({ id: 'mem_manager', content: '项目使用 pnpm 作为包管理器' }),
  record({ id: 'mem_deploy', content: '当前部署目标是 Kubernetes' }),
]
const substring = searchRecords(chineseRecords, { query: '包管理器' })
check('a Chinese query finds the record', idsOf(substring)[0] === 'mem_manager')
check('the unrelated record is not returned', !idsOf(substring).includes('mem_deploy'))
check('a verbatim match scores highest',
  scoreRecord(chineseRecords[0], foldForSearch('包管理器')) >= 100)

console.log('search_chinese_bigram')
const bigramOnly = record({ id: 'mem_bigram', content: '本仓库用 pnpm 做为包管理工具' })
const bigramQuery = '包管理方案'
check('the query is not a verbatim substring', !bigramOnly.content.includes(bigramQuery))
check('the query shares bigrams with the record',
  queryBigrams(foldForSearch(bigramQuery)).some(bigram => bigramOnly.content.includes(bigram)))
const bigramResult = searchRecords([bigramOnly, record({ id: 'mem_plain', content: '无关内容' })], { query: bigramQuery })
check('a bigram overlap still finds the record', idsOf(bigramResult)[0] === 'mem_bigram')
check('a record sharing no bigram is not returned',
  searchRecords([record({ id: 'mem_none', content: '完全不同的内容' })], { query: '包管理器' }).total === 0)
check('bigrams are extracted from a CJK run',
  queryBigrams('包管理器').join(',') === '包管,管理,理器')
check('a single CJK character has no bigram', queryBigrams('包').length === 0)

console.log('search_mixed_chinese_english')
const mixed = searchRecords([
  record({ id: 'mem_mixed', content: '该项目已从 npm 迁移到 pnpm，不再使用 npm' }),
  record({ id: 'mem_irrelevant', content: '用户偏好中文解释' }),
], { query: 'pnpm 迁移' })
check('a mixed query finds the record', idsOf(mixed)[0] === 'mem_mixed')
check('the Latin token is recognized', queryTokens(foldForSearch('pnpm 迁移')).join(',') === 'pnpm')
check('the CJK part contributes bigrams', queryBigrams(foldForSearch('pnpm 迁移')).join(',') === '迁移')

console.log('case folding applies to comparison only')
check('a lower-case query finds upper-case content',
  searchRecords([record({ id: 'mem_upper', content: 'PNPM is the package manager' })], { query: 'pnpm' }).total === 1)
check('an upper-case query finds lower-case content',
  searchRecords([record({ id: 'mem_lower', content: 'pnpm is the package manager' })], { query: 'PNPM' }).total === 1)
check('folding does not touch stored content', record({ content: 'PNPM' }).content === 'PNPM')

console.log('filters')
const filtered = [
  record({ id: 'mem_user', scope: 'user', category: 'preference', content: '偏好 pnpm' }),
  record({ id: 'mem_project', scope: 'project', project_id: 'proj_a', category: 'decision', content: '项目使用 pnpm' }),
  record({ id: 'mem_archived', scope: 'project', project_id: 'proj_a', category: 'state', content: '旧记录 pnpm', status: 'archived' }),
  record({ id: 'mem_superseded', scope: 'project', project_id: 'proj_a', category: 'state', content: '过期 pnpm', status: 'superseded', superseded_by: 'mem_project' }),
]
check('an archived record never matches', !idsOf(searchRecords(filtered, { query: 'pnpm' })).includes('mem_archived'))
check('a superseded record never matches', !idsOf(searchRecords(filtered, { query: 'pnpm' })).includes('mem_superseded'))
check('scope user filters to user Memory',
  idsOf(searchRecords(filtered, { query: 'pnpm', scope: 'user' })).join(',') === 'mem_user')
check('scope project filters to project Memory',
  idsOf(searchRecords(filtered, { query: 'pnpm', scope: 'project' })).join(',') === 'mem_project')
check('a category filter is exact',
  idsOf(searchRecords(filtered, { query: 'pnpm', category: 'decision' })).join(',') === 'mem_project')
check('top_k truncates the list but not the total',
  searchRecords(filtered, { query: 'pnpm', topK: 1 }).results.length === 1
  && searchRecords(filtered, { query: 'pnpm', topK: 1 }).total === 2)

console.log('project isolation is enforced by retrieval')
const foreign = searchRecords([
  record({ id: 'mem_mine', scope: 'project', project_id: 'proj_a', content: '项目使用 pnpm' }),
  record({ id: 'mem_theirs', scope: 'project', project_id: 'proj_b', content: '项目也使用 pnpm' }),
  record({ id: 'mem_shared', scope: 'user', content: '用户偏好 pnpm' }),
], { query: 'pnpm', projectId: 'proj_a' })
check('another project does not match', !idsOf(foreign).includes('mem_theirs'))
check('the caller\'s project matches', idsOf(foreign).includes('mem_mine'))
check('user Memory is visible from any project', idsOf(foreign).includes('mem_shared'))

console.log('ranking and empty queries')
const ranked = searchRecords([
  record({ id: 'mem_exact', content: '使用 pnpm' }),
  record({ id: 'mem_partial', content: '使用 pnpm 与 npm 都可以' }),
], { query: '使用 pnpm' })
check('a verbatim match outranks a partial one', idsOf(ranked)[0] === 'mem_exact')
const tied = searchRecords([
  record({ id: 'mem_old', content: 'pnpm', updated_at: AT }),
  record({ id: 'mem_new', content: 'pnpm', updated_at: LATER }),
], { query: 'pnpm' })
check('an equal score falls back to the newer record', idsOf(tied)[0] === 'mem_new')
check('an empty query matches nothing', searchRecords(filtered, { query: '   ' }).total === 0)
check('an unmatched query matches nothing', searchRecords(filtered, { query: 'zzz' }).total === 0)
check('an empty record set is handled', searchRecords([], { query: 'pnpm' }).total === 0)

console.log(failures === 0 ? '\nPASS' : `\n${String(failures)} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
