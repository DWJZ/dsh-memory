/**
 * dsh-memory — host half.
 *
 * Persistent user and project Memory for DeepSeek Harness. Every record lives
 * under `$DSH_HOME/memory`, never inside a project, and a compact index of the
 * active records is injected into each new Session.
 *
 * Memory is reached two ways. The explicit path is the `memory_*` tools and the
 * `/memory` command: the user asks, and the record is written immediately.
 * The automatic path is consolidation, which reads a finished turn after the
 * agent goes idle, asks a model what in it is worth keeping, and commits only
 * what a deterministic review accepts. Both paths write through the same Phase 1
 * actions, so scope, provenance and screening behave identically.
 *
 * The index and the model tools are registrations, so disabling Memory disposes
 * them rather than leaving callbacks that quietly do nothing. The `/memory`
 * command stays registered in both states, because it is the only way back.
 *
 * The plugin imports no harness package at runtime, so it installs from a
 * checkout with no dependency step.
 *
 * @module dsh-memory
 */

import { resolveConfig } from './config.js'
import { projectLayout, registryLayout, tombstoneLayout, userLayout, consolidationLayout } from './paths.js'
import { readRegistry, resolveProject } from './registry.js'
import { cleanupStaleTemps, readStore } from './jsonstore.js'
import { rebuildView } from './views.js'
import { buildProvenance, createTurnTracker, registerMemoryIndex, registerMemoryPolicy } from './inject.js'
import { registerMemoryTools } from './tools.js'
import { registerMemoryCommands } from './commands.js'
import { renderMemoryIndex } from './retention.js'
import { resolveEnabled, writeEnabled } from './settings.js'
import type { PluginConfig } from './settings.js'
import { createCollector } from './consolidation/collector.js'
import { createConsolidation } from './consolidation/index.js'
import { isAbsolute, relative } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryDeps } from './types/deps.js'
import type { MemorySettings } from './types/config.js'
import type { ProjectEntry, ResolvedProject } from './types/identity.js'

/** Stable Cordis plugin name. */

/**
 * Describe a caught value the way these warnings always did: an Error's message,
 * a plain object's `message` when it has one, and otherwise the value itself.
 * @param failure - whatever was caught.
 * @returns the text to log.
 */
function describeFailure(failure: unknown): string {
  if (failure instanceof Error) return failure.message
  if (typeof failure === 'object' && failure !== null && 'message' in failure) {
    return String((failure as { message: unknown }).message)
  }
  return String(failure)
}

export const name = 'dsh-memory'

/**
 * The command surface is required: it is how a user reads and controls Memory,
 * and how a disabled plugin is turned back on. The index and the tools are
 * optional services, so they are taken per use and a profile without them simply
 * gets a plugin that cannot be enabled into doing anything.
 */
export const inject = ['commands']

/**
 * Wire the plugin into one Cordis fiber.
 * @param ctx - Cordis context of this plugin's fiber.
 * @param config - raw plugin configuration from cordis.yml, possibly absent.
 */
export function apply(ctx: Context, config: PluginConfig) {
  const settings = resolveConfig(config)
  const controller = createController(ctx, settings)
  ctx.effect(() => () => controller.dispose(), 'dsh-memory.lifecycle')
  controller.start()
}

/**
 * Build the object that owns this plugin's registrations and switch.
 * @param ctx - Cordis context of this plugin's fiber.
 * @param settings - resolved plugin settings.
 * @returns the controller.
 */
function createController(ctx: Context, settings: MemorySettings) {
  const scopes = {
    user: userLayout(settings.memoryDir),
    project: (projectId: string | null | undefined) => projectLayout(settings.memoryDir, projectId),
  }
  const registry = registryLayout(settings.memoryDir)
  const tombstones = tombstoneLayout(settings.memoryDir)
  const logger = ctx.logger
  const tracker = createTurnTracker(ctx)
  // Keyed by working directory, not by session: several agents can share one
  // session — the auxiliary agent that names it runs elsewhere — and the last one
  // created must not decide which project the others write to.
/** Session event type carrying which project a Session was attributed to. */
const PROJECT_EVENT_TYPE = 'dsh-memory/project'

  const projectsByCwd = new Map()
  /** Sessions whose attribution was already recorded, so it is written once. */
  const announcedProjects = new Set()
  let enabled = resolveEnabled(settings.memoryDir, settings.enabled)
  let runtimeFiber: { dispose(): Promise<void> } | null = null
  let llmScope: Context | null = null
  /** Built in `start()`, but referenced by the switch, which outlives mounting. */
  // Assigned in `start()` before anything reads it; the switch that flips the
  // plugin back on runs later, so the compiler cannot see the assignment.
  let consolidation!: ReturnType<typeof createConsolidation>

  /**
   * The wiring the index, the tools, the commands and the switch all share.
   *
   * Complete from here. The members `start()` used to attach afterwards are
   * forwarders whose bodies resolve those bindings when they are called, which is
   * after `start()` has run and the registrations that reach them exist.
   */
  const deps: MemoryDeps = {
    config: settings,
    scopes,
    registry,
    tombstones,
    logger,
    projectFor: (agent: MemoryAgent) => projectsByCwd.get(cwdOf(agent)) ?? null,
    evidenceFor: (agent: MemoryAgent) => buildProvenance(agent, tracker, { evidenceQuoteMaxChars: settings.evidenceQuoteMaxChars }),
    setEnabled: (next: boolean) => setEnabled(next),
    isEnabled: () => enabled === true,
    // A command that rebinds a directory must be able to refresh the session's
    // cached project, or the next command would still see the old one.
    resolveProjectFor: (agent: MemoryAgent) => resolveForAgent(agent),
    consolidationEnabled: () => settings.consolidation.enabled,
    consolidate: (agent: MemoryAgent, runOptions) => consolidation.consolidate(agent, runOptions),
  }

  /**
   * Register the index and the tools.
   *
   * Both contribute to services a profile may not mount, so they are taken as an
   * optional injection rather than by declaring a hard dependency. The fiber
   * that `inject` returns owns those registrations: disposing it removes them,
   * and keeping it is what stops a service remount from resurrecting them after
   * a disable, or a second enable from leaving two live fibers behind.
   * @returns nothing.
   */
  const mountRuntime = () => {
    if (runtimeFiber !== null) return
    runtimeFiber = ctx.inject(['systemPrompt', 'tools'], (scope) => {
      registerMemoryPolicy(scope)
      registerMemoryIndex(scope, (agent: MemoryAgent) => renderIndex(deps, agent))
      registerMemoryTools(scope, deps)
    })
  }

  /**
   * Remove the index and the tools by disposing their fiber.
   * @returns fulfillment once the registrations are gone.
   */
  const unmountRuntime = async () => {
    const fiber = runtimeFiber
    runtimeFiber = null
    if (fiber !== null && typeof fiber?.dispose === 'function') await fiber.dispose()
  }

  /**
   * Apply the switch, persisting the choice first.
   * @param next - the requested state.
   * @returns fulfillment once the runtime matches the choice.
   * @throws when the choice cannot be persisted, leaving the runtime unchanged.
   */
  const setEnabled = async (next: boolean) => {
    if (next === enabled) return
    writeEnabled(settings.memoryDir, next)
    enabled = next
    if (next) {
      mountRuntime()
      return
    }
    // Stop the automatic path before removing the runtime it would write
    // through, then wait: a run already past cancellation would otherwise still
    // reach a model and a Memory write after this returned.
    consolidation?.cancelPending()
    await unmountRuntime()
    await consolidation?.whenSettled()
  }

  /**
   * Resolve and remember one working directory's project.
   * @param agent - the agent whose directory needs a project.
   * @returns fulfillment once the lookup is settled.
   */
  const resolveForAgent = async (agent: MemoryAgent) => {
    const cwd = cwdOf(agent)
    if (cwd === undefined) return
    try {
      const workspace = workspaceOf(ctx, cwd)
      const project = await resolveProject(
        { ...registry, projectRootMarkers: settings.projectRootMarkers },
        { cwd, workspaceRoot: workspace?.root, workspaceId: workspace?.id },
      )
      if (project !== null) {
        projectsByCwd.set(cwd, project)
        announceProject(agent, project, workspace)
      }
    } catch (failure) {
      logger.warn(`dsh-memory: could not resolve the project for ${cwd}: ${describeFailure(failure)}`)
    }
  }

  /**
   * Record which project a Session was attributed to.
   *
   * Written once per Session: the point is to make "why did this Memory land in
   * that project" answerable from the log, and an attribution repeated on every
   * request would bury it. The payload is our own ids and a path, never Memory
   * content.
   * @param agent - the agent whose Session is being attributed.
   * @param project - the resolved project.
   * @param workspace - the harness workspace that contains the directory, if any.
   */
  const announceProject = (
    agent: MemoryAgent,
    project: ResolvedProject,
    workspace: { id: string } | null | undefined,
  ) => {
    if (settings.sessionEvents !== true) return
    const session = agent?.session
    if (session === undefined || typeof session.append !== 'function') return
    if (announcedProjects.has(session.id)) return
    announcedProjects.add(session.id)
    try {
      session.append(PROJECT_EVENT_TYPE, {
        project_id: project.project_id,
        canonical_root: project.canonical_root,
        workspace_id: workspace?.id ?? null,
        matched_by: project.matched_by,
      }, { ignorable: true })
    } catch (failure) {
      logger.warn(`dsh-memory: could not record the project attribution: ${describeFailure(failure)}`)
    }
  }

  return {
    /**
     * Register everything this plugin owns.
     * @returns nothing.
     */
    start() {
      // A command that rebinds a directory must be able to refresh the session's
      // cached project, or the next command would still see the old one.
      const disposeCommands = registerMemoryCommands(ctx, deps)
      const disposeCreated = ctx.on('agent/created', async ({ agent }) => {
        // `agent/created` is a serial event: the loop awaits each listener before
        // the first request, which is exactly the guarantee this lookup needs.
        // Resolving in the background would let the first turn run without a
        // project, losing both the project index and a project-scoped remember.
        await resolveForAgent(agent)
      })
      const disposeDisposed = ctx.on('agent/disposed', () => {
        // The cache is keyed by directory and bounded by how many directories one
        // process ever works in, so it is left to outlive individual agents.
      })
      consolidation = createConsolidation({
        sessionEvents: settings.sessionEvents,
        llmScope: () => llmScope,
        collector: createCollector(),
        scopes,
        state: consolidationLayout(settings.memoryDir),
        actionOptions: {
          scopes,
          tombstones,
          maxEvidencePerMemory: settings.maxEvidencePerMemory,
          lockTimeoutMs: settings.lockTimeoutMs,
          staleLockMs: settings.staleLockMs,
          logger,
          host: settings.host,
          kill: settings.kill,
        },
        config: {
          ...settings.consolidation,
          lockTimeoutMs: settings.lockTimeoutMs,
          staleLockMs: settings.staleLockMs,
          maxEvidencePerMemory: settings.maxEvidencePerMemory,
          quoteMaxChars: settings.evidenceQuoteMaxChars,
        },
        projectFor: (agent: MemoryAgent) => projectsByCwd.get(cwdOf(agent)) ?? null,
        logger,
      })
      // The model call needs the `llm` service, which a profile may not mount.
      // Taking it as an injection rather than a hard dependency keeps Memory
      // itself usable without one: explicit writes and the command surface keep
      // working, and only consolidation reports that it has no model to ask.
      const llmFiber = ctx.inject(['llm'], (scope) => { llmScope = scope })
      // Every committed event is offered to the collector; it keeps what it saw
      // and drops what a settled batch has consumed.
      // Both seams follow the runtime switch as well as the deployment config:
      // switching Memory off has to stop collection and the debounce, or a
      // disabled plugin would keep asking a model and writing Memory.
      const collecting = () => enabled && settings.consolidation.enabled
      // `autoCommit: false` means "do not learn on your own". Only the debounce
      // is gated: collecting costs nothing, so the events stay available to
      // `/memory consolidate`, which a person runs deliberately.
      const learningOnItsOwn = () => collecting() && settings.consolidation.autoCommit === true
      const disposeEvents = ctx.on('session/event', (session: MemorySession, event) => {
        if (collecting()) consolidation.observe(session, event)
      })
      const disposeStatus = ctx.on('agent/status', ({ agent, status }) => {
        if (learningOnItsOwn()) consolidation.statusChanged(agent, status)
      })
      ctx.effect(() => () => {
        llmScope = null
        void llmFiber?.dispose()
        consolidation.dispose()
        disposeStatus()
        disposeEvents()
        disposeDisposed()
        disposeCreated()
        disposeCommands()
      }, 'dsh-memory.registrations')

      if (enabled) mountRuntime()
      void refreshViewsOnMount(deps)
    },

    /**
     * Release everything this plugin owns.
     * @returns fulfillment once the runtime fiber is disposed.
     */
    async dispose() {
      // Cancellation first, then the wait, then the runtime: a run that is
      // already past cancellation would otherwise reach the model and the store
      // while the plugin is being taken down.
      consolidation?.cancelPending()
      await consolidation?.whenSettled()
      await unmountRuntime()
      tracker.dispose()
      projectsByCwd.clear()
    },

    /** The switch, as the command layer sees it. */
    setEnabled,
  }
}

/**
 * Render the injected index for one agent.
 *
 * A canonical read failure propagates rather than degrading to an empty index.
 * `memories.json` is the source of truth, so a store that violates its own
 * schema is a fault to report, not a Memory that happens to be empty: swallowing
 * it would leave the agent quietly amnesiac, which is harder to notice and
 * harder to diagnose than a turn that names the broken file. The throw reaches
 * the model request through this context function, so the turn stops there.
 *
 * A store that is simply absent is not corruption: `readStore` returns an empty
 * store for it, which is what a first run looks like.
 * @param deps - resolved settings and layouts.
 * @param agent - the agent whose request is being assembled.
 * @returns the index text, or an empty string when there is nothing to inject.
 * @throws when a canonical store cannot be read or violates its schema.
 */
function renderIndex(deps: MemoryDeps, agent: MemoryAgent) {
  const project = deps.projectFor(agent)
  return renderMemoryIndex({
    user: readStore(deps.scopes.user.storePath).records,
    project: project === null ? [] : readStore(deps.scopes.project(project.project_id).storePath).records,
  }, { budgetBytes: deps.config.indexBudgetBytes, split: deps.config.indexBudgetSplit })
}

/**
 * Regenerate every scope's generated view and sweep stale temporary files.
 *
 * Views are derived, so a failure here is reported and ignored: the canonical
 * store is already durable.
 * @param deps - resolved settings and layouts.
 * @returns fulfillment once the refresh is settled.
 */
async function refreshViewsOnMount(deps: MemoryDeps) {
  const { lockTimeoutMs, staleLockMs, logger } = deps.config
  try {
    // A reaper never holds anything for long, so a temporary file is abandoned
    // only once it has outlived the longest legitimate write by a wide margin.
    cleanupStaleTemps(deps.config.memoryDir, {
      staleTempMs: Math.max(staleLockMs, lockTimeoutMs * 2),
    })
  } catch (failure) {
    logger?.warn(`dsh-memory: could not sweep temporary files: ${describeFailure(failure)}`)
  }
  const layouts = [deps.scopes.user]
  try {
    for (const entry of readRegistry(deps.registry.registryPath).projects) {
      layouts.push(deps.scopes.project(entry.project_id))
    }
  } catch (failure) {
    logger?.warn(`dsh-memory: could not read the project registry: ${describeFailure(failure)}`)
  }
  for (const layout of layouts) {
    try {
      await rebuildView({ ...layout, lockTimeoutMs, staleLockMs, logger })
    } catch (failure) {
      logger?.warn(`dsh-memory: memory-view-stale: ${layout.viewPath}: ${describeFailure(failure)}`)
    }
  }
}

/**
 * The working directory of one agent.
 * @param agent - the agent to describe.
 * @returns its absolute working directory, or undefined.
 */
function cwdOf(agent: MemoryAgent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/**
 * The workspace one working directory belongs to, when the runtime has one.
 *
 * The workspace registry is mounted by the Web bundle only, so its absence is
 * ordinary and the lookup stays optional.
 * @param ctx - Cordis context of this plugin's fiber.
 * @param cwd - the session working directory.
 * @returns the workspace root and id, or undefined.
 */
function workspaceOf(ctx: Context, cwd: string) {
  const workspaceRegistry = ctx.get('workspaceRegistry')
  if (workspaceRegistry === undefined || typeof workspaceRegistry.list !== 'function') return undefined
  let workspaces
  try {
    workspaces = workspaceRegistry.list()
  } catch {
    return undefined
  }
  if (!Array.isArray(workspaces)) return undefined
  let best
  for (const workspace of workspaces) {
    const root = typeof workspace?.path === 'string' ? workspace.path : undefined
    if (root === undefined || !contains(root, cwd)) continue
    if (best === undefined || root.length > best.root.length) best = { root, id: workspace.id }
  }
  return best
}

/**
 * Whether one directory contains another.
 * @param root - the candidate ancestor.
 * @param path - the path to test.
 * @returns true when `path` is `root` or lies below it.
 */
function contains(root: string, path: string) {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
