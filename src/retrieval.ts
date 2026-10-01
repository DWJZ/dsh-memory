/**
 * Keyword retrieval.
 *
 * Search has to work in Chinese, where a whitespace tokenizer sees one token per
 * sentence. Three signals cover the cases that matter: the whole query appearing
 * verbatim, word-like tokens for Latin text, and character bigrams for CJK, so
 * `包管理器` still finds a record that says `作为包管理器`.
 *
 * Case is folded for comparison only. Stored content is never altered, and the
 * duplicate rule that decides whether two Memories are the same keeps case, since
 * `Model-X` and `model-x` can be different identifiers.
 *
 * @module dsh-reflection/retrieval
 */

import type { MemoryCategory, MemoryRecord, MemoryScope } from './types/memory.js'
/** Score contributed by each matching signal. */
export const SCORE = Object.freeze({
  /** The whole query appears in the content. */
  substring: 100,
  /** One word-like query token appears in the content. */
  token: 10,
  /** One CJK bigram of the query appears in the content. */
  bigram: 4,
})

/** Smallest Latin token worth matching. */
const MIN_TOKEN_LENGTH = 2

/** Character ranges treated as CJK for bigram matching. */
const CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u

/** Runs of Latin letters and digits. */
const WORD_RUN = /[A-Za-z0-9_]+/gu

/** Runs of CJK characters. */
const CJK_RUN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+/gu

/**
 * Normalize text for comparison.
 * @param text - the text to normalize.
 * @returns NFC-normalized, whitespace-collapsed, lowercased text.
 */
/** What one search asks for. */
export interface SearchRequest {
  /** The text to look for. */
  query: string
  /** Which store to search; `all` looks in both. */
  scope?: MemoryScope | 'all' | undefined
  /** Which category to search, when the caller narrows it. */
  category?: MemoryCategory | undefined
  /** The Session's project, for the project store. */
  projectId?: string | null | undefined
  /** Largest number of results. */
  topK?: number | undefined
}

export function foldForSearch(text: string) {
  return String(text ?? '').normalize('NFC').replace(/\s+/gu, ' ').trim().toLowerCase()
}

/**
 * Word-like tokens of one query.
 * @param query - the folded query.
 * @returns tokens long enough to be meaningful.
 */
export function queryTokens(query: string) {
  return [...new Set(query.match(WORD_RUN) ?? [])].filter(token => token.length >= MIN_TOKEN_LENGTH)
}

/**
 * Character bigrams of every CJK run in one query.
 * @param query - the folded query.
 * @returns the bigrams, without duplicates.
 */
export function queryBigrams(query: string) {
  const bigrams = new Set<string>()
  for (const run of query.match(CJK_RUN) ?? []) {
    const characters = Array.from(run)
    for (let index = 0; index + 2 <= characters.length; index += 1) {
      bigrams.add(characters.slice(index, index + 2).join(''))
    }
  }
  return [...bigrams]
}

/**
 * Score one record against one query.
 * @param record - the stored record.
 * @param query - the folded query.
 * @returns the relevance score; zero when nothing matches.
 */
export function scoreRecord(record: MemoryRecord, query: string) {
  if (query === '') return 0
  const content = foldForSearch(record.content)
  let score = 0
  if (content.includes(query)) score += SCORE.substring
  for (const token of queryTokens(query)) {
    if (content.includes(token)) score += SCORE.token
  }
  for (const bigram of queryBigrams(query)) {
    if (content.includes(bigram)) score += SCORE.bigram
  }
  return score
}

/**
 * Search the records one session may read.
 *
 * A project record from another project is dropped even when the caller merged
 * it in, so isolation is a property of retrieval rather than of the caller.
 * @param records - candidate records, possibly from more than one scope.
 * @param {object} request - the query and its filters.
 * @param request.query - what to look for.
 * @param request.scope - `user`, `project`, or `all`; defaults to `all`.
 * @param request.projectId - the caller's project, used to drop foreign records.
 * @param request.category - an exact category filter.
 * @param request.topK - the largest result list.
 * @returns the ranked matches and how many matched in total.
 */
export function searchRecords(records: MemoryRecord[], request: SearchRequest) {
  const query = foldForSearch(request.query)
  const scope = request.scope ?? 'all'
  const visible = records.filter((record: MemoryRecord) => record.status === 'active'
    && (request.projectId === undefined || record.scope === 'user' || record.project_id === request.projectId)
    && (scope === 'all' || record.scope === scope)
    && (request.category === undefined || record.category === request.category))

  const matches = visible
    .map((record: MemoryRecord) => ({ record, score: scoreRecord(record, query) }))
    .filter(match => match.score > 0)
    .sort((left, right) => right.score - left.score
      || (left.record.updated_at === right.record.updated_at ? 0 : left.record.updated_at < right.record.updated_at ? 1 : -1)
      || (left.record.id < right.record.id ? -1 : 1))

  const topK = request.topK ?? matches.length
  return {
    total: matches.length,
    results: matches.slice(0, Math.max(0, topK)).map(match => ({
      id: match.record.id,
      scope: match.record.scope,
      category: match.record.category,
      content: match.record.content,
      updated_at: match.record.updated_at,
      score: match.score,
    })),
  }
}

/**
 * Whether one string contains CJK characters.
 * @param text - the text to inspect.
 * @returns true when any character is CJK.
 */
export function hasCjk(text: string) {
  return CJK.test(String(text ?? ''))
}
