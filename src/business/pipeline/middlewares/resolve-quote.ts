/**
 * Middleware: parse quote info and resolve media desc.
 *
 * Thin wrapper — all business logic lives in `messaging/quote.ts`.
 */

import { deriveChatKey } from "../../messaging/chat-history.js";
import { parseQuoteFromCloudCustomData } from "../../messaging/quote.js";
import type { MiddlewareDescriptor } from "../types.js";

export const resolveQuote: MiddlewareDescriptor = {
  name: "resolve-quote",
  handler: async (ctx, next) => {
    const chatKey = deriveChatKey(ctx.isGroup, ctx.groupCode, ctx.fromAccount);
    const quoteInfo = parseQuoteFromCloudCustomData(ctx.raw.cloud_custom_data, chatKey);

    if (quoteInfo) {
      ctx.quoteInfo = quoteInfo;
      ctx.log.info(`[resolve-quote] detected quote message, quoted from: ${quoteInfo.sender_nickname || quoteInfo.sender_id || "unknown"}`);
      ctx.log.debug("[resolve-quote] quote content", { quote: quoteInfo.desc || "" });
    }

    await next();
  },
};
