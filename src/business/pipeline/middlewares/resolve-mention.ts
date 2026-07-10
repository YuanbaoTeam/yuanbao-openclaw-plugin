/**
 * Middleware: @mention detection guard (group chat).
 *
 * Uses SDK resolveMentionGatingWithBypass with command bypass support.
 * Non-@bot messages are recorded to group history then pipeline is aborted.
 */

import {
  resolveMentionGatingWithBypass,
  logInboundDrop,
} from "openclaw/plugin-sdk/channel-inbound";
import { recordPendingHistoryEntryIfEnabled } from "openclaw/plugin-sdk/reply-history";
import { chatHistories, deriveChatKey, recordMediaHistory } from "../../messaging/chat-history.js";
import type { MiddlewareDescriptor } from "../types.js";

// resolveInboundMentionDecision 在部分宿主版本（如 2026.5.7）的 channel-inbound 运行时未真正导出，
// 采用动态探测 + 回退到 resolveMentionGatingWithBypass（与 remind.ts 同模式），不抬高 minHostVersion。
type InboundMentionDecisionFn = (params: {
  facts: { canDetectMention: boolean; wasMentioned: boolean; hasAnyMention?: boolean };
  policy: {
    isGroup: boolean;
    requireMention: boolean;
    allowTextCommands: boolean;
    hasControlCommand: boolean;
    commandAuthorized: boolean;
  };
}) => { effectiveWasMentioned: boolean; shouldSkip: boolean };

let _resolveInboundMentionDecision: InboundMentionDecisionFn | null | undefined;
async function resolveInboundMentionDecisionSafe(params: Parameters<InboundMentionDecisionFn>[0]): Promise<ReturnType<InboundMentionDecisionFn> | null> {
  if (_resolveInboundMentionDecision === undefined) {
    try {
      const mod = await import("openclaw/plugin-sdk/channel-inbound");
      _resolveInboundMentionDecision = typeof (mod as Record<string, unknown>).resolveInboundMentionDecision === "function"
        ? ((mod as Record<string, unknown>).resolveInboundMentionDecision as InboundMentionDecisionFn)
        : null;
    } catch {
      _resolveInboundMentionDecision = null;
    }
  }
  return _resolveInboundMentionDecision ? _resolveInboundMentionDecision(params) : null;
}

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

    const newDecision = await resolveInboundMentionDecisionSafe({
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

    const result = newDecision ?? resolveMentionGatingWithBypass({
      isGroup,
      requireMention,
      canDetectMention: true,
      wasMentioned: isAtBot,
      allowTextCommands,
      hasControlCommand,
      commandAuthorized,
    });

    ctx.effectiveWasMentioned = result.effectiveWasMentioned;

    if (result.shouldSkip) {
      const { historyLimit } = account;

      // Record non-@bot message to group history context
      if (historyLimit > 0) {
        recordPendingHistoryEntryIfEnabled({
          historyMap: chatHistories,
          historyKey: ctx.groupCode!,
          limit: historyLimit,
          entry: {
            sender: ctx.fromAccount,
            body: `${ctx.fromAccount}: ${ctx.rawBody}`,
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
