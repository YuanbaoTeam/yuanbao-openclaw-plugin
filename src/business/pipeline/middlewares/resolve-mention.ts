/**
 * Middleware: reply-decision guard for group chat (4-layer priority).
 *
 * Priority (highest → lowest):
 *   L0. Muted           — `cloud_custom_data.botMuted === true`     → never reply
 *                         OR soul.md `## Muted` value is truthy
 *   L1. Explicit @      — `ctx.isAtBot === true`                    → always reply
 *   L2. Topic self-judge — `topicId` set, not @-mentioned, not muted → soul.md rules
 *   L3. Default gating  — no topicId, no @                          → SDK gating
 *
 * When a layer decides to skip, the current message is still recorded to the
 * appropriate group-history LRU so future @-replies retain conversational
 * context. `logInboundDrop` is emitted at each skip point with a distinct
 * reason so ops can tell the layers apart.
 *
 * NOTE: history keying still uses `ctx.groupCode` here; per plan task 7 this
 * will migrate to `deriveHistoryKey(groupCode, topicId?)` so topic messages
 * end up in a topic-scoped history — updating that in one place then keeps
 * this middleware's diff surgical.
 */

import {
  resolveMentionGatingWithBypass,
  logInboundDrop,
} from "openclaw/plugin-sdk/channel-inbound";
import { recordPendingHistoryEntryIfEnabled } from "openclaw/plugin-sdk/reply-history";
import { chatHistories, deriveChatKey, recordMediaHistory } from "../../messaging/chat-history.js";
import { parseTopicMeta } from "../utils/parse-topic-meta.js";
import { deriveHistoryKey } from "../utils/history-key.js";
import { loadSoulForTopic } from "../topic-judge/soul-loader.js";
import { shouldBotReplyInTopic } from "../topic-judge/index.js";
import { createOpenclawJudgeInvoker } from "../topic-judge/llm-judge.js";
import { extractFullPersona, extractMutedFlag } from "../topic-judge/prompt-builder.js";
import type { JudgeInvoker } from "../topic-judge/llm-judge.js";
import type { MiddlewareDescriptor, PipelineContext } from "../types.js";

// ─── LLM Judge activation ──────────────────────────────────────────────────

/**
 * Determine whether the LLM judge feature is enabled for this account.
 *
 * The judge now runs through OpenClaw's own agent pipeline (see
 * `llm-judge.ts::createOpenclawJudgeInvoker`), so it no longer needs an
 * external API url / key — only an on/off switch and an optional timeout.
 *
 * Env takes precedence over per-account config; explicit "false"/"0" via env
 * hard-disables the feature even when config says true.
 */
function resolveJudgeActivation(accountConfig?: {
  llmJudge?: {
    enabled?: boolean;
    timeoutMs?: number;
  };
}): { enabled: boolean; timeoutMs: number } {
  const envEnabled = process.env.YUANBAO_LLM_JUDGE_ENABLED?.trim().toLowerCase();
  const cfgEnabled = accountConfig?.llmJudge?.enabled;

  if (envEnabled === "false" || envEnabled === "0") {
    return { enabled: false, timeoutMs: 0 };
  }
  const enabled = envEnabled === "true" || envEnabled === "1" || cfgEnabled === true;

  const timeoutMs =
    Number(process.env.YUANBAO_LLM_JUDGE_TIMEOUT_MS) ||
    accountConfig?.llmJudge?.timeoutMs ||
    3000;

  return { enabled, timeoutMs };
}

/**
 * Build a JudgeInvoker for the current pipeline context, or return undefined
 * when the feature is disabled. Keeps SDK-heavy assembly out of topic-judge
 * itself (dependency inversion).
 */
function buildJudgeInvoker(ctx: PipelineContext, topicId: string): JudgeInvoker | undefined {
  const { account, core, config, fromAccount, senderNickname, groupCode } = ctx;
  const { enabled, timeoutMs } = resolveJudgeActivation(account.config);
  if (!enabled || !groupCode) return undefined;

  return createOpenclawJudgeInvoker({
    core,
    config,
    groupCode,
    topicId,
    fromAccount,
    senderNickname,
    accountId: account.accountId,
    timeoutMs,
  });
}

/**
 * Record this message to group history + media LRU when the bot decides not
 * to reply. Keeps future @-invocations context-aware.
 *
 * Kept as a private helper because three skip branches (mute / judge-skip /
 * default-gating skip) need identical bookkeeping — extracting it avoids the
 * "fix in one branch, forget the other two" trap.
 *
 * History key is topic-aware via `deriveHistoryKey` so topic-scoped drops
 * end up in the topic bucket (matching what build-context reads on the way
 * back in).
 */
function recordToHistory(ctx: PipelineContext): void {
  const { historyLimit } = ctx.account;
  const historyKey = deriveHistoryKey(ctx.groupCode!, ctx.topicId);

  if (historyLimit > 0) {
    recordPendingHistoryEntryIfEnabled({
      historyMap: chatHistories,
      historyKey,
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

  if (ctx.medias.length > 0) {
    // Media LRU stays keyed by chatKey (group:<code>) — media isn't scoped to
    // a topic (a picture posted anywhere in the group is still the same file
    // downstream tools would need to grab). Only *text history* is topic-scoped.
    recordMediaHistory(deriveChatKey(true, ctx.groupCode), {
      sender: ctx.fromAccount,
      messageId: ctx.raw.msg_id ?? String(ctx.raw.msg_seq ?? ""),
      timestamp: Date.now(),
      medias: ctx.medias,
    });
  }
}

export const resolveMention: MiddlewareDescriptor = {
  name: "resolve-mention",
  when: ctx => ctx.isGroup,
  handler: async (ctx, next) => {
    const { account, isAtBot, hasControlCommand, commandAuthorized, core, config } = ctx;
    const meta = parseTopicMeta(ctx.raw.cloud_custom_data);
    ctx.topicId = meta.topicId;

    // [debug] 观察 DTMP → openclaw 的 topicId 透传链路是否打通
    // (完整 raw 由 pipeline engine 的 [inbound-raw] 日志统一打印，此处只关注 topic 相关字段)
    ctx.log.info("[resolve-mention] inbound topic meta", {
      groupCode: ctx.groupCode,
      fromAccount: ctx.fromAccount,
      msgId: ctx.raw.msg_id,
      cloudCustomData: ctx.raw.cloud_custom_data,
      parsedTopicId: meta.topicId,
      parsedBotMuted: meta.botMuted,
    });

    // Preload soul.md once when a topicId is present, then reuse across L0
    // (mute flag), L1 (persona injection) and L2 (rules + judge). Keeps disk
    // I/O to one call per message and avoids the LRU cache churning on the
    // same key from three different call sites.
    let topicSoul: string | null = null;
    async function getTopicSoul(): Promise<string> {
      if (topicSoul !== null) return topicSoul;
      if (!meta.topicId) {
        topicSoul = "";
        return topicSoul;
      }
      try {
        topicSoul = await loadSoulForTopic(meta.topicId, {
          topicSoulDir: account.config?.topicSoulDir,
        });
      } catch (err) {
        // Loader is already best-effort — but belt-and-suspenders in case a
        // future change makes it throw. Never let soul I/O break gating.
        ctx.log.warn(`[resolve-mention] soul load failed: ${String(err)}`);
        topicSoul = "";
      }
      return topicSoul;
    }

    // ─── L0. Mute — highest priority; overrides even explicit @mention ───
    // Two sources are OR'd together:
    //   a) cloud_custom_data.botMuted === true  (per-message hint from DTMP)
    //   b) soul.md `## Muted` section value is truthy (per-topic config)
    // Either one flipping the switch mutes the bot in this topic.
    let soulMuted = false;
    if (meta.topicId) {
      const soul = await getTopicSoul();
      soulMuted = extractMutedFlag(soul);
    }
    if (meta.botMuted || soulMuted) {
      ctx.isMuted = true;
      const muteSource = meta.botMuted && soulMuted
        ? "cloud+soul"
        : meta.botMuted
          ? "cloud"
          : "soul";
      ctx.replyDecision = {
        source: "mute",
        shouldReply: false,
        reason: `muted (source: ${muteSource})`,
      };
      ctx.log.info("[resolve-mention] muted, skip reply", {
        topicId: meta.topicId,
        wasAtBot: isAtBot,
        muteSource,
        cloudBotMuted: meta.botMuted,
        soulMuted,
      });
      recordToHistory(ctx);
      logInboundDrop({
        log: msg => ctx.log.info(msg),
        channel: "yuanbao",
        reason: "muted",
        target: ctx.groupCode,
      });
      return; // Abort pipeline
    }

    // ─── L1. Explicit @bot — always reply, skip further judgment ───
    if (isAtBot) {
      ctx.effectiveWasMentioned = true;
      ctx.replyDecision = { source: "at-mention", shouldReply: true };

      // Still inject topic persona when @-mention happens inside a topic so
      // the bot keeps its per-topic tone. Soul may not exist for this topic;
      // that's fine — persona stays undefined and downstream falls back to
      // workspace-level defaults.
      if (meta.topicId) {
        try {
          const soul = await getTopicSoul();
          const persona = extractFullPersona(soul);
          if (persona) {
            ctx.topicPersona = persona;
            ctx.log.info("[resolve-mention] topic persona injected (L1)", {
              topicId: meta.topicId,
              personaChars: persona.length,
            });
          }
        } catch (err) {
          // Persona is a best-effort enhancement — never let a soul-load
          // failure break an explicit @-mention reply.
          ctx.log.warn(`[resolve-mention] L1 persona load failed: ${String(err)}`);
        }
      }

      await next();
      return;
    }

    // ─── L2. Topic self-judge — only when message came from a topic ───
    if (meta.topicId) {
      const soul = await getTopicSoul();

      // Build history tail for LLM judge context
      const historyKey = deriveHistoryKey(ctx.groupCode!, meta.topicId);
      const historyEntries = chatHistories.get(historyKey) ?? [];
      const historyTail = historyEntries.map(e => e.body);

      // Resolve judge invoker (feature flag + env vars)
      const judgeInvoker = buildJudgeInvoker(ctx, meta.topicId);

      const judge = await shouldBotReplyInTopic({
        topicId: meta.topicId,
        rawBody: ctx.rawBody,
        senderNickname: ctx.senderNickname,
        soul,
        historyTail,
        judgeInvoker,
        log: ctx.log,
      });
      ctx.replyDecision = { source: "topic-judge", ...judge };

      if (!judge.shouldReply) {
        ctx.log.info("[resolve-mention] topic-judge skip", {
          topicId: meta.topicId,
          reason: judge.reason,
          preview: ctx.rawBody.slice(0, 60),
        });
        recordToHistory(ctx);
        logInboundDrop({
          log: msg => ctx.log.info(msg),
          channel: "yuanbao",
          reason: "topic-judge",
          target: ctx.groupCode,
        });
        return; // Abort pipeline
      }

      // Judge passed — inject persona so the reply agent adopts the
      // topic-scoped tone. Reuse the same `soul` we already loaded for the
      // judge (no extra disk I/O).
      const persona = extractFullPersona(soul);
      if (persona) {
        ctx.topicPersona = persona;
        ctx.log.info("[resolve-mention] topic persona injected (L2)", {
          topicId: meta.topicId,
          personaChars: persona.length,
        });
      }

      // Judge passed → treat as an implicit mention so downstream gates
      // (which look at effectiveWasMentioned) let the message through.
      ctx.effectiveWasMentioned = true;
      await next();
      return;
    }

    // ─── L3. Default SDK gating — unchanged legacy behavior ───
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg: config,
      surface: "yuanbao",
    });

    const result = resolveMentionGatingWithBypass({
      isGroup: ctx.isGroup,
      requireMention: account.requireMention,
      canDetectMention: true,
      wasMentioned: isAtBot,
      allowTextCommands,
      hasControlCommand,
      commandAuthorized,
    });

    ctx.effectiveWasMentioned = result.effectiveWasMentioned;
    ctx.replyDecision = { source: "default-gating", shouldReply: !result.shouldSkip };

    if (result.shouldSkip) {
      recordToHistory(ctx);
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
