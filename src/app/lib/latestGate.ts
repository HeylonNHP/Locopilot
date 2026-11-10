/**
 * "Latest wins" ordering for work that can finish out of order.
 *
 * Every navigation the user makes — opening a conversation, starting a new
 * chat — takes a token from the gate when it starts and checks it again when
 * its asynchronous part (a fetch, a server call) comes back. If the user has
 * navigated again in the meantime the token is stale and the late result is
 * dropped, so the LAST click always decides what is on screen.
 *
 * Opening a conversation used to be the only navigation that took part:
 * clicking "+ New chat" while a conversation was still loading let the late
 * load finish afterwards and take the view back, so the next message was
 * typed into the conversation the user had just left.
 *
 * It is a plain object rather than a ref in the hook so the ordering rule can
 * be tested directly (scripts/test-latest-gate.mjs).
 */
export interface LatestGate {
  /** Start a piece of work. Every earlier piece of work becomes stale. */
  begin(): number;
  /** Whether `token` is still the most recently started piece of work. */
  isLatest(token: number): boolean;
}

export function createLatestGate(): LatestGate {
  let latest = 0;
  return {
    begin(): number {
      latest += 1;
      return latest;
    },
    isLatest(token: number): boolean {
      return token === latest;
    },
  };
}
