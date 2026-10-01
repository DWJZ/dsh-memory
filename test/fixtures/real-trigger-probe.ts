/**
 * Drives a real session in a long-lived profile and reports what happened.
 *
 * The plugin's debounce waits outside the agent's maintenance phase, so a
 * one-shot run exits before it can expire. Observing the automatic path at all
 * therefore needs a process that stays alive: this probe is applied to the
 * shipped `web` profile, drives one turn, and then simply waits — no command, no
 * fixture, nothing that would consolidate on its own.
 *
 * It then switches Memory off and drives a second turn, so the same run can show
 * both that the automatic path works and that switching off stops it. Every step
 * is appended to the report file, because the web app's own logging is noisy and
 * a probe that fails silently teaches nothing.
 */
import { appendFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/cordis-plugin-loader'

/** Stable Cordis plugin name. */
export const name = 'dsh-reflection-real-trigger-probe'

/** Services this probe drives. */
export const inject = ['loader', 'agents', 'agentDefaultModel', 'sessions', 'fs', 'commands']

/** What the probe should do. */
export interface Config {
  /** First user message. */
  task?: string
  /** Second user message, sent after Memory is switched off. */
  secondTask?: string
  /** Where the step-by-step report is appended. */
  report?: string
  /** How long to wait for the debounce after the first turn. */
  automaticWaitMs?: number
  /** How long to wait after the second turn is idle. */
  disabledWaitMs?: number
}

/**
 * Drive one session and report each step.
 * @param ctx - context carrying the services.
 * @param config - task text, report path, and waits.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const report = config.report ?? '/tmp/dsh-reflection-probe.jsonl'
  const step = (name: string, extra: Record<string, unknown> = {}): void => {
    appendFileSync(report, `${JSON.stringify({ step: name, at: Date.now(), ...extra })}\n`)
  }
  const wait = (ms: number): Promise<void> => new Promise(resolve => { setTimeout(resolve, ms) })

  void (async () => {
    try {
      await ctx.get('loader')?.await()
      const agents = ctx.get('agents')
      const defaultModel = ctx.get('agentDefaultModel')
      const fs = ctx.get('fs')
      if (agents === undefined || defaultModel === undefined || fs === undefined) {
        step('missing-services')
        process.exit(2)
        return
      }
      const selection = defaultModel.currentSelection()
      const cwd = fs.processPath(await fs.resolve('.'))
      const sessionId = brandString(`session-probe-${randomUUID()}`)
      const agent = (await agents.create({
        sessionId,
        meta: { cwd },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx: Context) => {
          installModelSelection(agentCtx, { current: selection, assembled: undefined })
        },
      })).agent
      await agent.whenIdle()
      step('agent-ready', { cwd })

      agent.followup(createUserMessage({
        content: [{ type: 'text', text: config.task ?? '这个项目用 pnpm 管理依赖。' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      step('turn-done')

      // Nothing is invoked here: whatever consolidates in this window did so
      // because the plugin's own debounce expired.
      await wait(config.automaticWaitMs ?? 20000)
      step('automatic-window-elapsed')

      const memory = ctx.commands.find(agent, 'memory')
      if (memory === undefined) {
        step('command-missing')
        process.exit(3)
        return
      }
      const disabled = await memory.handler({ rawInput: 'disable', agent } as never)
      step('disabled', { kind: disabled?.kind, text: String(disabled?.text ?? '').slice(0, 160) })

      agent.followup(createUserMessage({
        content: [{ type: 'text', text: config.secondTask ?? '这个项目也用 pnpm workspace。' }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
      // An expired debounce here would prove the switch did not stop it.
      await wait(config.disabledWaitMs ?? 12000)
      step('disabled-window-elapsed')
      process.exit(0)
    } catch (failure) {
      step('failed', { message: String(failure instanceof Error ? failure.message : failure) })
      process.exit(1)
    }
  })()
}
