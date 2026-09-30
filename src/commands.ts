/**
 * The `/memory` command surface.
 *
 * Commands are how a person sees and controls what the harness remembers, and
 * they stay registered whatever the plugin's switch says — otherwise disabling
 * Memory would remove the only way to enable it again.
 *
 * `list` may truncate and says so; `export` may not, because a partial export
 * that looks complete is worse than an error. Destructive commands are explicit:
 * `forget` deletes, `clear` needs `--yes`, and neither can be reached by the
 * model.
 *
 * @module dsh-memory/commands
 */

import { readStore } from './jsonstore.js'
import { bindProject, listProjects, relinkProject } from './registry.js'
import { searchRecords } from './retrieval.js'
import { archiveMemory, clearScope, forgetMemory } from './actions.js'
import { CATEGORIES, STATUSES } from './schema.js'
import { describeOutcome as describeConsolidation } from './consolidation/index.js'
import { isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, MemoryDeps } from './types/deps.js'
import { failureMessage } from './errors.js'

/** Largest number of rows `list` prints before it says how many remain. */
const LIST_PAGE = 100

/**
 * Register the `/memory` command.
 * @param ctx - Cordis context of this plugin's fiber.
 * @param deps - what the command reads, writes, and controls.
 * @returns the exact disposer that removes the command.
 */
export function registerMemoryCommands(ctx: Context, deps: MemoryDeps) {
  return ctx.commands.register({
    name: 'memory',
    description: 'Inspect and control persistent Memory',
    input: { hint: 'list | search | inspect | archive | forget | clear | export | consolidate | enable | disable | project' },
    handler: invocation => run(deps, invocation),
  })
}

/**
 * Dispatch one `/memory` invocation.
 * @param deps - what the command reads, writes, and controls.
 * @param invocation - the command invocation.
 * @returns the text to show, or an error.
 */
async function run(deps: MemoryDeps, invocation: CommandInvocation) {
  const { positional, flags, error: argumentError } = parseArguments(invocation.rawInput)
  if (argumentError !== undefined) return error(`Invalid command arguments: ${argumentError}`)
  const [group, ...rest] = positional
  try {
    switch (group) {
      case undefined: return ok(usageText(deps))
      case 'list': return await listCommand(deps, invocation, flags)
      case 'search': return await searchCommand(deps, invocation, rest, flags)
      case 'inspect': return await inspectCommand(deps, invocation, rest)
      case 'archive': return await archiveCommand(deps, invocation, rest)
      case 'forget': return await forgetCommand(deps, invocation, rest)
      case 'clear': return await clearCommand(deps, invocation, flags)
      case 'export': return await exportCommand(deps, invocation, flags)
      case 'consolidate': return await consolidateCommand(deps, invocation, flags)
      case 'enable': return enableCommand(deps, true)
      case 'disable': return enableCommand(deps, false)
      case 'project': return await projectCommand(deps, invocation, rest)
      default: return error(`unknown /memory subcommand "${String(group)}"\n\n${usageText(deps)}`)
    }
  } catch (failure) {
    return error(`dsh-memory: ${failureMessage(failure)}`)
  }
}

/**
 * Print the stored Memory of one or both scopes.
 * @param deps - what the command reads.
 * @param invocation - the command invocation.
 * @param flags - parsed flags.
 * @returns the rendered list.
 */
async function listCommand(deps: MemoryDeps, invocation: CommandInvocation, flags) {
  const status = typeof flags.get('status') === 'string' ? flags.get('status') : 'active'
  if (status !== 'all' && !STATUSES.includes(status)) {
    return error(`dsh-memory: --status must be one of ${[...STATUSES, 'all'].join(', ')}`)
  }
  const category = typeof flags.get('category') === 'string' ? flags.get('category') : undefined
  if (category !== undefined && !CATEGORIES.includes(category)) {
    return error(`dsh-memory: --category must be one of ${CATEGORIES.join(', ')}`)
  }
  const records = selectedScopes(deps, invocation, flags)
  const rows = records
    .filter(entry => (status === 'all' || entry.record.status === status))
    .filter(entry => category === undefined || entry.record.category === category)
    .sort((left, right) => left.record.updated_at < right.record.updated_at ? 1 : -1)

  if (rows.length === 0) return ok('No Memory matches.')
  const shown = rows.slice(0, LIST_PAGE)
  const lines = shown.map(({ record }) => `${record.id}  [${record.scope}/${record.category}] ${record.status}  ${record.content}`)
  const footer = rows.length > shown.length ? `\n\nShowing ${String(shown.length)} of ${String(rows.length)}.` : ''
  return ok(`${lines.join('\n')}${footer}`)
}

/**
 * Search Memory with a query.
 * @param deps - what the command reads.
 * @param invocation - the command invocation.
 * @param rest - positional arguments after `search`.
 * @param flags - parsed flags.
 * @returns the ranked matches.
 */
async function searchCommand(deps: MemoryDeps, invocation: CommandInvocation, rest, flags) {
  const query = rest.join(' ')
  if (query === '') return error('usage: /memory search <query> [--top <n>] [--user|--project]')
  const scope = flags.has('user') ? 'user' : flags.has('project') ? 'project' : 'all'
  const project = deps.projectFor(invocation.agent)
  const topK = Number(flags.get('top') ?? deps.config.retrievalTopK)
  if (!Number.isInteger(topK) || topK < 1) return error('dsh-memory: --top must be a positive integer')
  const found = searchRecords(
    readStore(deps.scopes.user.storePath).records.concat(projectRecords(deps, project)),
    { query, scope, projectId: project?.project_id, topK },
  )
  if (found.results.length === 0) return ok(`No Memory matches "${query}".`)
  return ok(found.results.map(hit => `${hit.id}  [${hit.scope}/${hit.category}]  ${hit.content}`).join('\n'))
}

/**
 * Show one Memory in full.
 * @param deps - what the command reads.
 * @param invocation - the command invocation.
 * @param rest - positional arguments after `inspect`.
 * @returns the record, or an error.
 */
async function inspectCommand(deps: MemoryDeps, invocation: CommandInvocation, rest) {
  const [id] = rest
  if (id === undefined) return error('usage: /memory inspect <id>')
  const found = findVisible(deps, invocation, id)
  if (found === undefined) return error(`dsh-memory: ${id} is not present in Memory visible to this session`)
  return ok(`${JSON.stringify(found, null, 2)}\n`)
}

/**
 * Archive one Memory.
 * @param deps - what the command writes.
 * @param invocation - the command invocation.
 * @param rest - positional arguments after `archive`.
 * @returns the outcome.
 */
async function archiveCommand(deps: MemoryDeps, invocation: CommandInvocation, rest) {
  const [id] = rest
  if (id === undefined) return error('usage: /memory archive <id>')
  const outcome = await archiveMemory(actionOptions(deps, invocation), {
    id,
    projectId: deps.projectFor(invocation.agent)?.project_id,
  })
  return ok(describeOutcome('archived', outcome))
}

/**
 * Delete one Memory outright.
 * @param deps - what the command writes.
 * @param invocation - the command invocation.
 * @param rest - positional arguments after `forget`.
 * @returns the outcome.
 */
async function forgetCommand(deps: MemoryDeps, invocation: CommandInvocation, rest) {
  const [id] = rest
  if (id === undefined) return error('usage: /memory forget <id>')
  const outcome = await forgetMemory(actionOptions(deps, invocation), {
    id,
    projectId: deps.projectFor(invocation.agent)?.project_id,
  })
  const gone = `The record and its content are gone from ${deps.config.memoryDir}.`
  return ok(outcome.action !== 'forgotten'
    ? describeOutcome('forgotten', outcome)
    : `${describeOutcome('forgotten', outcome)}\n${gone}${outcome.tombstoneWritten === true
      ? ' A tombstone without content remains.'
      : ' The audit tombstone could not be written; the deletion itself succeeded.'}`)
}

/**
 * Run automatic consolidation now, instead of waiting for an idle debounce.
 *
 * The manual trigger exists for debugging and for evaluation: it runs the same
 * pipeline the debounce runs, so what it reports is what an automatic run would
 * have done. `--dry-run` stops before the commit and before the progress mark,
 * so the same window can be inspected repeatedly.
 * @param deps - what the command controls.
 * @param invocation - the command invocation.
 * @param flags - parsed flags.
 * @returns the outcome, or a refusal when the switch is off.
 */
async function consolidateCommand(deps: MemoryDeps, invocation: CommandInvocation, flags) {
  if (deps.isEnabled() === false) return error('dsh-memory is disabled; run /memory enable first')
  if (deps.consolidationEnabled?.() === false) {
    return error('dsh-memory: automatic consolidation is turned off in this profile (consolidation.enabled)')
  }
  try {
    const outcome = await deps.consolidate(invocation.agent, {
      dryRun: flags.has('dry-run') === true,
      trigger: 'manual-command',
    })
    return ok(describeConsolidation(outcome))
  } catch (failure) {
    return error(`dsh-memory: consolidation failed: ${failureMessage(failure)}`)
  }
}

/**
 * Delete every Memory in one scope.
 * @param deps - what the command writes.
 * @param invocation - the command invocation.
 * @param flags - parsed flags.
 * @returns the outcome, or a refusal when `--yes` is missing.
 */
async function clearCommand(deps: MemoryDeps, invocation: CommandInvocation, flags) {
  const scope = flags.has('user') ? 'user' : flags.has('project') ? 'project' : undefined
  if (scope === undefined) return error('usage: /memory clear --user|--project --yes')
  const project = deps.projectFor(invocation.agent)
  if (scope === 'project' && project === null) return error('dsh-memory: this session has no project scope')
  const count = (scope === 'user' ? readStore(deps.scopes.user.storePath).records : projectRecords(deps, project)).length
  if (flags.has('yes') !== true) {
    return ok(`This would delete ${String(count)} ${scope}-scope Memory record(s). Re-run with --yes to proceed.`)
  }
  const outcome = await clearScope(actionOptions(deps, invocation), { scope, projectId: project?.project_id })
  if (outcome.action !== 'cleared') return ok(`Nothing to delete in the ${scope} scope.`)
  return ok(`Deleted ${String(outcome.count)} ${scope}-scope Memory record(s). The content is gone from ${deps.config.memoryDir}.${outcome.tombstoneWritten === true
    ? ' A summary tombstone without content remains.'
    : ' The audit tombstone could not be written; the deletion itself succeeded.'}`)
}

/**
 * Print every Memory of one or both scopes, in full.
 * @param deps - what the command reads.
 * @param invocation - the command invocation.
 * @param flags - parsed flags.
 * @returns the export, or an error when it cannot be shown in one answer.
 */
async function exportCommand(deps: MemoryDeps, invocation: CommandInvocation, flags) {
  const format = typeof flags.get('format') === 'string' ? flags.get('format') : 'md'
  if (format !== 'md' && format !== 'json') return error('dsh-memory: --format must be md or json')
  const rows = selectedScopes(deps, invocation, flags)
  const text = format === 'json'
    ? `${JSON.stringify(rows.map(entry => entry.record), null, 2)}\n`
    : rows.map(entry => `${entry.record.id}\t${entry.record.scope}\t${entry.record.category}\t${entry.record.status}\t${entry.record.content}`).join('\n').concat(rows.length === 0 ? '' : '\n')
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > deps.config.exportInlineMaxBytes) {
    return error([
      `dsh-memory: this export is ${String(bytes)} bytes, over the ${String(deps.config.exportInlineMaxBytes)}-byte inline limit.`,
      'Nothing was truncated. Narrow it with --user or --project, or raise exportInlineMaxBytes in the plugin config.',
    ].join('\n'))
  }
  return ok(text === '' ? 'No Memory to export.' : text)
}

/**
 * Turn Memory on or off, persisting the choice.
 * @param deps - what the command controls.
 * @param enabled - the requested state.
 * @returns the outcome.
 */
async function enableCommand(deps: MemoryDeps, enabled) {
  try {
    await deps.setEnabled(enabled)
  } catch (failure) {
    return error(`dsh-memory: could not persist the switch: ${failureMessage(failure)}`)
  }
  return ok(enabled
    ? 'Memory is enabled: the index is injected and the memory tools are available.'
    : 'Memory is disabled: no index is injected and the memory tools are gone. /memory still works, so /memory enable can turn it back on.')
}

/**
 * Inspect and rebind project identity.
 * @param deps - what the command reads and writes.
 * @param invocation - the command invocation.
 * @param rest - positional arguments after `project`.
 * @returns the outcome.
 */
async function projectCommand(deps: MemoryDeps, invocation: CommandInvocation, rest) {
  const [action, ...args] = rest
  const registryOptions = { ...deps.registry, projectRootMarkers: deps.config.projectRootMarkers }
  if (action === 'show' || action === undefined) {
    const projects = listProjects(deps.registry.registryPath)
    const current = deps.projectFor(invocation.agent)
    if (projects.length === 0) return ok('No project is registered yet.')
    const lines = projects.map(entry => [
      `${entry.project_id}${entry.project_id === current?.project_id ? '  (current)' : ''}`,
      `  root: ${entry.canonical_root}`,
      ...entry.aliases.length > 0 ? [`  aliases: ${entry.aliases.join(', ')}`] : [],
      ...entry.missing_roots.length > 0 ? [`  missing: ${entry.missing_roots.join(', ')}`] : [],
    ].join('\n'))
    return ok(lines.join('\n'))
  }
  const cwd = invocation.agent?.session?.header?.cwd
  if (action === 'bind') {
    const [path] = args
    if (path === undefined) return error('usage: /memory project bind <path>')
    const bound = await bindProject(registryOptions, resolvePath(cwd, path))
    // The session's own project is cached, so a bind that changes where this
    // session works must refresh it; otherwise the very next command would still
    // see no project.
    await deps.resolveProjectFor(invocation.agent)
    return ok(`${bound.created ? 'Bound' : 'Already bound'} ${bound.project.canonical_root} as ${bound.project.project_id}.`)
  }
  if (action === 'relink') {
    const [oldPath, newPath] = args
    if (oldPath === undefined || newPath === undefined) return error('usage: /memory project relink <old-path> <new-path>')
    const relinked = await relinkProject(registryOptions, resolvePath(cwd, oldPath), resolvePath(cwd, newPath))
    await deps.resolveProjectFor(invocation.agent)
    return ok(relinked.changed
      ? `${relinked.project.project_id} now lives at ${relinked.project.canonical_root}.`
      : `${relinked.project.project_id} already lives at ${relinked.project.canonical_root}.`)
  }
  return error(`unknown /memory project subcommand "${String(action)}"; use bind, relink, or show`)
}

/**
 * Render the help text.
 * @param deps - what the command controls, for the current switch state.
 * @returns the usage text.
 */
function usageText(deps: MemoryDeps) {
  return [
    `dsh-memory (${deps.isEnabled() ? 'enabled' : 'disabled'}) — Memory lives in ${deps.config.memoryDir}`,
    '',
    '/memory list [--user|--project] [--status active|superseded|archived|all] [--category <c>]',
    '/memory search <query> [--top <n>] [--user|--project]',
    '/memory inspect <id>',
    '/memory archive <id>',
    '/memory forget <id>',
    '/memory clear --user|--project --yes',
    '/memory export [--user|--project] [--format md|json]',
    '/memory consolidate [--dry-run]',
    '/memory enable | /memory disable',
    '/memory project bind <path> | relink <old> <new> | show',
  ].join('\n')
}

/**
 * The scopes one invocation selected.
 * @param deps - what the command reads.
 * @param invocation - the command invocation.
 * @param flags - parsed flags.
 * @returns user-scope and project-scope rows.
 */
function selectedScopes(deps: MemoryDeps, invocation: CommandInvocation, flags) {
  const wantUser = flags.has('user') || !flags.has('project')
  const wantProject = flags.has('project') || !flags.has('user')
  const rows = []
  if (wantUser) {
    for (const record of readStore(deps.scopes.user.storePath).records) rows.push({ record })
  }
  if (wantProject) {
    for (const record of projectRecords(deps, deps.projectFor(invocation.agent))) rows.push({ record })
  }
  return rows
}

/**
 * The current project's records.
 * @param deps - what the command reads.
 * @param project - the current project, when there is one.
 * @returns its records, or none.
 */
function projectRecords(deps: MemoryDeps, project) {
  if (project === null || project === undefined) return []
  return readStore(deps.scopes.project(project.project_id).storePath).records
}

/**
 * Find one record among the scopes this session may read.
 * @param deps - what the command reads.
 * @param invocation - the command invocation.
 * @param id - the record id.
 * @returns the record, or undefined.
 */
function findVisible(deps: MemoryDeps, invocation: CommandInvocation, id) {
  const project = deps.projectFor(invocation.agent)
  const user = readStore(deps.scopes.user.storePath).records.find(record => record.id === id)
  if (user !== undefined) return user
  return projectRecords(deps, project).find(record => record.id === id)
}

/**
 * Build the options one action call needs.
 * @param deps - what the command writes.
 * @param invocation - the command invocation.
 * @returns options for the action layer.
 */
function actionOptions(deps: MemoryDeps, invocation: CommandInvocation) {
  return {
    scopes: deps.scopes,
    tombstones: deps.tombstones,
    lockTimeoutMs: deps.config.lockTimeoutMs,
    staleLockMs: deps.config.staleLockMs,
    maxEvidencePerMemory: deps.config.maxEvidencePerMemory,
    logger: deps.logger,
  }
}

/**
 * Describe one action outcome in a sentence.
 * @param verb - what the action did.
 * @param outcome - the action's result.
 * @returns the sentence.
 */
function describeOutcome(verb, outcome) {
  if (outcome.action === 'noop') return `Nothing to do: ${String(outcome.reason)}.`
  return `${verb} ${String(outcome.id ?? '')}`.trim()
}

/**
 * Resolve one command argument against the session's working directory.
 * @param cwd - the session working directory.
 * @param path - the supplied path.
 * @returns an absolute path.
 */
function resolvePath(cwd, path) {
  return isAbsolute(path) ? path : resolve(cwd ?? process.cwd(), path)
}

/** Flags that consume the following token as their value. */
const VALUE_FLAGS = new Set(['status', 'category', 'top', 'format'])

/**
 * Split one raw command input into tokens, honouring quoting.
 *
 * A path with a space is one argument, not two, and the shell-like escapes a
 * person already expects (`"..."`, `'...'`, and `\ `) work here too. Without
 * this, `/memory project bind /Users/me/My Projects` would silently bind
 * `/Users/me/My` and treat `Projects` as a second positional argument.
 * @param rawInput - the text after the command name.
 * @returns the tokens and, when a quote is never closed, the reason to refuse.
 */
function tokenize(rawInput) {
  const text = String(rawInput ?? '')
  const tokens = []
  let current = ''
  let started = false
  let quote = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (quote !== null) {
      if (char === quote) {
        quote = null
        continue
      }
      if (char === '\\' && quote === '"' && index + 1 < text.length) {
        index += 1
        current += text[index]
        continue
      }
      current += char
      continue
    }
    if (char === '"' || char === '\'') {
      quote = char
      started = true
      continue
    }
    if (char === '\\' && index + 1 < text.length) {
      index += 1
      current += text[index]
      started = true
      continue
    }
    if (/\s/u.test(char)) {
      if (started) tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += char
    started = true
  }
  // A quote that never closes is refused rather than closed here: the argument
  // boundary would then be this function's guess, and binding a path assembled
  // from a guess is worse than asking for the line again.
  if (quote !== null) return { tokens: [], error: 'unterminated quote.' }
  if (started) tokens.push(current)
  return { tokens, error: undefined }
}

/**
 * Split one raw command input into positional arguments and flags.
 *
 * Both `--name value` and `--name=value` are accepted, for the flags that take a
 * value; every other flag is a switch, so a following word stays positional.
 * @param rawInput - the text after the command name.
 * @returns positional arguments, flags where a bare switch maps to `true`, and
 *   the reason to refuse the line when it cannot be tokenized.
 */
function parseArguments(rawInput) {
  const { tokens, error } = tokenize(rawInput)
  if (error !== undefined) return { positional: [], flags: new Map(), error }
  const positional = []
  const flags = new Map()
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined) continue
    if (!token.startsWith('--')) {
      positional.push(token)
      continue
    }
    const separator = token.indexOf('=')
    if (separator >= 0) {
      flags.set(token.slice(2, separator), token.slice(separator + 1))
      continue
    }
    const name = token.slice(2)
    const next = tokens[index + 1]
    if (VALUE_FLAGS.has(name) && next !== undefined && !next.startsWith('--')) {
      flags.set(name, next)
      index += 1
      continue
    }
    flags.set(name, true)
  }
  return { positional, flags, error: undefined }
}

/**
 * Wrap text as a successful command result.
 * @param text - the text to show.
 * @returns the command result.
 */
function ok(text) {
  return { kind: 'success', text }
}

/**
 * Wrap text as a failed command result.
 * @param text - the text to show.
 * @returns the command result.
 */
function error(text) {
  return { kind: 'error', text }
}
