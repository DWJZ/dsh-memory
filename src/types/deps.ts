/**
 * The wiring the plugin hands its command surface.
 *
 * Built once in `index.ts` and passed to every command, so this is the shape the
 * command module receives rather than one it defines — which is why it lives here
 * and not beside the commands that read it.
 *
 * @module dsh-reflection/types/deps
 */

import type { MemorySettings } from './config.js'
import type { ProjectEntry } from './identity.js'
import type { ActionOptions, EvidenceEntry, Provenance } from './memory.js'
import type { RunAudit } from '../consolidation/index.js'

/** What one command invocation carries. */
export interface CommandInvocation {
  /** The agent the command was typed into. */
  agent: MemoryAgent
  /** The arguments after the command name, as typed. */
  rawInput: string
}

/** The wiring every command receives. */
export interface MemoryDeps {
  /** Resolved settings, including the Memory root and the switches. */
  config: MemorySettings
  /** The two scope layouts, resolved per project id. */
  scopes: ActionOptions['scopes']
  /** The tombstone ledger and its lock. */
  tombstones: ActionOptions['tombstones']
  /** The registry file, its directory and its lock, as `registryLayout` resolves them. */
  registry: { dir: string; registryPath: string; lockPath: string }
  /** Diagnostic sink. */
  logger: { warn(message: string | Error): void; info?(message: string): void }
  /** The project a Session's directory belongs to, or null when none is known. */
  projectFor(agent: MemoryAgent): ProjectEntry | null
  /** Refresh that lookup for one agent, after the directory it runs in changes. */
  resolveProjectFor(agent: MemoryAgent): Promise<void>
  /** Whether the runtime switch is on. */
  isEnabled(): boolean
  /** Flip the runtime switch, persisting it and settling any run in flight. */
  setEnabled(next: boolean): Promise<void>
  /** Whether automatic learning is on (both switches considered). */
  consolidationEnabled(): boolean
  /** Injectable clock in epoch milliseconds. */
  now?(): number
  /** The citation for the turn in flight, when the Session has one to cite. */
  evidenceFor(agent: MemoryAgent): Provenance
  /** Run one consolidation for an agent, as `/memory consolidate` does. */
  consolidate(agent: MemoryAgent, runOptions?: { dryRun?: boolean; trigger?: string; signal?: AbortSignal | undefined }): Promise<RunAudit>
}
