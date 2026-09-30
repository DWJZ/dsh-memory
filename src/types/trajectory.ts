/**
 * What the collector observes and what the model is shown.
 *
 * Two shapes travel through Phase 2: the events this process saw, and the bounded
 * entries built from them. Keeping them apart matters — an entry has already been
 * classified, capped and rendered for a model, while an event is whatever the
 * Session appended and may be a type this build knows nothing about.
 *
 * @module dsh-memory/trajectory
 */

/**
 * One Session event as this plugin observes it.
 *
 * `type` is a plain string rather than a closed union on purpose: the plugin reads
 * events it does not know, and the classification it applies is what decides
 * whether one reaches a model.
 */
export interface ObservedEvent {
  /** The event's sequence number within its Session. */
  seq: number
  /** The event type, as the Session recorded it. */
  type: string
  /** The event payload, unread until the type says what to expect. */
  data?: unknown
  /**
   * The envelope's marker for a type a reader may not know. This plugin writes its
   * own rows with it, which is why a build that lacks the type still accepts them.
   */
  ignorable?: boolean | undefined
}

/** One entry of the bounded window a model is asked about. */
export interface TrajectoryEntry {
  /** The sequence number this entry came from. */
  seq: number
  /** The event type it was built from. */
  type: string
  /** Message text, for message events. */
  content?: string | undefined
  /** The role, for message events. */
  role?: string | undefined
  /** The tool name, for tool calls and results. */
  tool?: string | undefined
  /** The tool arguments, for tool calls; the field a byte ceiling shortens. */
  arguments?: string | undefined
}

/** How a window is bounded, as the batch builder takes it. */
export interface WindowOptions {
  /** The last sequence number already consumed; the window starts after it. */
  afterSeq: number
  /** Largest serialized entry, in UTF-8 bytes. */
  maxBytes?: number | undefined
}
