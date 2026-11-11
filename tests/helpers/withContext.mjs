/**
 * Runs `check` and, when it throws, puts `context` in front of the failure.
 *
 * Jest reports WHAT differed (expected and received) and WHERE, but not WHICH
 * case of a helper or a loop was running. Wrap the body of a shared assertion
 * helper, or of a loop that does not warrant `test.each`, to say so:
 *
 *   withContext(`at numCtx ${numCtx}`, () => {
 *     expect(allowance).toBe(expected);
 *   });
 *
 * @param {string} context - what was being checked, for the failure message.
 * @param {() => void} check - the assertions.
 */
export function withContext(context, check) {
  try {
    check();
  } catch (err) {
    if (err instanceof Error) {
      err.message = `${context}\n\n${err.message}`;
    }
    throw err;
  }
}
