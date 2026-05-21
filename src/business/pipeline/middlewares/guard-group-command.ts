/**
 * Middleware: group command whitelist guard.
 *
 * Only applies to registered openclaw commands; non-public commands are owner-only.
 * Unregistered /xxx messages (e.g. /asdasdasd) are treated as plain text for AI.
 */

import { getMember } from "../../../infra/cache/member.js";
import { sendGroupMsgBody } from "../../../infra/transport.js";
import type { YuanbaoMsgBodyElement } from "../../../types.js";
import { prepareOutboundContent, buildOutboundMsgBody } from "../../messaging/handlers/index.js";
import type { MiddlewareDescriptor } from "../types.js";

/** Commands allowed in group chat (owner-only) */
const GROUP_ALLOWED_COMMANDS = new Set<string>([
  "/new", "/reset", "/retry", "/undo", "/stop",
  "/approve", "/btw", "/queue",
]);

export const guardGroupCommand: MiddlewareDescriptor = {
  name: "guard-group-command",
  when: ctx => ctx.isGroup && ctx.hasControlCommand,
  handler: async (ctx, next) => {
    const { commandParts, raw, account, groupCode, fromAccount, isAtBot } = ctx;
    const cmd = commandParts?.[0]?.toLowerCase() ?? "";

    const ownerId = account.botOwnerId || raw.bot_owner_id;
    const isOwner = Boolean(ownerId && raw.from_account === ownerId);

    ctx.log.info('[guard-group-command] come in', { isOwner, cmd, isAtBot });

    if (isAtBot) {
      const allowed = GROUP_ALLOWED_COMMANDS.has(cmd);
      const rejected = !allowed || !isOwner;
      if (rejected) {
        const rejectReason = !allowed
          ? `⚠️ ${cmd} 暂不支持在群聊中使用，请在私聊中发送`
          : `⚠️ ${cmd} 仅限创建者使用哦~`;
        await sendGroupMsgBody({
          account,
          groupCode: groupCode!,
          msgBody: buildOutboundMsgBody(prepareOutboundContent(
            rejectReason,
            groupCode,
            getMember(account.accountId),
          )) as YuanbaoMsgBodyElement[],
          fromAccount: account.botId,
          refMsgId: raw.msg_id || raw.msg_key || undefined,
          refFromAccount: fromAccount,
          wsClient: ctx.wsClient,
        });
        return;
      }
    } else {
      ctx.hasControlCommand = false;
      ctx.commandParts = [];
    }

    await next();
  },
};
