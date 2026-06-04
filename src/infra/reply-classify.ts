/**
 * Pure classification of the reply-quote decision (off / all / first).
 *
 * Extracted from transport.shouldAttachReplyRef so the off → self → all → first
 * ordering (the part most prone to cross-language drift) is a single source of
 * truth shared by the production sender and the cross-language contract test
 * (yuanbao-bot-spec POLICY-008). TTL bookkeeping for the "first" mode stays with
 * each caller: production uses InMemoryTtlDb (wall-clock), the contract test
 * models an injected clock.
 */

import type { YuanbaoReplyToMode } from "../types.js";

/** "no" = never attach; "yes" = attach now; "first" = attach iff not a duplicate. */
export type ReplyClassification = "no" | "yes" | "first";

export function classifyReplyMode(params: {
  mode: YuanbaoReplyToMode;
  refMsgId?: string | null;
  refFromAccount?: string | null;
  botYuanbaoUid?: string | null;
}): ReplyClassification {
  const { mode, refMsgId, refFromAccount, botYuanbaoUid } = params;
  if (!refMsgId) {
    return "no";
  }
  if (mode === "off") {
    return "no";
  }
  // Avoid self-quoting: the replied message was sent by the bot itself.
  if (refFromAccount && botYuanbaoUid && refFromAccount === botYuanbaoUid) {
    return "no";
  }
  if (mode === "all") {
    return "yes";
  }
  return "first";
}
