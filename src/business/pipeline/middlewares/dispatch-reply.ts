/**
 * Middleware: AI reply dispatch.
 *
 * Uses onPartialReply as the authoritative text source (cumulative, thinking-stripped)
 * instead of the deliver callback. This avoids spurious newlines inserted by the SDK
 * coalescer at thinking boundaries and prevents duplicate sends from block streaming.
 *
 * Text flow:
 *   onPartialReply(cumulative text) → StreamingOutputSession.update()
 *   onReasoningEnd                  → session.markReasoningBoundary()
 *   onToolStart                     → session.flushNow()
 *   dispatch end                    → session.finalize()
 *
 * deliver callback is kept for media-only delivery and as a fallback when
 * onPartialReply was never called (e.g. SDK versions that don't support it).
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
import { runWithTraceContext } from "../../trace/context.js";
import type { MiddlewareDescriptor } from "../types.js";

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

    // Yuanbao client natively renders Markdown tables, always use 'off'
    const tableMode = "off" as const;

    ctx.log.debug(`[DEBUG][dispatch-reply] 开始生成回复，目标=${isGroup ? `群:${groupCode}` : fromAccount}，disableBlockStreaming=${account.disableBlockStreaming}`);

    // ⭐ Create heartbeat controller
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

    // ⭐ Create streaming output session (replaces QueueSession)
    const chunkText = (text: string, maxChars: number) =>
      core.channel.text.chunkMarkdownText(text, maxChars);
    const sessionKey = route.sessionKey || (isGroup ? `group:${groupCode}` : `direct:${fromAccount}`);

    const session = createStreamingOutputSession({
      sender,
      sessionKey,
      disableBlockStreaming: account.disableBlockStreaming,
      chunkText,
      onComplete: () => {
        ctx.log.debug(`[DEBUG][dispatch-reply] session 已完成 (${sessionKey})`);
      },
    });

    // Track deliver kind transitions for isAfterToolCall detection
    let prevDeliverKind: string | null = null;
    let hasSentContent = false;

    try {
      // ⭐ Step 1: Record inbound session
      await core.channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        onRecordError: (err: unknown) => {
          ctx.log.error("[dispatch-reply] recordInboundSession 失败", { error: String(err) });
        },
      });

      // ⭐ Step 2: Create reply pipeline
      const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
        cfg: config,
        agentId: route.agentId,
        channel: "yuanbao",
        accountId: account.accountId,
      });

      // ⭐ Step 3: Dispatch reply
      const doDispatchReply = () => core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg: config,
        dispatcherOptions: {
          ...replyPipeline,
          deliver: async (payload: Record<string, unknown>, info: { kind: string }) => {
            if (ctx.abortSignal?.aborted) {
              ctx.log.warn(`[DEBUG][dispatch-reply] 已中止，停止后续 deliver`);
              return;
            }

            if (payload.isReasoning) {
              ctx.log.debug(`[DEBUG][dispatch-reply] [deliver] kind=${info.kind} → isReasoning，跳过`);
              return;
            }

            if (payload.isCompactionNotice) {
              ctx.log.debug(`[DEBUG][dispatch-reply] [deliver] kind=${info.kind} → isCompactionNotice，跳过`);
              return;
            }

            ctx.log.debug(`[DEBUG][dispatch-reply] [deliver] kind=${info.kind}，hasPartial=${session.hasReceivedPartial()}`);

            const normalized = normalizeOutboundReplyPayload(payload);
            const prevKind = prevDeliverKind;
            prevDeliverKind = info.kind;

            // Tool delivers are not sent to the user
            if (info.kind === "tool") {
              ctx.log.debug(`[DEBUG][dispatch-reply] [deliver] kind=tool，跳过文本，只更新 prevDeliverKind`);
              return;
            }

            // Send media immediately (no buffering needed)
            const mediaUrls = resolveOutboundMediaUrls(normalized);
            if (mediaUrls.length > 0) {
              ctx.log.debug(`[DEBUG][dispatch-reply] [deliver] 发送媒体 ${mediaUrls.length} 个`);
            }
            for (const url of mediaUrls) {
              if (url) {
                await sender.sendMedia(url);
                hasSentContent = true;
              }
            }

            // Fallback: if onPartialReply was never called (SDK doesn't support it),
            // send text from deliver directly
            if (!session.hasReceivedPartial()) {
              const text = core.channel.text.convertMarkdownTables(
                normalized.text ?? "",
                tableMode,
              );
              if (text.trim()) {
                const isAfterToolCall =
                  info.kind === "block" && prevKind !== null && prevKind !== "block";
                const outText = isAfterToolCall ? `\n\n${text}` : text;
                ctx.log.debug(`[DEBUG][dispatch-reply] [deliver] fallback 模式（无 partial 流），直接发送文本，isAfterToolCall=${isAfterToolCall}`);
                await sender.sendText(outText);
                hasSentContent = true;
              }
            } else {
              ctx.log.debug(`[DEBUG][dispatch-reply] [deliver] 已有 partial 流，文本将由 session.finalize() 发送，跳过 deliver 文本`);
            }

            heartbeat.emit(WS_HEARTBEAT.RUNNING);
          },
          onError: (err: unknown, info: { kind: string }) => {
            if (ctx.abortSignal?.aborted) {
              ctx.log.warn(`[DEBUG][dispatch-reply] 已中止，忽略 dispatch 错误`);
              return;
            }
            ctx.log.error("[dispatch-reply] 回复 dispatch 失败", {
              kind: info.kind,
              error: String(err),
            });
          },
        },
        replyOptions: {
          abortSignal: ctx.abortSignal,
          disableBlockStreaming: account.disableBlockStreaming,
          // 4.27 后支持的新参数
          ...({ sourceReplyDeliveryMode: "automatic" } as unknown as Record<string, unknown>),
          onModelSelected,
          onAgentRunStart: (runId: string) => {
            ctx.log.debug(`[DEBUG][dispatch-reply] [onAgentRunStart] runId=${runId}`);
            heartbeat.emit(WS_HEARTBEAT.RUNNING);
          },
          onAssistantMessageStart: () => {
            ctx.log.debug(`[DEBUG][dispatch-reply] [onAssistantMessageStart] 新 assistant 消息开始`);
            heartbeat.emit(WS_HEARTBEAT.RUNNING);
          },
          onPartialReply: async (payload: { text?: string }) => {
            ctx.log.debug(`[DEBUG][dispatch-reply] [onPartialReply]`, { ...payload });
            const text = typeof payload.text === "string" ? payload.text : "";
            ctx.log.debug(`[DEBUG][dispatch-reply] [onPartialReply] text="${text?.replace(/\n/g, "↵")}"`);
            if (!text) {
              ctx.log.debug(`[DEBUG][dispatch-reply] [onPartialReply] 文本为空，跳过`);
              return;
            }
            await session.update(text);
          },
          onReasoningEnd: () => {
            ctx.log.debug(`[DEBUG][dispatch-reply] [onReasoningEnd] thinking 块结束，调用 markReasoningBoundary`);
            session.markReasoningBoundary();
          },
          onReasoningStream: (payload: { text?: string }) => {
            ctx.log.debug(`[DEBUG][dispatch-reply] [onReasoningStream] 思考内容长度=${payload.text?.length ?? 0}`);
          },
          // ⭐ Force-flush before tool_call so user sees AI text before tool runs
          onToolStart: async (toolPayload: Record<string, unknown>) => {
            ctx.log.debug(`[DEBUG][dispatch-reply] [onToolStart] tool 开始，立即 flush session`, { tool: toolPayload.name });
            try {
              await session.flushNow();
            } catch (err) {
              ctx.log.error("[dispatch-reply] onToolStart flushNow 失败", {
                error: String(err),
              });
            }
          },
          onBlockReplyQueued: (payload: { text?: string }) => {
            ctx.log.debug(`[DEBUG][dispatch-reply] [onBlockReplyQueued] SDK 已入队，text="${payload.text?.replace(/\n/g, "↵")}"`);
          },
        },
      });

      // Use pipeline's unified traceContext (created by resolve-trace middleware)
      if (ctx.traceContext) {
        await runWithTraceContext(ctx.traceContext, doDispatchReply);
      } else {
        await doDispatchReply();
      }

      // ⭐ Append /status version info
      if (ctx.rawBody.trim().startsWith("/status")) {
        let displayVersion: string;
        try {
          const installed = await readInstalledVersion(PLUGIN_ID);
          displayVersion = installed ?? getPluginVersion();
        } catch (err) {
          ctx.log.warn("[dispatch-reply] readInstalledVersion 失败，回退到内存版本", {
            error: String(err),
          });
          displayVersion = getPluginVersion();
        }
        session.appendText(`\n\n🤖 Bot: yuanbaobot(${displayVersion})`);
      }

      // ⭐ Finalize session — sends remaining buffered text
      ctx.log.debug(`[DEBUG][dispatch-reply] 调用 session.finalize()`);
      const flushed = await session.finalize();
      if (flushed) hasSentContent = true;

      // The model may reply purely through a message action (e.g. sticker/react)
      // which is delivered via handleAction and bypasses the session entirely.
      const deliveredViaAction = ctx.traceContext?.hasActionDelivered() ?? false;
      ctx.log.debug(`[DEBUG][dispatch-reply] 结果：hasSentContent=${hasSentContent}，deliveredViaAction=${deliveredViaAction}`);

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
        heartbeat.emit(WS_HEARTBEAT.FINISH);
      }
    } catch (err) {
      session.abort();
      heartbeat.stop();
      throw err;
    } finally {
      heartbeat.stop();
    }

    ctx.log.info("[dispatch-reply] 消息处理完成", {
      isGroup,
      groupCode,
      fromAccount,
    });

    await next();
  },
};
