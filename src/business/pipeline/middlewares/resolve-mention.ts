/**
 * Middleware: @mention detection guard (group chat).
 *
 * Uses SDK resolveInboundMentionDecision with command bypass support.
 * Non-@bot messages are recorded to group history then pipeline is aborted.
 */

import {
  resolveInboundMentionDecision,
  logInboundDrop,
} from "openclaw/plugin-sdk/channel-inbound";
import { recordPendingHistoryEntryIfEnabled } from "openclaw/plugin-sdk/reply-history";
import { chatHistories, deriveChatKey, recordMediaHistory } from "../../messaging/chat-history.js";
import type { MiddlewareDescriptor } from "../types.js";

export const resolveMention: MiddlewareDescriptor = {
  name: "resolve-mention",
  when: ctx => ctx.isGroup,
  handler: async (ctx, next) => {
    const { isGroup, account, isAtBot, hasControlCommand, commandAuthorized, core, config } = ctx;
    const { requireMention } = account;

    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg: config,
      surface: "yuanbao",
    });

    const result = resolveInboundMentionDecision({
      facts: {
        canDetectMention: true,
        wasMentioned: isAtBot,
      },
      policy: {
        isGroup,
        requireMention,
        allowTextCommands,
        hasControlCommand,
        commandAuthorized,
      },
    });

    ctx.effectiveWasMentioned = result.effectiveWasMentioned;

    if (result.shouldSkip) {
      const { historyLimit } = account;

      // Record non-@bot message to group history context. Prefix the body with
      // the sender's nickname (+ id) so the agent can tell members apart in the
      // shared group history — the SessionKey is intentionally shared, so we
      // surface "who said what" in the body text itself.
      if (historyLimit > 0) {
        const senderLabel = ctx.senderNickname
          ? `${ctx.senderNickname} (${ctx.fromAccount})`
          : ctx.fromAccount;
        recordPendingHistoryEntryIfEnabled({
          historyMap: chatHistories,
          historyKey: ctx.groupCode!,
          limit: historyLimit,
          entry: {
            sender: ctx.fromAccount,
            body: `${senderLabel}: ${ctx.rawBody}`,
            timestamp: Date.now(),
            messageId: ctx.raw.msg_id ?? String(ctx.raw.msg_seq ?? ""),
            medias: ctx.medias.length > 0 ? ctx.medias : undefined,
          },
        });
      }

      // Write media to dedicated LRU
      if (ctx.medias.length > 0) {
        recordMediaHistory(deriveChatKey(true, ctx.groupCode), {
          sender: ctx.fromAccount,
          messageId: ctx.raw.msg_id ?? String(ctx.raw.msg_seq ?? ""),
          timestamp: Date.now(),
          medias: ctx.medias,
        });
      }

      logInboundDrop({
        log: msg => ctx.log.info(msg),
        channel: "yuanbao",
        reason: "mention-gating",
        target: ctx.groupCode,
      });
      return; // Abort pipeline
    }

    await next();
  },
};
