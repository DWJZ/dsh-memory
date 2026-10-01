/**
 * Secret detection for Memory writes.
 *
 * A raw secret never reaches persisted Memory, and there is no override: a user
 * who asks the harness to remember an API key gets a refusal, not a stored key.
 * Only a locator that is itself not a secret may be stored.
 *
 * The guarantee covers what this plugin owns — the canonical store, the view, the
 * tombstone log, the logger, and tool results. It cannot cover a trajectory that
 * another subsystem already recorded.
 *
 * @module dsh-reflection/redact
 */

/** Placeholder substituted for a detected secret in anything this plugin logs. */
export const REDACTED = '[redacted]'

/** One detection rule: a name for the reason, and the pattern it matches. */
const RULES = Object.freeze([
  { name: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{16,}/gu },
  { name: 'bearer-token', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/giu },
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/gu },
  { name: 'assigned-credential', pattern: /\b(?:password|passwd|api[_-]?key|access[_-]?key|secret|token)\s*[:=]\s*["']?[^\s"',;]{6,}/giu },
  { name: 'aws-access-key-id', pattern: /\bAKIA[0-9A-Z]{16}\b/gu },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/gu },
  { name: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/gu },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/gu },
])

/** Shortest run treated as a possible high-entropy credential. */
const ENTROPY_MIN_LENGTH = 40

/**
 * Find the first secret this text contains.
 * @param text - the text to inspect.
 * @returns the matching rule's name, or undefined when the text is clean.
 */
export function findSecret(text: string) {
  if (typeof text !== 'string' || text === '') return undefined
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0
    if (rule.pattern.test(text)) return rule.name
  }
  return looksLikeHighEntropyBlob(text) ? 'high-entropy-blob' : undefined
}

/**
 * Find the first secret anywhere in a set of texts.
 *
 * Callers pass every text that will be persisted, not only the headline content:
 * a quote attached as provenance is just as durable as the fact it supports.
 * @param texts - the texts to inspect.
 * @returns the offending field index and rule name, or undefined when all are clean.
 */
export function findSecretIn(texts: unknown) {
  const list = Array.isArray(texts) ? texts : [texts]
  for (const [index, text] of list.entries()) {
    const name = findSecret(text)
    if (name !== undefined) return { index, name }
  }
  return undefined
}

/**
 * Replace every detected secret with a placeholder.
 * @param text - the text to sanitize.
 * @returns text safe to log.
 */
export function redactText(text: string) {
  if (typeof text !== 'string' || text === '') return text ?? ''
  let result = text
  for (const rule of RULES) {
    rule.pattern.lastIndex = 0
    result = result.replace(rule.pattern, REDACTED)
  }
  return result
}

/**
 * Whether one token looks like a credential by shape rather than by prefix.
 *
 * A long mixed-case run containing letters and digits is not prose. Requiring
 * both cases and a digit keeps ordinary material — a lowercase hex commit hash, a
 * URL, a long identifier — from being refused.
 * @param text - the text to inspect.
 * @returns true when some token looks like a high-entropy blob.
 */
function looksLikeHighEntropyBlob(text: string) {
  for (const token of text.split(/[\s"'`,;()[\]{}<>]+/u)) {
    if (token.length < ENTROPY_MIN_LENGTH) continue
    if (!/^[A-Za-z0-9+/=_-]+$/u.test(token)) continue
    if (!/[0-9]/u.test(token) || !/[a-z]/u.test(token) || !/[A-Z]/u.test(token)) continue
    return true
  }
  return false
}
