/**
 * Drives one compaction at the exact moment it becomes possible.
 *
 * Automatic compaction is triggered by token pressure, which needs a Session large
 * enough to cross the routed model's threshold. A one-shot harness has no such
 * history, and the alternative — a provider-side overflow — depends on the harness's
 * recovery path rather than on a supported entry point.
 *
 * So this fixture takes the entry point a person has: the `/compact` command, which
 * the base bundle documents as "one useful reduction below the automatic threshold".
 * It is invoked once the Session has events, as a maintenance task, so the harness
 * waits for it.
 *
 * A throw inside an event listener is contained by the harness and would otherwise be
 * invisible, so `DSH_MEMORY_COMPACT_LOG` records each step.
 */
import { appendFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name. */
export const name = 'dsh-reflection-compact-on-idle'

/** The command surface this fixture drives. */
export const inject = ['commands']

/**
 * Record one step of the driver, when a log path is configured.
 * @param step - what happened.
 */
function note(step: string): void {
  const log = process.env.DSH_MEMORY_COMPACT_LOG
  if (log === undefined) return
  try {
    appendFileSync(log, `${step}\n`)
  } catch {
    // Diagnostics are best effort; a missing log never changes the run.
  }
}

/**
 * Invoke `/compact` once, after the Session has produced events.
 * @param ctx - context carrying the command service.
 */
export function apply(ctx: Context): void {
  note('applied')
  const done = new Set<string>()
  ctx.on('agent/status', ({ agent, status }) => {
    note(`status:${status}:seq=${String(agent.session.seq)}`)
    note(`session:${String(agent.session.id)}`)
    if (status !== 'idle') return
    // A fresh agent reaches idle once before any task is submitted.
    if (agent.session.seq === 0) return
    const id = String(agent.session.id)
    if (done.has(id)) return
    done.add(id)
    const definition = ctx.commands.find(agent, 'compact')
    note(`find:${definition === undefined ? 'missing' : definition.name}`)
    note(`available:${ctx.commands.list(agent).map(command => command.name).join('|')}`)
    if (definition === undefined) return
    void Promise.resolve(definition.handler({
      rawInput: '',
      agent,
      // `/compact` reads this; a bare `{ rawInput, agent }` fails on `signal.aborted`.
      signal: new AbortController().signal,
    } as never))
      .then(result => { note(`handled:${String(result?.kind)}:${String(result?.text).slice(0, 200)}`) })
      .catch((error: unknown) => { note(`handler-failed:${String(error)}`) })
  })
}
