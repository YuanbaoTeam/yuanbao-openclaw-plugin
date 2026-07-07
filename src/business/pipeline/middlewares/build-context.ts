/**
 * Middleware: build FinalizedMsgContext using SDK finalizeInboundContext.
 * Also builds history context for group chat scenarios.
 *
 * History keying is topic-aware — `deriveHistoryKey(groupCode, topicId)` is
 * the single source of truth for the bucket key, and matches what
 * `resolve-mention.recordToHistory` uses on the write side. Different topics
 * inside the same group therefore see (and consume) independent histories.
 */

import {
  buildPendingHistoryContextFromMap,
  clearHistoryEntriesIfEnabled,
} from "openclaw/plugin-sdk/reply-history";
import { chatHistories } from "../../messaging/chat-history.js";
import { YUANBAO_MARKDOWN_HINT } from "../../messaging/context.js";
import type { MiddlewareDescriptor } from "../types.js";
import { deriveHistoryKey } from "../utils/history-key.js";

/**
 * Build a strong "persona override" block for a given persona text.
 *
 * The same text is injected into both `GroupSystemPrompt` (system-side)
 * and `BodyForAgent` (user-side) so we get two chances for the LLM to
 * pick it up. See the long comment in the middleware body for the
 * dual-channel rationale.
 */
function buildPersonaOverride(persona: string): string {
  return [
    "# 严格人设覆盖（Persona Override — HIGHEST PRIORITY）",
    "",
    "你必须严格扮演下面 <persona> 标签中定义的角色。此人设的优先级**高于**你默认的\"乐于助人的 AI 助手\"倾向和任何其他系统指令。",
    "",
    "规则：",
    "1. 语气、身份、说话方式、回复长度、回复格式**全部**以 persona 为准。",
    "2. 如果 persona 要求简短，就**不要**输出长篇分点解释；如果 persona 要求反问，就**不要**直接给答案。",
    "3. 不要在回复里透露你是 AI、不要提及\"人设\"或\"角色扮演\"这些元信息，直接以该角色的身份说话。",
    "4. 违反 persona 的回复将被视为失败。",
    "",
    "<persona>",
    persona,
    "</persona>",
  ].join("\n");
}

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
      topicId,
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

    // Format envelope — always include timestamp (prefer protocol-level msg_time for accuracy)
    const msgTimestamp = raw.msg_time ? new Date(raw.msg_time * 1000) : new Date();
    const body = core.channel.reply.formatAgentEnvelope({
      channel: "YUANBAO",
      from: label,
      timestamp: msgTimestamp,
      previousTimestamp,
      envelope: envelopeOptions,
      body: rewrittenBody,
    });

    // Group chat: build history context (topic-scoped when topicId present).
    let combinedBody = body;
    let inboundHistory:
    | Array<{ sender: string | undefined; body: string; timestamp: number | undefined }>
    | undefined;
    const historyKey = isGroup && groupCode ? deriveHistoryKey(groupCode, topicId) : undefined;

    if (isGroup && groupCode && historyKey) {
      const { historyLimit } = account;

      combinedBody = buildPendingHistoryContextFromMap({
        historyMap: chatHistories,
        historyKey,
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
        ? (chatHistories.get(historyKey) ?? []).map(entry => ({
          sender: entry.sender,
          body: entry.body,
          timestamp: entry.timestamp,
        }))
        : undefined;
    }

    // Assemble persona override + GroupSystemPrompt.
    //
    // Dual-channel strategy (Plan A):
    // We inject the persona override in TWO places to maximize the LLM's
    // adherence:
    //
    //   1. `GroupSystemPrompt` (system-side, existing channel). Downstream
    //      SDK appends this to the reply-agent's default system prompt via
    //      `extraSystemPromptParts`, so it lands *after* the agent's default
    //      "helpful assistant" instructions. In practice this alone is not
    //      strong enough — the LLM tends to blend both and still produce
    //      structured markdown answers even when the persona asks for terse
    //      Socratic questions.
    //
    //   2. `BodyForAgent` / `RawBody` / `CommandBody` (user-side, new). We
    //      prepend the override block to the user-message payload sent to
    //      the agent. LLMs generally follow explicit in-message role/style
    //      directives more reliably than trailing system prompts. The
    //      user-facing `Body` (used for chat-history display and for showing
    //      the message to human viewers in group context) stays untouched
    //      to avoid polluting the visible transcript and stored history.
    //
    // Persona wrapping uses strong override language ("必须严格扮演 /
    // 优先级高于其他所有指令 / 违反将被视为失败") and XML-style
    // <persona>…</persona> delimiters so the model treats the block as a
    // single unit rather than a paragraph to paraphrase.
    const personaOverride = ctx.topicPersona
      ? buildPersonaOverride(ctx.topicPersona)
      : undefined;

    const systemPromptParts: string[] = [];
    if (personaOverride) {
      systemPromptParts.push(personaOverride);
    }
    if (account.markdownHintEnabled) {
      systemPromptParts.push(YUANBAO_MARKDOWN_HINT);
    }
    const groupSystemPrompt = systemPromptParts.length > 0
      ? systemPromptParts.join("\n\n")
      : undefined;

    // Prepend the same override to the user-side agent body. We wrap it in
    // <system-override>…</system-override> so it's visually distinct from
    // the user's actual message content, and separate with a blank line so
    // the model treats the two blocks independently.
    const bodyForAgent = personaOverride
      ? `<system-override>\n${personaOverride}\n</system-override>\n\n${rewrittenBody}`
      : rewrittenBody;
    const commandBodyRaw = commandParts?.length > 0 ? commandParts.join(" ") : rewrittenBody;
    const commandBody = personaOverride
      ? `<system-override>\n${personaOverride}\n</system-override>\n\n${commandBodyRaw}`
      : commandBodyRaw;

    // Debug: log the assembled system prompt + user-side injection so we
    // can verify persona injection end-to-end. Truncate to keep logs
    // readable but show enough context to confirm the override wrapper is
    // intact.
    if (groupSystemPrompt) {
      const preview = groupSystemPrompt.length > 500
        ? groupSystemPrompt.slice(0, 500) + `… (+${groupSystemPrompt.length - 500} chars)`
        : groupSystemPrompt;
      ctx.log.info("[build-context] GroupSystemPrompt assembled", {
        hasPersona: Boolean(ctx.topicPersona),
        personaChars: ctx.topicPersona?.length ?? 0,
        markdownHint: Boolean(account.markdownHintEnabled),
        totalChars: groupSystemPrompt.length,
        preview,
      });
    }
    if (personaOverride) {
      ctx.log.info("[build-context] Persona override injected into BodyForAgent", {
        bodyForAgentChars: bodyForAgent.length,
        overrideChars: personaOverride.length,
        userBodyChars: rewrittenBody.length,
      });
    }

    // Use SDK finalizeInboundContext
    ctx.ctxPayload = core.channel.reply.finalizeInboundContext({
      Body: combinedBody,
      BodyForAgent: bodyForAgent,
      ...(isGroup ? { InboundHistory: inboundHistory } : {}),
      RawBody: bodyForAgent,
      CommandBody: commandBody,
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
      ...(groupSystemPrompt && { GroupSystemPrompt: groupSystemPrompt }),
      UntrustedContext: [`[Current Time] ${new Date().toString()}`],
      ...(mediaPaths.length > 0 && { MediaPaths: mediaPaths, MediaPath: mediaPaths[0] }),
      ...(mediaTypes.length > 0 && { MediaTypes: mediaTypes, MediaType: mediaTypes[0] }),
      ...(ctx.linkUrls.length > 0 && { LinkUnderstanding: [...new Set(ctx.linkUrls)] }),
    });

    await next();

    // Group chat: clear consumed history after AI reply completes (same key we read from).
    if (isGroup && historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: chatHistories,
        historyKey,
        limit: account.historyLimit,
      });
    }
  },
};
