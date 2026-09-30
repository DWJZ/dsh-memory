/**
 * The three model-facing Memory tools.
 *
 * Phase 1 gives the model no way to delete or clear Memory: those are user
 * commands. Writing is confined to one tool that must be called only when the
 * user explicitly asks, and its parameter set is a union in practice — `add`
 * carries the scope and category, while `update` and `supersede` may not, because
 * they inherit both from the record they name. Rejecting contradictory arguments
 * is what keeps a restatement from silently changing which project it belongs to.
 *
 * The plugin registers raw tool definitions rather than importing the harness's
 * tool helper, because a locally installed plugin carries no runtime dependency.
 *
 * @module dsh-memory/tools
 */

import { readStore } from './jsonstore.js'
import { MemoryNotVisibleError, locateVisible, addMemory, supersedeMemory, updateMemory } from './actions.js'
import { searchRecords } from './retrieval.js'
import { CATEGORIES } from './schema.js'
import type { ProjectEntry } from './types/identity.js'
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryDeps } from './types/deps.js'

/** Modes `memory_remember` accepts. */
const MODES = Object.freeze(['add', 'update', 'supersede'])

/** Scopes a model may write to. */
const WRITE_SCOPES = Object.freeze(['user', 'project'])

/** Scopes a model may search. */
const SEARCH_SCOPES = Object.freeze(['user', 'project', 'all'])

/** Shared output declaration: the model reads one compact JSON value. */
const JSON_OUTPUT = Object.freeze({
  schema: { type: 'object' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
})

const SEARCH_DESCRIPTION = [
  'Search long-term Memory saved for this user and this project.',
  'Use it when a saved fact may answer the question; the always-visible index only shows headlines.',
].join(' ')

const GET_DESCRIPTION = [
  'Read one Memory in full, including its provenance and whether a newer Memory replaced it.',
  'Use the id returned by memory_search.',
].join(' ')

const REMEMBER_DESCRIPTION = [
  'Save a fact to long-term Memory at the user\'s request.',
  'Use this ONLY when the user explicitly asks for information to be remembered, saved, persisted, or kept for later sessions.',
  'Do NOT call it merely because information looks important, durable, useful, or likely to matter later,',
  'and do not decide on your own what is worth remembering.',
  'A fact the user asked you to remember is saved even when a file also states it, because the request is the instruction and the file is not Memory.',
  'Learning from ordinary conversation is handled after the turn by the consolidation subsystem, which reads the trajectory and decides what, if anything, becomes Memory.',
  'mode=add creates a Memory and carries scope and category.',
  'mode=update restates one Memory and requires target_id.',
  'mode=supersede replaces one Memory with a newer fact and requires target_id;',
  'both inherit scope and category from the target and must not repeat them.',
].join(' ')

/**
 * Register the Memory tools.
 * @param ctx - Cordis context of this plugin's fiber.
 * @param {object} deps - what the tools read and write.
 * @param deps.config - resolved plugin settings.
 * @param deps.scopes - the user layout and a project layout lookup.
 * @param deps.projectFor - the current project of one agent, or null.
 * @param deps.evidenceFor - host-built provenance for one agent.
 * @returns a disposer removing every registration.
 */
export function registerMemoryTools(ctx: Context, deps: MemoryDeps) {
  const disposers = [
    ctx.tools.register(searchTool(deps)),
    ctx.tools.register(getTool(deps)),
    ctx.tools.register(rememberTool(deps)),
  ]
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Build the `memory_search` tool.
 * @param deps - what the tool reads.
 * @returns the tool definition.
 */
function searchTool(deps: MemoryDeps) {
  return {
    name: 'memory_search',
    description: SEARCH_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in the user\'s own words.' },
        scope: { type: 'string', enum: [...SEARCH_SCOPES], description: 'Defaults to all.' },
        category: { type: 'string', enum: [...CATEGORIES], description: 'Restrict to one kind of Memory.' },
        top_k: {
          type: 'integer',
          minimum: 1,
          maximum: deps.config.retrievalTopK,
          // The deployment's retrieval bound is also the largest result a model
          // may ask for, so one call cannot balloon as the store grows.
          description: `Largest number of results, at most ${String(deps.config.retrievalTopK)}.`,
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    output: { ...JSON_OUTPUT, schema: { type: 'object' } },
    execute(args: Record<string, unknown>, exec) {
      const project = deps.projectFor(exec.agent)
      const found = searchRecords(visibleRecords(deps, project), {
        query: args.query,
        scope: args.scope,
        projectId: project?.project_id,
        category: args.category,
        // Schema validation is the caller's job upstream; clamping here keeps the
        // bound true even when a caller bypasses the declared maximum.
        topK: Math.min(args.top_k ?? deps.config.retrievalTopK, deps.config.retrievalTopK),
      })
      return { results: found.results.map(stripScore), total: found.total }
    },
    presentCall: (args: Record<string, unknown>) => ({ card: 'generic', title: 'Search memory', kind: 'read', rawInput: args }),
  }
}

/**
 * Build the `memory_get` tool.
 * @param deps - what the tool reads.
 * @returns the tool definition.
 */
function getTool(deps: MemoryDeps) {
  return {
    name: 'memory_get',
    description: GET_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The Memory id to read.' } },
      required: ['id'],
      additionalProperties: false,
    },
    output: { ...JSON_OUTPUT, schema: { type: 'object' } },
    execute(args: Record<string, unknown>, exec) {
      const project = deps.projectFor(exec.agent)
      try {
        const located = locateVisible(scopeOptions(deps, project), args.id, project?.project_id ?? null)
        return { found: true, memory: located.record }
      } catch (failure) {
        // Only an invisible id is an answer. A store that cannot be read is a
        // real fault, and reporting it as "not found" would hide it from whoever
        // has to diagnose it.
        if (failure instanceof MemoryNotVisibleError) {
          return { found: false, id: args.id, reason: 'not-found' }
        }
        throw failure
      }
    },
    presentCall: (args: Record<string, unknown>) => ({ card: 'generic', title: 'Read memory', kind: 'read', rawInput: args }),
  }
}

/**
 * Build the `memory_remember` tool.
 * @param deps - what the tool writes.
 * @returns the tool definition.
 */
function rememberTool(deps: MemoryDeps) {
  return {
    name: 'memory_remember',
    description: REMEMBER_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: [...MODES], description: 'add creates, update restates, supersede replaces.' },
        content: { type: 'string', description: 'The fact, as one line.' },
        scope: { type: 'string', enum: [...WRITE_SCOPES], description: 'mode=add only.' },
        category: { type: 'string', enum: [...CATEGORIES], description: 'mode=add only.' },
        target_id: { type: 'string', description: 'mode=update or supersede only.' },
      },
      required: ['mode', 'content'],
      additionalProperties: false,
    },
    output: { ...JSON_OUTPUT, schema: { type: 'object' } },
    async execute(args: Record<string, unknown>, exec) {
      requireParameterSet(args)
      const project = deps.projectFor(exec.agent)
      const options = scopeOptions(deps, project)
      const provenance = deps.evidenceFor(exec.agent) ?? { evidence: undefined, sourceTexts: [] }
      const common = {
        content: args.content,
        evidence: provenance.evidence,
        sourceTexts: provenance.sourceTexts,
      }
      if (args.mode === 'add') {
        return addMemory(options, {
          ...common,
          scope: args.scope,
          category: args.category,
          projectId: project?.project_id,
        })
      }
      if (args.mode === 'update') return updateMemory(options, { ...common, id: args.target_id, projectId: project?.project_id })
      return supersedeMemory(options, { ...common, id: args.target_id, projectId: project?.project_id })
    },
    presentCall: (args: Record<string, unknown>) => ({
      card: 'generic',
      title: 'Remember',
      kind: 'other',
      // The content is deliberately absent: the card must not become a second
      // place a credential could be rendered.
      rawInput: {
        mode: args.mode,
        ...args.mode === 'add' ? { scope: args.scope, category: args.category } : { target_id: args.target_id },
      },
    }),
  }
}

/**
 * Enforce the parameter set one mode allows.
 * @param args - the model's arguments.
 * @throws {TypeError} when a mode carries arguments it may not.
 */
function requireParameterSet(args: Record<string, unknown>) {
  if (args.mode === 'add') {
    if (args.target_id !== undefined) {
      throw new TypeError('dsh-memory: memory_remember with mode=add must not carry target_id')
    }
    if (args.scope === undefined || args.category === undefined) {
      throw new TypeError('dsh-memory: memory_remember with mode=add requires scope and category')
    }
    return
  }
  if (args.target_id === undefined) {
    throw new TypeError(`dsh-memory: memory_remember with mode=${String(args.mode)} requires target_id`)
  }
  if (args.scope !== undefined || args.category !== undefined) {
    throw new TypeError(`dsh-memory: memory_remember with mode=${String(args.mode)} inherits scope and category; do not pass them`)
  }
}

/**
 * Every record this session may read.
 * @param deps - layouts and settings.
 * @param project - the current project, when there is one.
 * @returns user records followed by the current project's records.
 */
function visibleRecords(deps: MemoryDeps, project: ProjectEntry | null | undefined) {
  const user = readStore(deps.scopes.user.storePath).records
  if (project === null || project === undefined) return user
  return [...user, ...readStore(deps.scopes.project(project.project_id).storePath).records]
}

/**
 * Drop the internal score from a search hit.
 * @param hit - one ranked hit.
 * @returns the contract's result fields.
 */
function stripScore(hit) {
  const { score: _score, ...rest } = hit
  return rest
}

/**
 * Build the options one action call needs.
 * @param deps - layouts and settings.
 * @param project - the current project, when there is one.
 * @returns options for the action layer.
 */
function scopeOptions(deps: MemoryDeps, project: ProjectEntry | null | undefined) {
  return {
    scopes: deps.scopes,
    tombstones: deps.tombstones,
    lockTimeoutMs: deps.config.lockTimeoutMs,
    staleLockMs: deps.config.staleLockMs,
    maxEvidencePerMemory: deps.config.maxEvidencePerMemory,
    logger: deps.logger,
    now: deps.now,
  }
}
