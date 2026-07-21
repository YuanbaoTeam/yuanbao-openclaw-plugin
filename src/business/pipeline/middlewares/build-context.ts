/**
 * Middleware: build FinalizedMsgContext using SDK finalizeInboundContext.
 * Also builds history context for group chat scenarios.
 */

import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
import { chatHistories } from "../../messaging/chat-history.js";
import { YUANBAO_MARKDOWN_HINT } from "../../messaging/context.js";
import type { MiddlewareDescriptor } from "../types.js";

export const buildContext: MiddlewareDescriptor = {
  name: "build-context",
  handler: async (ctx, next) => {
    const {
      core,
      account,
      isGroup,
      fromAccount,
      senderNickname,
      groupCode,
      rewrittenBody,
      commandParts,
      mediaPaths,
      mediaTypes,
      commandAuthorized,
      route,
      storePath,
      envelopeOptions,
      previousTimestamp,
      raw,
    } = ctx;

    if (!route || !storePath || !envelopeOptions) {
      ctx.log.error("[build-context] prerequisite middleware not ready");
      return;
    }
    const label = isGroup ? `group:${groupCode}` : `direct:${fromAccount}`;

    // Group chat: attribute the current @bot message to its sender in the body,
    // so the agent can tell who is asking inside the shared group session. The
    // shared SessionKey intentionally does not isolate members, so we surface
    // the sender (nickname + id) in the body text itself rather than via a
    // per-member session split.
    const senderLabel = isGroup
      ? (senderNickname ? `${senderNickname} (${fromAccount})` : fromAccount)
      : undefined;
    const attributedBody = isGroup && senderLabel
      ? `${senderLabel}: ${rewrittenBody}`
      : rewrittenBody;

    // Format envelope — always include timestamp (prefer protocol-level msg_time for accuracy)
    const msgTimestamp = raw.msg_time ? new Date(raw.msg_time * 1000) : new Date();
    const body = core.channel.reply.formatAgentEnvelope({
      channel: "YUANBAO",
      from: label,
      timestamp: msgTimestamp,
      previousTimestamp,
      envelope: envelopeOptions,
      body: attributedBody,
    });

    // Group chat: build history context
    let combinedBody = body;
    let inboundHistory:
    | Array<{ sender: string | undefined; body: string; timestamp: number | undefined }>
    | undefined;

    if (isGroup && groupCode) {
      const { historyLimit } = account;

      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: chatHistories,
        historyKey: groupCode,
        limit: historyLimit,
        currentMessage: body,
        formatEntry: entry => core.channel.reply.formatAgentEnvelope({
          channel: "YUANBAO",
          from: `group:${groupCode}:${entry.sender}`,
          timestamp: entry.timestamp,
          body: entry.body,
          envelope: envelopeOptions,
        }),
      });

      inboundHistory = historyLimit > 0
        ? (chatHistories.get(groupCode) ?? []).map(entry => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
        : undefined;
    }

    // Use SDK finalizeInboundContext
    ctx.ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: rewrittenBody,
      ...(isGroup ? { InboundHistory: inboundHistory } : {}),
      RawBody: rewrittenBody,
      CommandBody: commandParts?.length > 0 ? commandParts.join(" ") : rewrittenBody,
      From: `yuanbao:${label}`,
      To: `yuanbao:${label}`,
      SessionKey: route.sessionKey,
      AccountId: route.accountId,
      ChatType: isGroup ? "group" : "direct",
      ConversationLabel: label,
      ...(isGroup && raw.group_name ? { GroupSubject: raw.group_name } : {}),
      SenderName: senderNickname || fromAccount,
      SenderId: fromAccount,
      Provider: "yuanbao",
      Surface: "yuanbao",
      MessageSid: raw.msg_id ?? String(raw.msg_seq ?? ""),
      TraceId: ctx.traceContext?.traceId,
      Traceparent: ctx.traceContext?.traceparent,
      SeqId: ctx.traceContext?.seqId,
      OriginatingChannel: "yuanbao",
      OriginatingTo: `yuanbao:${label}`,
      CommandAuthorized: commandAuthorized,
      ...(account.markdownHintEnabled && { GroupSystemPrompt: YUANBAO_MARKDOWN_HINT }),
      UntrustedContext: [`[Current Time] ${new Date().toString()}`],
      ...(mediaPaths.length > 0 && { MediaPaths: mediaPaths, MediaPath: mediaPaths[0] }),
      ...(mediaTypes.length > 0 && { MediaTypes: mediaTypes, MediaType: mediaTypes[0] }),
      ...(ctx.linkUrls.length > 0 && { LinkUnderstanding: [...new Set(ctx.linkUrls)] }),
    });

    await next();

    // Group chat: clear consumed history after AI reply completes
    if (isGroup && groupCode) {
      clearHistoryEntriesIfEnabled({
        historyMap: chatHistories,
        historyKey: groupCode,
        limit: account.historyLimit,
      });
    }
  },
};
