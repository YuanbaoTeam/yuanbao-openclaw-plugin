/**
 * AI reply dispatch: onPartialReply drives text via StreamingOutputSession;
 * deliver handles media and text fallback when partial never fires.
 */

import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import {
  resolveOutboundMediaUrls,
  normalizeOutboundReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { WS_HEARTBEAT } from "../../../access/ws/types.js";
import { getPluginVersion } from "../../../infra/env.js";
import { createLog } from "../../../logger.js";
import { PLUGIN_ID, readInstalledVersion } from "../../commands/upgrade/utils.js";
import { createReplyHeartbeatController } from "../../outbound/heartbeat.js";
import { createStreamingOutputSession } from "../../outbound/streaming-output-session.js";
import { mdAtomic } from "../../utils/markdown.js";
import { runWithTraceContext } from "../../trace/context.js";
import type { MiddlewareDescriptor } from "../types.js";

const DELIVER_TEXT_CHUNK_LIMIT = 1200;
// Both incomplete-turn fallback variants contain this phrase; the core itself
// matches on it (result-fallback-classifier.ts), so treat it as contracted.
const INCOMPLETE_TURN_WARNING_RE = /Agent couldn't generate a response/i;

// Core emits the incomplete-turn warning after an empty post-tool stop even when
// a channel action (sticker/react) already delivered user-visible content, since
// its send-action allowlist doesn't recognize those actions. Suppress the false
// positive using our action-delivery tracking as the authoritative signal.
function isSuppressedIncompleteTurnWarning(
  payload: Record<string, unknown>,
  traceContext: { hasActionDelivered(): boolean } | undefined,
): boolean {
  return (
    payload.isError === true &&
    INCOMPLETE_TURN_WARNING_RE.test(typeof payload.text === "string" ? payload.text : "") &&
    (traceContext?.hasActionDelivered() ?? false)
  );
}

async function resolveStatusVersionSuffix(): Promise<string> {
  try {
    const installed = await readInstalledVersion(PLUGIN_ID);
    return `\n\n🤖 Bot: yuanbaobot(${installed ?? getPluginVersion()})`;
  } catch {
    return `\n\n🤖 Bot: yuanbaobot(${getPluginVersion()})`;
  }
}

export const dispatchReply: MiddlewareDescriptor = {
  name: "dispatch-reply",
  handler: async (ctx, next) => {
    const {
      core,
      config,
      account,
      ctxPayload,
      route,
      storePath,
      isGroup,
      fromAccount,
      groupCode,
      sender,
    } = ctx;

    if (!ctxPayload || !route || !storePath || !sender) {
      const missing = [
        !ctxPayload && "ctxPayload",
        !route && "route",
        !storePath && "storePath",
        !sender && "sender",
      ].filter(Boolean);
      ctx.log.error("[dispatch-reply] 前置中间件未就绪", {
        missing: missing.join(", "),
      });
      return;
    }

    const heartbeatLog = createLog("heartbeat");
    const heartbeatMeta = {
      ctx: {
        account,
        config,
        core,
        log: {
          ...heartbeatLog,
          verbose: (...a: [string, Record<string, unknown>?]) => heartbeatLog.debug(...a),
        },
        wsClient: ctx.wsClient,
        groupCode,
        abortSignal: ctx.abortSignal,
        statusSink: ctx.statusSink,
      },
      account,
      toAccount: fromAccount,
      groupCode: isGroup ? groupCode : undefined,
    };
    const heartbeat = createReplyHeartbeatController({ meta: heartbeatMeta });

    const sessionKey = route.sessionKey || (isGroup ? `group:${groupCode}` : `direct:${fromAccount}`);

    const chunkMarkdown = (text: string, maxChars: number) =>
      mdAtomic.chunkAware(text, maxChars, core.channel.text.chunkMarkdownText);

    const session = createStreamingOutputSession({
      sender,
      sessionKey,
      disableBlockStreaming: account.disableBlockStreaming,
      chunkText: chunkMarkdown,
      minSendIntervalMs: 1000,
    });

    let hasSentContent = false;
    let statusVersionSuffixAppended = false;

    try {
      await core.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        onRecordError: (err: unknown) => {
          ctx.log.error("[dispatch-reply] recordInboundSession 失败", { error: String(err) });
        },
      });

      const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
        cfg: config,
        agentId: route.agentId,
        channel: "yuanbao",
        accountId: account.accountId,
      });

      const doDispatchReply = () => core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        dispatcherOptions: {
          ...replyPipeline,
          deliver: async (payload: Record<string, unknown>, info: { kind: string }) => {
            if (ctx.abortSignal?.aborted) return;
            if (payload.isReasoning || payload.isCompactionNotice) return;
            if (info.kind === "tool") return;

            if (isSuppressedIncompleteTurnWarning(payload, ctx.traceContext)) {
              ctx.log.warn("[dispatch-reply] 抑制 incomplete-turn 误告警");
              return;
            }

            const normalized = normalizeOutboundReplyPayload(payload);

            const mediaUrls = resolveOutboundMediaUrls(normalized);
            for (const url of mediaUrls) {
              if (url) {
                await sender.sendMedia(url);
                hasSentContent = true;
              }
            }

            if (!session.hasReceivedPartial()) {
              const text = normalized.text ?? "";
              if (text.trim()) {
                let outText = text;
                if (ctx.rawBody.trim().startsWith("/status") && !statusVersionSuffixAppended) {
                  outText += await resolveStatusVersionSuffix();
                  statusVersionSuffixAppended = true;
                }
                const chunks = chunkMarkdown(outText, DELIVER_TEXT_CHUNK_LIMIT);
                for (const chunk of chunks) {
                  if (chunk.trim()) {
                    await sender.sendText(chunk);
                    hasSentContent = true;
                  }
                }
              }
            }
          },
          onError: (err: unknown, info: { kind: string }) => {
            if (ctx.abortSignal?.aborted) return;
            ctx.log.error("[dispatch-reply] 回复 dispatch 失败", {
              kind: info.kind,
              error: String(err),
            });
          },
        },
        replyOptions: {
          abortSignal: ctx.abortSignal,
          disableBlockStreaming: account.disableBlockStreaming,
          ...({ sourceReplyDeliveryMode: "automatic" } as unknown as Record<string, unknown>),
          onModelSelected,
          onAgentRunStart: () => {
            heartbeat.emit(WS_HEARTBEAT.RUNNING);
          },
          onAssistantMessageStart: () => {
            session.beginNewSegment();
            heartbeat.emit(WS_HEARTBEAT.RUNNING);
          },
          onPartialReply: async (payload: { text?: string }) => {
            heartbeat.emit(WS_HEARTBEAT.RUNNING);
            const text = typeof payload.text === "string" ? payload.text : "";
            if (!text) return;
            await session.update(text);
          },
          onReasoningEnd: () => {
            session.markReasoningBoundary();
          },
          onToolStart: async () => {
            try {
              await session.flushNow();
            } catch (err) {
              ctx.log.error("[dispatch-reply] onToolStart flushNow 失败", {
                error: String(err),
              });
            }
          },
        },
      });

      if (ctx.traceContext) {
        await runWithTraceContext(ctx.traceContext, doDispatchReply);
      } else {
        await doDispatchReply();
      }

      const flushed = await session.finalize();
      if (flushed) hasSentContent = true;

      const deliveredViaAction = ctx.traceContext?.hasActionDelivered() ?? false;

      if (!hasSentContent && !deliveredViaAction && !ctx.abortSignal?.aborted) {
        const { fallbackReply } = account;
        if (fallbackReply) {
          ctx.log.warn("[dispatch-reply] AI 未返回任何内容，使用 fallbackReply");
          await sender.sendText(fallbackReply);
        } else {
          ctx.log.warn("[dispatch-reply] AI 未返回任何内容");
        }
      } else {
        ctx.statusSink?.({ lastOutboundAt: Date.now() });
      }
    } catch (err) {
      session.abort();
      throw err;
    } finally {
      heartbeat.finishIfNeeded();
    }

    ctx.log.info("[dispatch-reply] 消息处理完成", {
      isGroup,
      groupCode,
      fromAccount,
    });

    await next();
  },
};
