/**
 * The harness surface this plugin uses, declared here rather than imported.
 *
 * The harness publishes types with its packages, but the versions on npm lag the
 * harness this plugin runs against (`@deepseek-ai/dsh-agent` publishes 0.1.0-rc.6
 * while the running harness is 0.2.0-rc.2), and this plugin is not a pnpm
 * workspace member, so it cannot resolve them from a checkout either. Typing
 * against a stale package would describe an API the plugin does not run on,
 * which is worse than no types at all.
 *
 * So only the members this plugin actually calls are declared, with the shapes it
 * relies on. They are hand-written: when the harness changes one of these
 * members, nothing fails here until `npm run typecheck` is read. `@deepseek-ai/cordis`
 * itself is a real devDependency at the version this checkout vendors, so the
 * plugin shape, `Context` identity and event plumbing come from the official
 * package; this file only adds what the harness layers on top.
 */

/** The Session members this plugin reads and writes. */
interface MemorySession {
  readonly id: string
  readonly header?: { readonly cwd?: string } | undefined
  /**
   * Append one Session event. The plugin writes types the harness does not know,
   * which is why the payload is unconstrained and `ignorable` must be set.
   */
  append(type: string, data: unknown, options?: { readonly ignorable?: boolean }): unknown
}

/** The Agent members this plugin drives. */
interface MemoryAgent {
  /** The agent's current status; the idle trigger compares it with 'idle'. */
  readonly status?: string | undefined
  readonly session: MemorySession
  /**
   * Run work inside the agent's maintenance phase. Rejects when a turn or another
   * maintenance task already owns the agent.
   */
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

/** One tool category name, as the tool catalogue spells it. */
type MemoryCategory = 'state' | 'preference' | 'decision' | 'lesson' | 'reference' | 'feedback'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Subscribe to one of the events this plugin observes. The overridden
     * signatures name the payloads it reads; the last one keeps other event names
     * available without pretending to know their arguments.
     */
    on(event: 'session/event', listener: (session: MemorySession, event: ObservedEvent) => void): () => void
    on(event: 'agent/status', listener: (payload: { agent: MemoryAgent; status: string }) => void): () => void
    on(event: string, listener: (...args: never[]) => unknown): () => void

    /**
     * Run a callback once every named service is available, in a child fiber the
     * returned handle owns. Disposing it removes everything the callback registered.
     */
    inject(deps: string[], callback: (scope: Context) => unknown): { dispose(): Promise<void> }

    /**
     * Register a disposable contribution. Returns the disposer, and the runtime
     * also runs it when the owning fiber is disposed.
     */
    effect(callback: () => void | (() => void), label?: string): () => void

    /** The tool catalogue this plugin registers `memory_get` and friends into. */
    tools: {
      register(definition: {
        name: string
        description: string
        parameters: unknown
        execute(...args: never[]): unknown
      }): () => void
    }

    /** The prompt layers this plugin contributes the index and policy to. */
    systemPrompt: {
      context(entry: { name: string; order: number; text: string | ((context: unknown) => string) }): () => void
      section(entry: { name: string; order: number; text: string }): () => void
    }

    /** The model runtime the consolidator asks for a plan. */
    llm: {
      stream(options: {
        provider?: string
        model?: string
        messages: unknown[]
        system?: string
        maxTokens?: number
        sessionId?: string
        signal?: AbortSignal
      }): AsyncIterable<{ type: string; text?: string; reason?: { kind: string; failure?: { code?: string; message?: string } } }>
    }

    /** The command surface `/memory` registers into. */
    commands: {
      register(definition: { name: string; description?: string; inputHint?: string; handler(invocation: unknown): unknown }): () => void
      /** Present when the harness mounted a command registry; the plugin guards it. */
      run?: (agent: MemoryAgent, text: string) => Promise<unknown>
    }

    /** Diagnostic sink. The harness spells the levels this way. */
    logger: {
      info(message: string): void
      warn(message: string | Error, ...rest: unknown[]): void
      debug(message: string): void
    }
  }
}
