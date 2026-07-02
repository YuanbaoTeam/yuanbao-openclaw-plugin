/**
 * Middleware: create MessageSender and inject into ctx.
 */

import { createMessageSender } from "../../outbound/create-sender.js";
import type { MiddlewareDescriptor } from "../types.js";

export const prepareSender: MiddlewareDescriptor = {
  name: "prepare-sender",
  handler: async (ctx, next) => {
    const { account, isGroup, fromAccount, groupCode, raw, wsClient, config, core } = ctx;

    // ⭐ Create MessageSender and inject into ctx.sender
    const target = isGroup ? groupCode! : fromAccount;
    const refMsgId = isGroup ? raw.msg_id || raw.msg_key : undefined;

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
    });

    ctx.log.debug(`[prepare-sender] sender created`);

    await next();
  },
};
