/**
 * Text message sending.
 *
 * Extracted from create-sender:
 * - Parses @mentions, Markdown image references, etc.
 * - Builds MsgBody and delivers via deliver()
 */

import { getMember } from "../../../infra/cache/member.js";
import type { YuanbaoMsgBodyElement } from "../../../types.js";
import { prepareOutboundContent, buildOutboundMsgBody } from "../../messaging/handlers/index.js";
import type { SendResult } from "../../outbound/types.js";
import { deliver, type DeliverTarget } from "../deliver.js";

export interface SendTextParams {
  text: string;
  dt: DeliverTarget;
}

/**
 * Send text message.
 * Prepares content (parses @mentions, Markdown image refs), builds MsgBody, and delivers.
 */
export async function sendText(params: SendTextParams): Promise<SendResult> {
  const { text, dt } = params;

  if (!text.trim()) {
    return { ok: true };
  }

  const { isGroup, target, account } = dt;
  const groupCode = isGroup ? target : undefined;
  const memberInst = isGroup ? getMember(account.accountId) : undefined;

  // Preheat group member cache so @mention resolution can resolve nicknames to user IDs.
  // Why: outbound @ element (TIMCustomElem elem_type=1002) is built synchronously by
  // prepareOutboundContent below, which relies on GroupMember.cache being populated.
  // In cron/announce (isolated session) paths no inbound middleware runs, so the cache
  // is cold and every @ would be silently dropped. Hot cache (5min TTL) makes this a no-op.
  // WS not connected → queryMembers returns [] without throwing.
  if (isGroup && memberInst && groupCode && text.includes("@")) {
    await memberInst.queryMembers(groupCode);
  }

  const items = prepareOutboundContent(text, groupCode, memberInst);
  const msgBody = buildOutboundMsgBody(items) as YuanbaoMsgBodyElement[];

  return deliver(dt, msgBody);
}
