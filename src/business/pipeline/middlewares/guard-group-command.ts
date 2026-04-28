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

/** Public commands available to all group members */
const GROUP_PUBLIC_COMMANDS = new Set<string>([]);

export const guardGroupCommand: MiddlewareDescriptor = {
  name: "guard-group-command",
  when: ctx => ctx.isGroup,
  handler: async (ctx, next) => {
    const { core, config, rawBody, raw, account, groupCode, fromAccount } = ctx;
    const q = rawBody.trim().split(/\s+/)
      .find(part => !part.trim().startsWith("@")) || rawBody;

    const hasRegisteredCommand = core.channel.text.hasControlCommand(q, config);
    const isOwner = Boolean(raw.bot_owner_id && raw.from_account === raw.bot_owner_id);
    const cmdMatch = q.trim().match(/^\/([a-z_-]+)/i);

    ctx.log.info('[guard-group-command] come in', { hasRegisteredCommand, isOwner, isCmd: !!cmdMatch });

    if (hasRegisteredCommand && cmdMatch) {
      const cmdName = cmdMatch[1].toLowerCase();

      if (!GROUP_PUBLIC_COMMANDS.has(cmdName) && !isOwner) {
        await sendGroupMsgBody({
          account,
          groupCode: groupCode!,
          msgBody: buildOutboundMsgBody(prepareOutboundContent(
            `⚠️ /${cmdName} 仅限创建者${!raw?.bot_owner_id ? "并且在私聊模式下" : ""}使用哦~`,
            groupCode,
            getMember(account.accountId),
          )) as YuanbaoMsgBodyElement[],
          fromAccount: account.botId,
          refMsgId: raw.msg_id || raw.msg_key || undefined,
          refFromAccount: fromAccount,
          wsClient: ctx.wsClient,
        });
        return; // Abort pipeline
      }
    }

    await next();
  },
};
