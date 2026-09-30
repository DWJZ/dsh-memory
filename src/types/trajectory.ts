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
  /**
   * The event payload. Required: the events this plugin folds always carry one, and
   * reading it is how an entry is built.
   */
  data: EventPayload
  /**
   * The envelope's marker for a type a reader may not know. This plugin writes its
   * own rows with it, which is why a build that lacks the type still accepts them.
   */
  ignorable?: boolean | undefined
}

/**
 * The payload fields this plugin reads from a Session event.
 *
 * A Session event may carry anything; these are the places this plugin looks, and
 * the index signature keeps the rest available to code that knows more.
 */
export interface EventPayload {
  /** Where a message came from, on the harness's user messages. */
  source?: { kind?: string } | undefined
  /** Message content blocks, for message events. */
  content?: unknown
  /** The message some events wrap. */
  message?: { content?: unknown } | undefined
  /** Anything else the event carries. */
  [key: string]: unknown
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
  /**
   * The entry is also indexable: a byte ceiling shrinks whichever field carries the
   * unbounded text, and which one that is depends on the event it was built from.
   */
  [key: string]: unknown
}

/** How a window is bounded, as the batch builder takes it. */
export interface WindowOptions {
  /** The last sequence number already consumed; the window starts after it. */
  afterSeq: number
  /** Largest serialized entry, in UTF-8 bytes. */
  maxBytes?: number | undefined
  /** Largest number of events to consider. */
  maxEvents?: number | undefined
}
