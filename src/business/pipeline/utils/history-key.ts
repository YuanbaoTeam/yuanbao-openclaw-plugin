/**
 * Chat history keying helper.
 *
 * Group history / media LRU / pending-history all key off the same string, so
 * this helper is the single source of truth: when the message belongs to a
 * topic, the key gets a `:topic:<topicId>` suffix so topic contexts stay
 * isolated from the surrounding group chatter.
 *
 * Keeping keys derived from one function (instead of ad-hoc string
 * concatenation in three middlewares) avoids the "record uses one shape, read
 * uses another" drift that would silently break history retrieval.
 */

/**
 * Derive the history key used for chat history / media LRU lookups.
 *
 * - `undefined` topicId → plain `groupCode` (legacy group history, unchanged).
 * - defined topicId     → `${groupCode}:topic:${topicId}` (topic-scoped bucket).
 *
 * We do not validate topicId here — parse-topic-meta already guards against
 * malformed cloud_custom_data, so anything reaching this helper is trusted.
 */
export function deriveHistoryKey(groupCode: string, topicId?: string): string {
  if (topicId) {
    return `${groupCode}:topic:${topicId}`;
  }
  return groupCode;
}
