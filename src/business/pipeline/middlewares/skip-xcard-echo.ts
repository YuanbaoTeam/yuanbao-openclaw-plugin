/**
 * Middleware: drop IM messages that echo an xCard button's `userMessage`.
 *
 * A clicked Button can carry `action.event.userMessage`; the client may also post that text to
 * the conversation as the user's own chat message. The click already reached the agent as an
 * xcard_event (waiter or wake turn), so the echo would start a duplicate turn. Matching is
 * exact on (account, conversation, operator, trimmed text) within USER_MESSAGE_ECHO_TTL_MS, and each
 * recorded click suppresses at most one message.
 */

import { consumeUserMessageEcho } from "../../xcard/registry.js";
import type { MiddlewareDescriptor } from "../types.js";

export const skipXCardEcho: MiddlewareDescriptor = {
  name: "skip-xcard-echo",
  handler: async (ctx, next) => {
    const conversationId = ctx.isGroup ? ctx.groupCode : ctx.fromAccount;
    if (conversationId && ctx.rawBody.trim()
      && consumeUserMessageEcho(
        ctx.account.accountId,
        ctx.isGroup,
        conversationId,
        ctx.fromAccount,
        ctx.rawBody,
      )) {
      ctx.log.info("[skip-xcard-echo] userMessage echo of a card click, skipping", {
        fromAccount: ctx.fromAccount,
        groupCode: ctx.groupCode,
      });
      return;
    }
    await next();
  },
};
