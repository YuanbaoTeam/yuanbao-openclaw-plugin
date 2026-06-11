/**
 * Middleware: extract text, media, and @mentions from raw MsgBody into PipelineContext.
 */

import { extractTextFromMsgBody } from "../../messaging/extract.js";
import type { MiddlewareDescriptor } from "../types.js";

export const extractContent: MiddlewareDescriptor = {
  name: "extract-content",
  handler: async (ctx, next) => {
    const { raw, isGroup } = ctx;

    ctx.fromAccount = raw.from_account?.trim() || "unknown";
    ctx.senderNickname = raw.sender_nickname?.trim() || undefined;

    if (isGroup) {
      ctx.groupCode = raw.group_code?.trim() || "unknown";
    } else if (raw.private_from_group_code) {
      // Direct message opened from group chat panel; carry group_code
      ctx.groupCode = raw.private_from_group_code;
    }

    // Build minimal ctx compatible with extractTextFromMsgBody's MessageHandlerContext.
    // Pass the real logger through so element-level diagnostics are not swallowed.
    const minCtx = {
      account: ctx.account,
      config: ctx.config,
      core: ctx.core,
      log: {
        info: ctx.log.info.bind(ctx.log),
        warn: ctx.log.warn.bind(ctx.log),
        error: ctx.log.error.bind(ctx.log),
        verbose: ctx.log.debug.bind(ctx.log),
      },
      wsClient: ctx.wsClient,
      groupCode: ctx.groupCode,
      fromAccount: ctx.fromAccount,
      senderNickname: ctx.senderNickname,
    };

    const { rawBody, isAtBot, medias, mentions, linkUrls } = extractTextFromMsgBody(
      minCtx,
      raw.msg_body,
    );

    ctx.rawBody = rawBody;
    ctx.isAtBot = isAtBot;
    ctx.medias = medias;
    ctx.mentions = mentions ?? [];
    ctx.linkUrls = linkUrls ?? [];

    ctx.log.info("[extract-content] received message", {
      isGroup,
      from: ctx.fromAccount,
      nickname: ctx.senderNickname,
      groupCode: ctx.groupCode,
      msgSeq: raw.msg_seq,
      msgKey: raw.msg_key,
      isAtBot,
    });

    await next();
  },
};
