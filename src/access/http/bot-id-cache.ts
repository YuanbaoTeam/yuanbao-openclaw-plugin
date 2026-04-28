/**
 * Lightweight botId cache shared between the HTTP sign-token client and
 * account resolution.
 *
 * Kept in its own module (rather than inlined in `request.ts`) so that
 * `accounts.ts` — which is on the `openclaw setup` / `openclaw configure`
 * code path — can look up a previously-resolved botId without statically
 * pulling in the full HTTP/crypto/env runtime stack.
 */

const botIdCache = new Map<string, string>();

/** Read the last-known botId for an account, if any. */
export function getCachedBotId(accountId: string): string | undefined {
  const value = botIdCache.get(accountId);
  return value && value.length > 0 ? value : undefined;
}

/** Record a botId obtained during sign-token exchange. */
export function setCachedBotId(accountId: string, botId: string | undefined): void {
  if (!accountId || !botId) {
    return;
  }
  botIdCache.set(accountId, botId);
}

/** Clear the cached botId (e.g. when tearing down an account). */
export function clearCachedBotId(accountId: string): void {
  botIdCache.delete(accountId);
}
