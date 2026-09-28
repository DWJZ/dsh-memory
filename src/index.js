/**
 * dsh-memory — host half.
 *
 * Persistent user and project Memory for DeepSeek Harness. Every record lives
 * under `$DSH_HOME/memory`, never inside a project, and a compact index of the
 * active records is injected into each new Session.
 *
 * Phase 1 is infrastructure only: explicit remember / update / supersede, user
 * commands, a bounded index, and a durable store that survives concurrent
 * writers. It deliberately performs no automatic extraction from trajectories
 * and no semantic reasoning about what Memory means.
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
import { projectLayout, registryLayout, tombstoneLayout, userLayout } from './paths.js'
import { readRegistry, resolveProject } from './registry.js'
import { cleanupStaleTemps, readStore } from './jsonstore.js'
import { rebuildView } from './views.js'
import { buildProvenance, createTurnTracker, registerMemoryIndex } from './inject.js'
import { registerMemoryTools } from './tools.js'
import { registerMemoryCommands } from './commands.js'
import { renderMemoryIndex } from './retention.js'
import { resolveEnabled, writeEnabled } from './settings.js'

/** Stable Cordis plugin name. */
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
export function apply(ctx, config) {
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
function createController(ctx, settings) {
  const scopes = {
    user: userLayout(settings.memoryDir),
    project: projectId => projectLayout(settings.memoryDir, projectId),
  }
  const registry = registryLayout(settings.memoryDir)
  const tombstones = tombstoneLayout(settings.memoryDir)
  const logger = ctx.logger
  const tracker = createTurnTracker(ctx)
  // Keyed by working directory, not by session: several agents can share one
  // session — the auxiliary agent that names it runs elsewhere — and the last one
  // created must not decide which project the others write to.
  const projectsByCwd = new Map()
  let enabled = resolveEnabled(settings.memoryDir, settings.enabled)
  let runtime = null

  const deps = {
    config: settings,
    scopes,
    registry,
    tombstones,
    logger,
    projectFor: agent => projectsByCwd.get(cwdOf(agent)) ?? null,
    evidenceFor: agent => buildProvenance(agent, tracker, { evidenceQuoteMaxChars: settings.evidenceQuoteMaxChars }),
  }

  /**
   * Register the index and the tools.
   *
   * Both contribute to services a profile may not mount, so they are taken as an
   * optional injection rather than by declaring a hard dependency; the inner
   * disposers are kept so disabling removes the registrations even though the
   * injection scope itself may outlive them.
   * @returns nothing.
   */
  const mountRuntime = () => {
    if (runtime !== null) return
    ctx.inject(['systemPrompt', 'tools'], (scope) => {
      const disposers = [
        registerMemoryIndex(scope, agent => renderIndex(deps, agent)),
        registerMemoryTools(scope, deps),
      ]
      runtime = () => {
        for (const dispose of disposers.reverse()) dispose()
      }
    })
  }

  /**
   * Remove the index and the tools.
   * @returns nothing.
   */
  const unmountRuntime = () => {
    runtime?.()
    runtime = null
  }

  /**
   * Apply the switch, persisting the choice first.
   * @param next - the requested state.
   * @returns nothing.
   * @throws when the choice cannot be persisted, leaving the runtime unchanged.
   */
  const setEnabled = (next) => {
    if (next === enabled) return
    writeEnabled(settings.memoryDir, next)
    enabled = next
    if (next) mountRuntime()
    else unmountRuntime()
  }

  /**
   * Resolve and remember one working directory's project.
   * @param agent - the agent whose directory needs a project.
   * @returns fulfillment once the lookup is settled.
   */
  const resolveForAgent = async (agent) => {
    const cwd = cwdOf(agent)
    if (cwd === undefined) return
    try {
      const workspace = workspaceOf(ctx, cwd)
      const project = await resolveProject(
        { ...registry, projectRootMarkers: settings.projectRootMarkers },
        { cwd, workspaceRoot: workspace?.root, workspaceId: workspace?.id },
      )
      if (project !== null) projectsByCwd.set(cwd, project)
    } catch (failure) {
      logger.warn(`dsh-memory: could not resolve the project for ${cwd}: ${String(failure?.message ?? failure)}`)
    }
  }

  return {
    /**
     * Register everything this plugin owns.
     * @returns nothing.
     */
    start() {
      deps.setEnabled = setEnabled
      deps.isEnabled = () => enabled
      const disposeCommands = registerMemoryCommands(ctx, deps)
      const disposeCreated = ctx.on('agent/created', ({ agent }) => {
        void resolveForAgent(agent)
        // A new session may be the first chance to render a stale view.
        void refreshViewsOnMount(deps)
      })
      const disposeDisposed = ctx.on('agent/disposed', () => {
        // The cache is keyed by directory and bounded by how many directories one
        // process ever works in, so it is left to outlive individual agents.
      })
      ctx.effect(() => () => {
        disposeDisposed()
        disposeCreated()
        disposeCommands()
      }, 'dsh-memory.registrations')

      if (enabled) mountRuntime()
      void refreshViewsOnMount(deps)
    },

    /**
     * Release everything this plugin owns.
     * @returns nothing.
     */
    dispose() {
      unmountRuntime()
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
 * A failure here must never break a model request, so it degrades to an empty
 * index and a warning rather than propagating.
 * @param deps - resolved settings and layouts.
 * @param agent - the agent whose request is being assembled.
 * @returns the index text, or an empty string.
 */
function renderIndex(deps, agent) {
  try {
    const project = deps.projectFor(agent)
    return renderMemoryIndex(
      {
        user: readStore(deps.scopes.user.storePath).records,
        project: project === null ? [] : readStore(deps.scopes.project(project.project_id).storePath).records,
      },
      { budgetBytes: deps.config.indexBudgetBytes, split: deps.config.indexBudgetSplit },
    )
  } catch (failure) {
    deps.logger?.warn(`dsh-memory: could not render the Memory index: ${String(failure?.message ?? failure)}`)
    return ''
  }
}

/**
 * Regenerate every scope's generated view and sweep stale temporary files.
 *
 * Views are derived, so a failure here is reported and ignored: the canonical
 * store is already durable.
 * @param deps - resolved settings and layouts.
 * @returns fulfillment once the refresh is settled.
 */
async function refreshViewsOnMount(deps) {
  const { lockTimeoutMs, staleLockMs, logger } = deps.config
  try {
    cleanupStaleTemps(deps.config.memoryDir)
  } catch (failure) {
    logger?.warn(`dsh-memory: could not sweep temporary files: ${String(failure?.message ?? failure)}`)
  }
  const layouts = [deps.scopes.user]
  try {
    for (const entry of readRegistry(deps.registry.registryPath).projects) {
      layouts.push(deps.scopes.project(entry.project_id))
    }
  } catch (failure) {
    logger?.warn(`dsh-memory: could not read the project registry: ${String(failure?.message ?? failure)}`)
  }
  for (const layout of layouts) {
    try {
      await rebuildView({ ...layout, lockTimeoutMs, staleLockMs, logger })
    } catch (failure) {
      logger?.warn(`dsh-memory: memory-view-stale: ${layout.viewPath}: ${String(failure?.message ?? failure)}`)
    }
  }
}

/**
 * The working directory of one agent.
 * @param agent - the agent to describe.
 * @returns its absolute working directory, or undefined.
 */
function cwdOf(agent) {
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
function workspaceOf(ctx, cwd) {
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
    if (root === undefined) continue
    if (cwd !== root && !cwd.startsWith(`${root}/`)) continue
    if (best === undefined || root.length > best.root.length) best = { root, id: workspace.id }
  }
  return best
}
