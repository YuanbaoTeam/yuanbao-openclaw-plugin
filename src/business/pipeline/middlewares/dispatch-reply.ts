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

/**
 * Build the trailing topic-id marker appended to every Bot reply body.
 *
 * Background: sender already writes `topicId` to IM `cloud_custom_data` (see
 * prepare-sender), but the front-end currently cannot read cloud_custom_data
 * through its IM SDK. As a payload fallback, we also embed the topicId inside
 * the visible text on its own line, so the front-end can regex it out for
 * topic attribution before rendering.
 *
 * Format (isolated on its own line so a simple end-anchored regex works):
 *   \n\n[topicId: <uuid>]
 *
 * Front-end match: /\n?\n?\[topicId:\s*([0-9a-f-]+)\]\s*$/i
 */
function buildTopicIdMarker(topicId: string | undefined): string {
  if (!topicId) return "";
  return `\n\n[topicId: ${topicId}]`;
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

    // [DEBUG] Trace which internal step of dispatch-reply we reach. Some
    // messages have shown a silent hang between `[prepare-sender] sender
    // created` and any of the downstream callbacks (`onPartialReply` /
    // `deliver`), with no `[dispatch-reply] 消息处理完成` and no engine-level
    // "middleware execution error" — meaning the handler is pending in an
    // await that we don't currently log. These probes narrow it down.
    ctx.log.info("[dispatch-reply] enter handler", {
      msgId: ctx.raw.msg_id,
      topicId: ctx.topicId,
      isGroup,
    });

    try {
      ctx.log.info("[dispatch-reply] before recordInboundSession", {
        msgId: ctx.raw.msg_id,
      });
      await core.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        onRecordError: (err: unknown) => {
          ctx.log.error("[dispatch-reply] recordInboundSession 失败", { error: String(err) });
        },
      });
      ctx.log.info("[dispatch-reply] after recordInboundSession", {
        msgId: ctx.raw.msg_id,
      });

      const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
        cfg: config,
        agentId: route.agentId,
        channel: "yuanbao",
        accountId: account.accountId,
      });
      ctx.log.info("[dispatch-reply] reply pipeline built, calling dispatchReplyWithBufferedBlockDispatcher", {
        msgId: ctx.raw.msg_id,
        agentId: route.agentId,
      });

      const doDispatchReply = () => core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        dispatcherOptions: {
          ...replyPipeline,
          deliver: async (payload: Record<string, unknown>, info: { kind: string }) => {
            // [DEBUG] 探针：sender.sendText 一次都没被走，先看 deliver 回调是不是根本没被 SDK 调
            ctx.log.info("[dispatch-reply.deliver] called", {
              kind: info.kind,
              isReasoning: Boolean(payload.isReasoning),
              isCompactionNotice: Boolean(payload.isCompactionNotice),
              hasText: typeof payload.text === "string" && payload.text.length > 0,
              textPreview: typeof payload.text === "string" ? payload.text.slice(0, 60) : null,
              aborted: Boolean(ctx.abortSignal?.aborted),
            });
            if (ctx.abortSignal?.aborted) return;
            if (payload.isReasoning || payload.isCompactionNotice) return;
            if (info.kind === "tool") return;

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
                // [topic-id payload fallback] Append trailing marker so the
                // front-end can attribute this reply to its originating topic
                // even when it fails to read cloud_custom_data via the IM SDK.
                outText += buildTopicIdMarker(ctx.topicId);
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
            // [DEBUG] 探针：观察 partial reply 是不是被 StreamingOutputSession 消化
            // ——如果是走 session.update 路径，最终会由 session 自己调 sender，
            // 而不会触发上面的 deliver 回调。看它有没有被喂内容。
            ctx.log.info("[dispatch-reply.onPartialReply] called", {
              hasText: text.length > 0,
              textLen: text.length,
              textPreview: text.slice(0, 60),
            });
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
      ctx.log.info("[dispatch-reply] doDispatchReply returned", {
        msgId: ctx.raw.msg_id,
        hasSentContent,
      });

      // [topic-id payload fallback] Append trailing marker to the streaming
      // buffer right before finalize, so the topic-id appears at the very end
      // of the last chunk (no-op if the session never accumulated content).
      // The non-streaming deliver-path handles the marker inline above.
      session.appendFinal(buildTopicIdMarker(ctx.topicId));

      ctx.log.info("[dispatch-reply] before session.finalize", { msgId: ctx.raw.msg_id });
      const flushed = await session.finalize();
      ctx.log.info("[dispatch-reply] after session.finalize", {
        msgId: ctx.raw.msg_id,
        flushed,
      });
      if (flushed) hasSentContent = true;

      const deliveredViaAction = ctx.traceContext?.hasActionDelivered() ?? false;

      if (!hasSentContent && !deliveredViaAction && !ctx.abortSignal?.aborted) {
        const { fallbackReply } = account;
        if (fallbackReply) {
          ctx.log.warn("[dispatch-reply] AI 未返回任何内容，使用 fallbackReply");
          await sender.sendText(fallbackReply + buildTopicIdMarker(ctx.topicId));
        } else {
          ctx.log.warn("[dispatch-reply] AI 未返回任何内容");
        }
      } else {
        ctx.statusSink?.({ lastOutboundAt: Date.now() });
      }
    } catch (err) {
      // Escalated log so a silent hang / partial failure never disappears —
      // we've seen cases where the surrounding engine catch-log did not fire
      // (possibly due to level filtering or the error being non-Error).
      ctx.log.error("[dispatch-reply] handler threw", {
        msgId: ctx.raw.msg_id,
        errorName: err instanceof Error ? err.name : typeof err,
        errorMessage: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
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
