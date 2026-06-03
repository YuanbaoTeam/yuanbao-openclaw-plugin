/**
 * Middleware: owner guard for /upgrade, /issue-log and other special commands.
 */

import type { DeliverTarget } from "../../actions/deliver.js";
import { sendText } from "../../actions/text/send.js";
import { parseUpgradeCommand } from "../../commands/upgrade/index.js";
import { performUpgrade } from "../../commands/upgrade/upgrade.js";
import type { MiddlewareDescriptor, PipelineContext } from "../types.js";

/**
 * Check whether the message is from the bot owner.
 * Prefers account.botOwnerId (cached via QueryBotInfoReq) over per-message bot_owner_id.
 */
function isOwnerMessage(raw: PipelineContext["raw"], accountOwnerId?: string): boolean {
  const ownerId = accountOwnerId || raw.bot_owner_id;
  return Boolean(ownerId && raw.from_account === ownerId);
}

/**
 * Send a reply message via sendText action + deliver layer.
 */
async function sendReplyMessage(ctx: PipelineContext, text: string): Promise<void> {
  const { account, isGroup, fromAccount, groupCode, wsClient } = ctx;
  const dt: DeliverTarget = {
    isGroup,
    target: isGroup ? groupCode! : fromAccount,
    account,
    fromAccount: account.botId,
    wsClient,
    groupCode,
  };
  await sendText({ text, dt });
}

export const guardSpecialCommand: MiddlewareDescriptor = {
  name: "guard-special-command",
  handler: async (ctx, next) => {
    const { raw, rawBody, fromAccount, isGroup, groupCode } = ctx;
    const trimmedBody = rawBody.trim();

    // Upgrade command owner guard (supports /yuanbao-upgrade and /yuanbao-upgrade 1.2.3)
    const upgradeCmd = parseUpgradeCommand(trimmedBody);
    if (upgradeCmd.matched) {
      ctx.log.info(`[guard-special-command] received ${trimmedBody} command`);

      if (!isOwnerMessage(raw, ctx.account.botOwnerId)) {
        ctx.log.warn(`[guard-special-command] non-owner attempted ${trimmedBody}, rejected`, {
          fromAccount,
        });
        const rejectText = isGroup
          ? `派中暂不支持该命令，请 Bot 创建人在私聊发送 ${trimmedBody} 进行升级`
          : "⚠️ 您无权执行此操作，仅 Bot 创建人可以执行此操作。";
        await sendReplyMessage(ctx, rejectText);
        return; // Abort pipeline
      }

      // Owner check passed; send "upgrading" prompt
      ctx.log.info(`[guard-special-command] owner triggered upgrade command ${trimmedBody}`, {
        fromAccount,
      });

      // Execute upgrade here (middleware owns more context than the plugin command handler);
      // progress messages are streamed back via sendReplyMessage.
      const onProgress = async (text: string): Promise<void> => {
        try {
          await sendReplyMessage(ctx, text);
        } catch (err) {
          ctx.log.error("[guard-special-command] onProgress sendReplyMessage failed", {
            error: String(err),
          });
        }
      };

      try {
        const resultText = await performUpgrade(
          ctx.config,
          ctx.account.accountId,
          onProgress,
          upgradeCmd.version,
        );
        if (resultText) {
          await sendReplyMessage(ctx, resultText);
        }
      } catch (err) {
        ctx.log.error("[guard-special-command] performUpgrade threw", { error: String(err) });
        await sendReplyMessage(ctx, "❌ 升级过程发生异常，请稍后重试。");
      }
      return;
    }

    // /issue-log owner guard
    if (trimmedBody.startsWith("/issue-log")) {
      ctx.log.info("[guard-special-command] received /issue-log command");

      if (!isOwnerMessage(raw, ctx.account.botOwnerId)) {
        ctx.log.warn("[guard-special-command] non-owner attempted /issue-log, rejected", {
          fromAccount,
        });
        const rejectText = isGroup
          ? "群聊暂不支持该命令，请 bot owner 私聊发送 /issue-log 导出日志"
          : "⚠️ 您无权导出日志，请联系 Bot 创建人操作。";
        await sendReplyMessage(ctx, rejectText);
        return; // Abort pipeline
      }

      // Group chat: redirect to direct message
      if (isGroup) {
        ctx.log.info(
          "[guard-special-command] owner triggered /issue-log in group, redirecting to direct message",
          { fromAccount, groupCode },
        );
        await sendReplyMessage(
          ctx,
          "群聊暂不支持该命令，请 bot owner 私聊发送 /issue-log 导出日志",
        );
        return; // Abort pipeline
      }

      // C2C owner passed
      ctx.log.info("[guard-special-command] owner triggered log export command", { fromAccount });
      await sendReplyMessage(ctx, "📦 正在导出问题日志并压缩打包发送，请稍后...");
    }

    await next();
  },
};
