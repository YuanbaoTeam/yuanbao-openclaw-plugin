/**
 * yuanbao_xcard_send tool: send a self-contained A2UI v1.0 Inline Surface authored by AI.
 *
 * The model uses the installed xcard-generator Skill to author and statically validate JSONL;
 * this tool repeats the security/structure checks at runtime, assigns trusted routing metadata,
 * sends the card, and optionally waits for one of the card-declared renderer events.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getActiveWsClient } from "../../access/ws/runtime.js";
import { resolveYuanbaoAccount } from "../../accounts.js";
import { createLog } from "../../logger.js";
import { DEFAULT_WAIT_TIMEOUT_SEC, MAX_WAIT_TIMEOUT_SEC } from "../xcard/constants.js";
import { parseGeneratedMessages, validateGeneratedMessages } from "../xcard/generated.js";
import {
  hasGroupWaiter,
  waitForSurfaceAction,
  type SurfaceAudience,
  type SurfaceMode,
  type WaitOutcome,
  type XCardActionResult,
} from "../xcard/registry.js";
import { createGeneratedCard, XCardSendError } from "../xcard/service.js";
import { pauseGroupReplyHeartbeat } from "../outbound/heartbeat.js";
import { extractGroupCode, json, type OpenClawPluginToolContext } from "../utils/utils.js";

const TOOL_NAME = "yuanbao_xcard_send";

const DESCRIPTION = [
  "发送由 AI 自由创作的元宝 xCard（自包含 A2UI v1.0 Inline Surface）。",
  "适合主动使用的场景：让用户选择或投票、填写表单、确认操作、浏览结构化列表/详情、展示需要按钮交互的结果。",
  "当用户明确要求卡片，或卡片能明显减少来回追问、降低输入成本、提升结构化信息可读性时，优先使用本工具。",
  "简单问答、纯文本说明、单句通知以及没有结构化展示或交互收益的内容，不要使用 xCard，直接文本回复。",
  "先使用已安装的 xcard-generator Skill，按其中规则生成并校验 JSONL；再把完整 JSONL 作为 messages 传入本工具。",
  "本工具会再次校验协议、xcard catalog、组件引用、事件及 10KB 线包上限，并由插件重写 surfaceId、注入可信绑定信息。",
  "只接受自包含卡片：不要使用 WebCard、xCardTemplate、tracking、@hostEnv 或宿主自定义函数。",
  "交互卡必须设计可见的操作后状态，不能只发送 action.event：在 DataModel 中预留 __openclaw，并提供绑定 /__openclaw/resultText 的结果 Text；把可操作区域的 enabled 设为 {call:\"not\",args:{value:{path:\"/__openclaw/completed\"}}}。",
  "每个 action.event.context 必须携带明确业务值和人类可读的 resultText（如 {date:\"10/16\",weekday:\"周五\",resultText:\"已选择：10/16 周五\"}），不要只把业务值编码进 event.name。",
  "需要点击后立即反馈时，按 xcard-generator 规则使用 sequence，先 updateData 更新本地结果，再发送 event；服务端 103 update 也会覆盖 /__openclaw 为可信最终状态。",
  "卡片中的 action.event 会成为允许的交互事件；用户操作后，context 会原样返回给模型。",
  "必须根据业务语义显式选择 mode，不能省略：单人单次授权、最终确认、一次性提交、首个选择即结束时用 once；需要修改选择、反复筛选/翻页/切换、多步骤交互时用 perRevision。",
  "群内需要多人分别确认、投票或选择时，使用 audience=anyone 且 mode=perRevision；只有明确采用“首位响应者决定结果”时才可在群内使用 once。",
  "mode=once 在首次接受操作后把 completed 置为 true 并禁用整卡；mode=perRevision 每次接受操作后递增 revision、写入最新 resultText，并保持卡片可继续操作。",
  "同一业务后续需要改变卡片内容时，使用 yuanbao_xcard_update 更新返回的 surfaceId；不要再次调用本工具创建替代卡片。",
  "如果当前任务必须等待用户操作，设置 waitForAction=true；否则用户之后操作会唤醒新一轮。",
  "工具返回 ok=true 表示卡片已直接展示给用户；后续只需简短确认已发送，不要再用文字复述卡片中的标题、列表、详情、选项或操作说明。",
  "当前只开放自由创作发送能力；请直接按 xcard-generator 规则生成卡片。",
].join("\n");

const PARAMETERS = {
  type: "object",
  properties: {
    messages: {
      type: "string",
      description: "xcard-generator 产出的完整 JSONL，或等价的 JSON 消息数组文本。",
    },
    title: {
      type: "string",
      description: "卡片标题，用于工具结果和操作回调说明（1–80 字符）。",
    },
    fallbackText: {
      type: "string",
      description: "客户端无法渲染或服务端拒绝卡片时给用户看的纯文字版本；省略时使用 title。",
    },
    audience: {
      type: "string",
      enum: ["requester", "anyone"],
      description: "谁可以操作：requester=仅请求者（默认）；anyone=群内任何人。",
    },
    mode: {
      type: "string",
      enum: ["once", "perRevision"],
      description: "必须显式判断：once=单人单次授权/最终确认/一次性提交；perRevision=多次或多步骤交互，以及群内多人分别操作。",
    },
    waitForAction: {
      type: "boolean",
      description: "是否阻塞等待用户操作，默认 false。",
    },
    waitTimeoutSec: {
      type: "number",
      description: `等待超时秒数，默认 ${DEFAULT_WAIT_TIMEOUT_SEC}，最大 ${MAX_WAIT_TIMEOUT_SEC}。`,
    },
  },
  required: ["messages", "title", "mode"],
} as const;

interface SendParams {
  messages?: unknown;
  title?: unknown;
  fallbackText?: unknown;
  audience?: unknown;
  mode?: unknown;
  waitForAction?: unknown;
  waitTimeoutSec?: unknown;
}

function describeAction(result: XCardActionResult) {
  return {
    action: result.action,
    context: result.context,
    ...(result.userMessage ? { userMessage: result.userMessage } : {}),
    ...(result.sourceComponentId ? { sourceComponentId: result.sourceComponentId } : {}),
    operatorUserId: result.operatorUserId,
    at: new Date(result.at).toISOString(),
  };
}

function waitResult(outcome: WaitOutcome) {
  if (outcome.status === "action") {
    return {
      waitStatus: "action_received",
      userAction: describeAction(outcome.result),
      note: "用户操作已返回，本次操作不会再作为新消息重复到达。",
    };
  }
  if (outcome.status === "timeout") {
    return { waitStatus: "timeout", note: "等待超时，卡片仍有效；用户之后操作会唤醒新一轮。" };
  }
  return { waitStatus: "cancelled", reason: outcome.reason };
}

function clampWaitMs(sec: unknown): number {
  const n = typeof sec === "number" && Number.isFinite(sec) ? sec : DEFAULT_WAIT_TIMEOUT_SEC;
  return Math.round(Math.min(Math.max(n, 5), MAX_WAIT_TIMEOUT_SEC) * 1000);
}

function createYuanbaoXCardSendTool(ctx: OpenClawPluginToolContext) {
  if (ctx.messageChannel !== "yuanbao") return null;
  const sessionKey = ctx.sessionKey ?? "";
  const groupCode = extractGroupCode(sessionKey);
  if (!groupCode) return null;
  const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
  if (!cfg) return null;
  const accountId = ctx.deliveryContext?.accountId ?? ctx.agentAccountId ?? undefined;
  const account = resolveYuanbaoAccount({ cfg, accountId });
  if (!account.xcardEnabled) return null;
  const requesterId = ctx.requesterSenderId ?? "";
  const log = createLog("tools.xcard-send");

  return {
    name: TOOL_NAME,
    label: "发送自由创作 xCard",
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const p = params as SendParams;
      log.debug("execute", { toolCallId, inputType: typeof p.messages });

      const title = typeof p.title === "string" ? p.title.trim() : "";
      if (!title || title.length > 80) return json({ ok: false, error: "title 必须为 1–80 字符" });
      const fallbackText = typeof p.fallbackText === "string" && p.fallbackText.trim()
        ? p.fallbackText.trim()
        : title;
      if (fallbackText.length > 2000) return json({ ok: false, error: "fallbackText 最长 2000 字符" });
      if (p.mode !== "once" && p.mode !== "perRevision") {
        return json({
          ok: false,
          error: "mode 必须显式指定为 once 或 perRevision；请根据单次最终操作与多次/多人交互语义判断。",
          retryable: true,
        });
      }
      const mode: SurfaceMode = p.mode;

      const parsed = parseGeneratedMessages(p.messages);
      if ("error" in parsed) return json({ ok: false, error: parsed.error, retryable: true });
      const checked = validateGeneratedMessages(parsed.messages);
      if (!checked.ok) {
        return json({
          ok: false,
          error: "xCard A2UI 校验失败",
          errors: checked.errors.slice(0, 30),
          retryable: true,
          note: "按 errors 修正 JSONL，并用 xcard-generator 的 validate_xcard_bundle.py 复检后重试。",
        });
      }

      const wsClient = getActiveWsClient(account.accountId);
      if (!wsClient) return json({ ok: false, error: "元宝连接不可用，无法发送卡片" });
      const audience: SurfaceAudience = p.audience === "anyone" ? "anyone" : "requester";
      if (audience === "requester" && !requesterId) {
        return json({ ok: false, error: "无法确定发起用户，请使用 audience=anyone" });
      }

      try {
        const rec = await createGeneratedCard({
          account,
          wsClient,
          groupCode,
          sessionKey,
          ownerUserId: requesterId,
          audience,
          mode,
          title,
          fallbackText,
          messages: parsed.messages,
        });
        const result: Record<string, unknown> = {
          ok: true,
          surfaceId: rec.surfaceId,
          source: "generated",
          title: rec.title,
          state: rec.state,
          revision: rec.revision,
          mode: rec.mode,
          audience: rec.audience,
          actions: rec.actions ?? [],
          delivery: "card_already_sent",
          assistantInstruction: "卡片已直接展示给用户。只需简短确认已发送，不要复述卡片内容。",
        };
        if (!p.waitForAction) return json(result);
        if (hasGroupWaiter(account.accountId, groupCode)) {
          return json({ ...result, waitDowngraded: true, note: "本群已有卡片在等待，本次不等待。" });
        }
        const releaseHeartbeat = pauseGroupReplyHeartbeat(account.accountId, groupCode);
        try {
          return json({ ...result, ...waitResult(await waitForSurfaceAction(rec, clampWaitMs(p.waitTimeoutSec), signal)) });
        } finally {
          releaseHeartbeat();
        }
      } catch (err) {
        log.error("send generated xcard failed", { error: String(err) });
        if (err instanceof XCardSendError) {
          return json({
            ok: false,
            error: err.message,
            failure: err.kind,
            retryable: err.kind === "too_large",
            fallbackSent: err.fallbackSent,
          });
        }
        return json({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  };
}

export function registerXCardSendTool(api: OpenClawPluginApi): void {
  createLog("tools.xcard-send").info("register tool", { name: TOOL_NAME, optional: false });
  api.registerTool(createYuanbaoXCardSendTool, { name: TOOL_NAME, optional: false });
}
