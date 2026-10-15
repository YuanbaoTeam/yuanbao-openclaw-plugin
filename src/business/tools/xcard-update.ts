/**
 * yuanbao_xcard_update tool: replace an AI-authored card's A2UI snapshot through a 103 update.
 *
 * The tool only addresses an active generated Surface in the current account/group/session.
 * Runtime validation is identical to initial creation, while trusted ids and interaction policy
 * remain owned by the plugin.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getActiveWsClient } from "../../access/ws/runtime.js";
import { resolveYuanbaoAccount } from "../../accounts.js";
import { createLog } from "../../logger.js";
import { parseGeneratedMessages, validateGeneratedMessages } from "../xcard/generated.js";
import { getSurface, withSurfaceLock } from "../xcard/registry.js";
import { updateGeneratedCard, XCardSendError } from "../xcard/service.js";
import { json, resolveYuanbaoConversation, type OpenClawPluginToolContext } from "../utils/utils.js";

const TOOL_NAME = "yuanbao_xcard_update";

const DESCRIPTION = [
  "在元宝群聊或私聊中更新之前由 yuanbao_xcard_send 创建的 AI 自由创作 xCard；通过 103 修改原卡片，不会发送 101 新卡片。",
  "同一业务需要持续交互或展示最新状态时，收到操作回调后必须优先用本工具更新原 surfaceId，不要再次调用 yuanbao_xcard_send。",
  "更新前使用 xcard-design 保持 Apple 式克制的视觉层级和原卡构图稳定，再使用 xcard-generator 生成并校验完整新快照；不要只改业务数据却重新套一套布局。",
  "messages 必须是更新后的完整自包含 A2UI v1.0 JSONL/消息数组快照，仍需包含 createSurface、updateComponents 和所需 updateDataModel；工具会保留原 surfaceId，并在 103 中自动去掉 createSurface。",
  "先根据操作回调的 context 计算新业务状态，再生成完整新快照。卡片事件名与 context 必须继续携带明确业务值。",
  "只能更新当前会话中仍为 active 的 generated 卡片；mode、audience、owner 和路由绑定不能通过本工具修改。",
  "工具返回 ok=true 表示原卡已更新；不要再发送一张替代卡，也不要用文字复述卡片内容。",
].join("\n");

const PARAMETERS = {
  type: "object",
  properties: {
    surfaceId: {
      type: "string",
      description: "操作回调中给出的原卡 surfaceId。",
    },
    messages: {
      type: "string",
      description: "更新后的完整 xCard JSONL，或等价 JSON 消息数组文本。",
    },
    title: {
      type: "string",
      description: "可选的新标题（1–80 字符）；省略时保持原标题。",
    },
    fallbackText: {
      type: "string",
      description: "可选的新纯文本降级内容（最长 2000 字符）；省略时保持原内容。",
    },
  },
  required: ["surfaceId", "messages"],
} as const;

interface UpdateParams {
  surfaceId?: unknown;
  messages?: unknown;
  title?: unknown;
  fallbackText?: unknown;
}

function createYuanbaoXCardUpdateTool(ctx: OpenClawPluginToolContext) {
  if (ctx.messageChannel !== "yuanbao") return null;
  const sessionKey = ctx.sessionKey ?? "";
  const conversation = resolveYuanbaoConversation(sessionKey, ctx.requesterSenderId);
  if (!conversation) return null;
  const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
  if (!cfg) return null;
  const accountId = ctx.deliveryContext?.accountId ?? ctx.agentAccountId ?? undefined;
  const account = resolveYuanbaoAccount({ cfg, accountId });
  if (!account.xcardEnabled) return null;
  const log = createLog("tools.xcard-update");

  return {
    name: TOOL_NAME,
    label: "更新自由创作 xCard",
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(toolCallId: string, params: Record<string, unknown>) {
      const p = params as UpdateParams;
      const surfaceId = typeof p.surfaceId === "string" ? p.surfaceId.trim() : "";
      log.debug("execute", { toolCallId, surfaceId, inputType: typeof p.messages });
      if (!surfaceId) return json({ ok: false, error: "surfaceId 必须为非空字符串" });
      if (p.title !== undefined && (typeof p.title !== "string" || !p.title.trim() || p.title.trim().length > 80)) {
        return json({ ok: false, error: "title 必须为 1–80 字符" });
      }
      if (
        p.fallbackText !== undefined
        && (typeof p.fallbackText !== "string" || !p.fallbackText.trim() || p.fallbackText.trim().length > 2000)
      ) {
        return json({ ok: false, error: "fallbackText 必须为 1–2000 字符" });
      }

      const parsed = parseGeneratedMessages(p.messages);
      if ("error" in parsed) return json({ ok: false, error: parsed.error, retryable: true });
      const checked = validateGeneratedMessages(parsed.messages);
      if (!checked.ok) {
        return json({
          ok: false,
          error: "xCard A2UI 校验失败",
          errors: checked.errors.slice(0, 30),
          retryable: true,
          note: "请生成包含 createSurface 的完整新快照，并按 errors 修正后重试。",
        });
      }

      const wsClient = getActiveWsClient(account.accountId);
      if (!wsClient) return json({ ok: false, error: "元宝连接不可用，无法更新卡片" });

      try {
        return await withSurfaceLock(surfaceId, async () => {
          const rec = getSurface(surfaceId);
          if (!rec) return json({ ok: false, error: "找不到该卡片；卡片可能由插件重启前创建" });
          if (
            rec.accountId !== account.accountId
            || rec.isGroup !== conversation.isGroup
            || rec.groupCode !== conversation.targetId
            || rec.sessionKey !== sessionKey
          ) {
            return json({ ok: false, error: "该卡片不属于当前会话" });
          }
          if (rec.kind !== "generated") return json({ ok: false, error: "该卡片不是自由创作卡片" });
          if (rec.state !== "active") return json({ ok: false, error: `卡片当前状态为 ${rec.state}，不能继续更新` });

          const title = typeof p.title === "string" ? p.title.trim() : rec.title;
          const fallbackText = typeof p.fallbackText === "string" ? p.fallbackText.trim() : rec.fallbackText;
          await updateGeneratedCard(rec, parsed.messages, title, fallbackText, account, wsClient);
          return json({
            ok: true,
            surfaceId: rec.surfaceId,
            state: rec.state,
            revision: rec.revision,
            mode: rec.mode,
            audience: rec.audience,
            actions: rec.actions ?? [],
            delivery: "existing_card_updated",
            assistantInstruction: "原卡片已通过 103 更新。不要再调用 yuanbao_xcard_send 创建替代卡片。",
          });
        });
      } catch (err) {
        log.error("update generated xcard failed", { surfaceId, error: String(err) });
        if (err instanceof XCardSendError) {
          return json({
            ok: false,
            error: err.message,
            failure: err.kind,
            retryable: err.kind === "too_large" || err.kind === "rate_limited",
          });
        }
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

export function registerXCardUpdateTool(api: OpenClawPluginApi): void {
  createLog("tools.xcard-update").info("register tool", { name: TOOL_NAME, optional: false });
  api.registerTool(createYuanbaoXCardUpdateTool, { name: TOOL_NAME, optional: false });
}
