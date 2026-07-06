/**
 * Middleware: create MessageSender and inject into ctx.
 *
 * When the inbound message came from a topic (`ctx.topicId` set by
 * resolve-mention), the sender is pre-configured with a `cloud_custom_data`
 * JSON string carrying the topicId. Every outbound reply from this sender
 * then echoes topicId back to the IM server, so the front-end can attribute
 * the Bot reply to the originating topic without heuristic matching.
 *
 * Non-topic messages leave cloudCustomData undefined, preserving legacy behavior.
 */

/**
 * Middleware: create MessageSender and inject into ctx.
 *
 * When the inbound message came from a topic (`ctx.topicId` set by
 * resolve-mention), the sender is pre-configured with a `cloud_custom_data`
 * JSON string carrying the topicId. Every outbound reply from this sender
 * then echoes topicId back to the IM server, so the front-end can attribute
 * the Bot reply to the originating topic without heuristic matching.
 *
 * [DEMO] 目前处于 DEMO 阶段：为了让"bot 回复归属话题"链路能端到端跑通，
 * 即便入站没有 topicId，也会 fallback 到 `DEMO_FALLBACK_TOPIC_ID`，
 * 让所有 bot 回复都带上一个固定 topicId。上线前需删掉此常量与 fallback 分支，
 * 恢复"只在 ctx.topicId 存在时才写 cloud_custom_data"的语义。
 */

import { createMessageSender } from "../../outbound/create-sender.js";
import type { MiddlewareDescriptor } from "../types.js";

// [DEMO] 硬编码兜底 topicId：入站消息没有携带 cloud_custom_data.topicId 时，
// 出站也强制带上此值，方便前端跑通"bot 回复归属话题"闭环。上线前需删掉此常量。
const DEMO_FALLBACK_TOPIC_ID = "demo-topic-1";

export const prepareSender: MiddlewareDescriptor = {
  name: "prepare-sender",
  handler: async (ctx, next) => {
    const { account, isGroup, fromAccount, groupCode, raw, wsClient, config, core, topicId } = ctx;

    // ⭐ Create MessageSender and inject into ctx.sender
    const target = isGroup ? groupCode! : fromAccount;
    const refMsgId = isGroup ? raw.msg_id || raw.msg_key : undefined;

    // Build outbound cloud_custom_data JSON so Bot replies carry topicId back.
    // [DEMO] 入站没有 topicId 时也回落到 DEMO_FALLBACK_TOPIC_ID，保证 bot 回复必带 topicId。
    const effectiveTopicId = topicId || DEMO_FALLBACK_TOPIC_ID;
    const cloudCustomData = JSON.stringify({ topicId: effectiveTopicId });

    ctx.sender = createMessageSender({
      isGroup,
      account,
      target,
      fromAccount: account.botId || fromAccount,
      refMsgId,
      refFromAccount: isGroup ? fromAccount : undefined,
      wsClient,
      config,
      core,
      traceContext: ctx.traceContext,
      cloudCustomData,
      // Forward pipeline logger down to transport so `[group] outbound frame`
      // logs land in the same gateway.log sink as pipeline events.
      log: ctx.log,
    });

    // [DEBUG] 升级为 info：便于在 gateway.log 里直接观察出站 payload 的 topicId
    // 走向（真值 vs DEMO fallback）。上线前和上面 DEMO_FALLBACK_TOPIC_ID 一起清理。
    ctx.log.info(
      `[prepare-sender] sender created, topicId=${effectiveTopicId}`
      + (topicId ? "" : " (DEMO fallback)")
      + ` cloudCustomData=${cloudCustomData}`,
    );

    await next();
  },
};
