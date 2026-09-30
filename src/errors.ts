/**
 * Reading a caught value without trusting it.
 *
 * `catch` hands over an `unknown`, and these two readers narrow it the way this
 * plugin's diagnostics always did: an `Error` contributes its `message`, a plain
 * object its own `message` or `code` when it carries one, and anything else its
 * string form. Writing the narrowing once keeps a warning's text from depending on
 * where the catch happens to sit.
 *
 * @module dsh-memory/errors
 */

/**
 * Describe a caught value for a log line.
 * @param failure - whatever was caught.
 * @returns the message it carries, or its string form.
 */
export function failureMessage(failure: unknown): string {
  if (failure instanceof Error) return failure.message
  if (typeof failure === 'object' && failure !== null && 'message' in failure) {
    return String((failure as { message: unknown }).message)
  }
  return String(failure)
}

/**
 * Read the error code a caught value carries, when it carries one.
 * @param failure - whatever was caught.
 * @returns the code, or undefined when there is none.
 */
export function failureCode(failure: unknown): string | undefined {
  if (typeof failure !== 'object' || failure === null || !('code' in failure)) return undefined
  const code = (failure as { code: unknown }).code
  return code === undefined || code === null ? undefined : String(code)
}
