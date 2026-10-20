/**
 * yuanbao_xcard_template tool: create and manage built-in template xCards in Yuanbao groups.
 *
 * Template flow (the model never writes A2UI components):
 *   action=list_templates → template keys + one-line descriptions
 *   action=get_template   → the template's fields (schema), events and an example
 *   action=create         → template key + data; data is validated against the template and
 *                           field-level errors are returned for the model to fix
 * The plugin renders the card from the template (templates/), sends it as a TIMCustomElem
 * group message (envelope per transport.ts), and handles user operations, renderer errors and
 * the text fallback as before.
 * `update` replaces top-level data fields (shallow merge) and re-renders the card.
 *
 * Wait semantics (model-decided, plugin-guarded):
 * - `waitForAction=true` blocks this tool call until the user operates the card, the wait times
 *   out (default 120s, max 300s), or the run is aborted / owner sends /stop. The answer is then
 *   returned as the tool result and NO extra turn is started.
 * - Otherwise (or after a timeout) the user's later operation wakes this group session as a new
 *   turn carrying a `yuanbao_xcard_action` event.
 * - Only one waiting card per group: further wait requests are downgraded (`waitDowngraded`);
 *   so are cards for which the server returned no IM msg id.
 * - While blocked, the group's RUNNING reply heartbeat is paused (it would otherwise loop every
 *   2s and trip the server rate limit).
 *
 * Only exposed in Yuanbao group sessions.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getActiveWsClient } from "../../access/ws/runtime.js";
import { resolveYuanbaoAccount } from "../../accounts.js";
import { createLog } from "../../logger.js";
import type { ResolvedYuanbaoAccount } from "../../types.js";
import { DEFAULT_WAIT_TIMEOUT_SEC, MAX_WAIT_TIMEOUT_SEC } from "../xcard/constants.js";
import {
  getSurface,
  hasGroupWaiter,
  listSurfaces,
  waitForSurfaceAction,
  withSurfaceLock,
  type SurfaceAudience,
  type SurfaceRecord,
  type WaitOutcome,
  type XCardActionResult,
} from "../xcard/registry.js";
import { pauseGroupReplyHeartbeat } from "../outbound/heartbeat.js";
import {
  createTemplateCard,
  pushSurfaceUpdate,
  updateTemplateCard,
  XCardSendError,
} from "../xcard/service.js";
import {
  describeTemplate,
  getTemplate,
  listTemplates,
  prepareTemplateData,
  type FieldError,
  type XCardTemplate,
} from "../xcard/templates/index.js";
import { parseTemplateData } from "../xcard/templates/schema.js";
import { getXCardTransport } from "../xcard/transport.js";
import { extractGroupCode, json, type OpenClawPluginToolContext } from "../utils/utils.js";

const TOOL_NAME = "yuanbao_xcard_template";

const DESCRIPTION = [
  "在元宝群聊中使用插件内置模板发送交互式卡片。仅用于标准选择、表单、列表、确认和信息模板；需要自由设计卡片时使用 yuanbao_xcard_send。",
  "卡片结构由内置模板固定，你只需提供数据。流程：",
  "1) action=list_templates 查看可用模板（key + 用途）；",
  "2) action=get_template + template=<key> 查看该模板的字段要求（fields）、会回传的事件（events）和示例数据（example）；",
  "3) action=create + template=<key> + data=<按字段要求填写的 JSON 对象文本> 发送卡片。data 校验不通过时会返回具体字段错误，按 errors 修正后重试。",
  "update：surfaceId + data，data 中的顶层字段会覆盖原值后重新渲染；close 关闭卡片（按钮失效）；get 查询卡片状态与用户操作。",
  "等待策略（由你决定）：如果你接下来必须拿到用户操作才能继续本轮任务，设置 waitForAction=true，本次调用会阻塞直到用户操作或超时，结果直接作为工具返回；",
  "如果不需要立刻得到结果，不要等待，用户之后操作时会以一条 kind=yuanbao_xcard_action 的新消息唤醒你。",
  "超时（waitStatus=timeout）后卡片仍有效，不要重复发送同一张卡片。卡片发送成功即对用户可见，不要再用文字重复卡片内容。",
  "若返回 ok=false 且 retryable=false，不要重复调用 create，按返回的 note 处理（例如已自动降级为文字版）。",
].join("\n");

const PARAMETERS = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["list_templates", "get_template", "create", "update", "close", "get"],
      description: "list_templates=列出模板；get_template=查看模板字段要求；create=发送新卡片；update=更新卡片；close=关闭卡片；get=查询卡片状态。",
    },
    template: {
      type: "string",
      description: "模板 key（来自 list_templates），get_template / create 时必填。",
    },
    // A string rather than a nested object: free-form nested objects in tool arguments make
    // some providers emit malformed tool calls.
    data: {
      type: "string",
      description: "create / update 时的卡片数据：按 get_template 返回的 fields 填写的 JSON 对象文本。",
    },
    surfaceId: {
      type: "string",
      description: "卡片 ID（create 返回）。action=update/close/get 时必填；get 省略时列出本群全部卡片。",
    },
    audience: {
      type: "string",
      enum: ["requester", "anyone"],
      description: "谁可以操作：requester=仅发起本次请求的用户（默认）；anyone=群内任何人。",
    },
    waitForAction: {
      type: "boolean",
      description: "是否阻塞等待用户操作（create/update 时有效）。默认 false。",
    },
    waitTimeoutSec: {
      type: "number",
      description: `等待超时秒数，默认 ${DEFAULT_WAIT_TIMEOUT_SEC}，最大 ${MAX_WAIT_TIMEOUT_SEC}。`,
    },
  },
  required: ["action"],
} as const;

interface XCardParams {
  action?: string;
  template?: string;
  data?: unknown;
  surfaceId?: string;
  audience?: string;
  waitForAction?: boolean;
  waitTimeoutSec?: number;
}

function describeAction(r: XCardActionResult) {
  return {
    action: r.action,
    ...(r.summary ? { summary: r.summary } : {}),
    ...(Object.keys(r.context).length > 0 ? { context: r.context } : {}),
    ...(r.userMessage ? { userMessage: r.userMessage } : {}),
    ...(r.sourceComponentId ? { sourceComponentId: r.sourceComponentId } : {}),
    operatorUserId: r.operatorUserId,
    at: new Date(r.at).toISOString(),
  };
}

function describe(rec: SurfaceRecord, account: ResolvedYuanbaoAccount) {
  return {
    surfaceId: rec.surfaceId,
    template: rec.template,
    title: rec.title,
    state: rec.state,
    revision: rec.revision,
    audience: rec.audience,
    updatable: getXCardTransport(account).canUpdate(rec),
    ...(rec.lastError ? { rendererError: { code: rec.lastError.code, message: rec.lastError.message } } : {}),
    ...(rec.history?.length ? { recentActions: rec.history.map(describeAction) } : {}),
  };
}

function waitResult(outcome: WaitOutcome) {
  switch (outcome.status) {
    case "action":
      return {
        waitStatus: "action_received",
        userAction: describeAction(outcome.result),
        note: "用户已在卡片上操作，请据此继续任务；本次操作不会再以新消息重复到达。",
      };
    case "timeout":
      return {
        waitStatus: "timeout",
        note: "等待超时，卡片仍有效。可以先结束本轮回复；用户之后操作会以 kind=yuanbao_xcard_action 新消息唤醒你。",
      };
    case "cancelled":
      if (outcome.reason.startsWith("renderer_error:")) {
        return {
          waitStatus: "renderer_error",
          reason: outcome.reason,
          note: "用户客户端版本过低无法展示该卡片，卡片已关闭并已发送文字版。请让用户直接用文字回复，不要重发卡片。",
        };
      }
      return { waitStatus: "cancelled", reason: outcome.reason };
  }
}

/** Tool result for a refused card: tells the model explicitly not to retry the same card. */
function sendFailureResult(e: XCardSendError) {
  const base = { ok: false, error: e.message, failure: e.kind, retryable: false };
  if (e.kind === "rate_limited") {
    return { ...base, note: `发送被服务端限流，消息未送达。不要立即重试 ${TOOL_NAME}，请稍后再试或直接用一句简短文字回复用户。` };
  }
  if (e.kind === "too_large") {
    return { ...base, retryable: true, note: "卡片内容超过 IM 单条消息大小上限，请减少列表项数量或缩短文字后再试。" };
  }
  if (e.fallbackSent) {
    return {
      ...base,
      fallbackSent: true,
      note: `当前环境暂不支持交互卡片，已自动以文字发到群里。不要重试 ${TOOL_NAME}，也不要再重复卡片内容；请用户直接用文字回复，本轮可以结束。`,
    };
  }
  return { ...base, note: "卡片发送失败。不要重复调用 create；改用文字向用户说明。" };
}

function clampWaitMs(sec: unknown): number {
  const n = typeof sec === "number" && Number.isFinite(sec) ? sec : DEFAULT_WAIT_TIMEOUT_SEC;
  return Math.round(Math.min(Math.max(n, 5), MAX_WAIT_TIMEOUT_SEC) * 1000);
}

const unknownTemplate = (key: string | undefined) => ({
  ok: false,
  error: key ? `未知模板: ${key}` : "请指定 template",
  templates: listTemplates(),
  note: "从 templates 中选一个 key，先用 action=get_template 查看字段要求。",
});

/** Field errors plus the template's schema and example, so the model can fix data in one retry. */
function dataFailure(tpl: XCardTemplate, errors: FieldError[], warnings: string[]) {
  createLog("tools.xcard").warn("template data invalid", { template: tpl.key, errors: errors.slice(0, 5) });
  return {
    ok: false,
    error: "data 校验失败",
    errors: errors.slice(0, 20).map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)),
    ...(warnings.length ? { warnings: warnings.slice(0, 10) } : {}),
    retryable: true,
    note: "按 errors 修正 data 后重试；字段要求见 fields，可参考 example。",
    fields: tpl.fields,
    example: tpl.example,
  };
}

function parseFailure(error: string, input: unknown) {
  createLog("tools.xcard").warn("xcard input parse failed", {
    error,
    inputType: Array.isArray(input) ? "array" : typeof input,
    length: typeof input === "string" ? input.length : undefined,
  });
  return { ok: false, error, retryable: true };
}

/** Returns null outside Yuanbao group sessions. */
function createYuanbaoXCardTemplateTool(ctx: OpenClawPluginToolContext) {
  if (ctx.messageChannel !== "yuanbao") return null;
  const sessionKey = ctx.sessionKey ?? "";
  const groupCode = extractGroupCode(sessionKey);
  if (!groupCode) return null;
  const cfg = ctx.getRuntimeConfig?.() ?? ctx.runtimeConfig ?? ctx.config;
  if (!cfg) return null;
  const accountId = ctx.deliveryContext?.accountId ?? ctx.agentAccountId ?? undefined;
  const account = resolveYuanbaoAccount({ cfg, accountId });

  const log = createLog("tools.xcard");
  const requesterId = ctx.requesterSenderId ?? "";

  return {
    name: TOOL_NAME,
    label: "元宝交互卡片",
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const p = params as XCardParams;
      log.debug("execute", { toolCallId, action: p.action, template: p.template });

      if (p.action === "list_templates") return json({ ok: true, templates: listTemplates() });
      if (p.action === "get_template") {
        const tpl = p.template ? getTemplate(p.template) : undefined;
        if (!tpl) return json(unknownTemplate(p.template));
        return json({ ok: true, ...describeTemplate(tpl), note: "create 时 data 传按 fields 填写的 JSON 对象文本。" });
      }

      const wsClient = getActiveWsClient(account.accountId);
      if (!wsClient && (p.action === "create" || p.action === "update" || p.action === "close")) {
        return json({ ok: false, error: "元宝连接不可用，无法发送卡片" });
      }

      // Shared wait guard for create/update
      const maybeWait = async (rec: SurfaceRecord) => {
        if (!p.waitForAction) return {};
        if (!getXCardTransport(account).canUpdate(rec)) {
          // Server didn't return an IM id: the card isn't addressable, operations are unlikely
          // to come back, so blocking would just burn the timeout.
          return { waitDowngraded: true, note: "服务端未返回卡片消息 ID，本次不等待；如用户之后操作，会以新消息唤醒你。" };
        }
        if (hasGroupWaiter(account.accountId, groupCode)) {
          return { waitDowngraded: true, note: "本群已有卡片在等待用户操作，本次不等待；用户操作后会以新消息唤醒你。" };
        }
        const releaseHeartbeat = pauseGroupReplyHeartbeat(account.accountId, groupCode);
        try {
          const outcome = await waitForSurfaceAction(rec, clampWaitMs(p.waitTimeoutSec), signal);
          return waitResult(outcome);
        } finally {
          releaseHeartbeat();
        }
      };

      const findOwn = () => {
        const rec = p.surfaceId ? getSurface(p.surfaceId) : undefined;
        return rec
          && rec.kind === "template"
          && rec.accountId === account.accountId
          && rec.groupCode === groupCode
          ? rec
          : undefined;
      };

      const sent = async (rec: SurfaceRecord, extra: Record<string, unknown> = {}) => {
        const waited = await maybeWait(rec);
        return json({ ok: true, ...describe(getSurface(rec.surfaceId) ?? rec, account), ...extra, ...waited });
      };

      try {
        switch (p.action) {
          case "create": {
            const audience: SurfaceAudience = p.audience === "anyone" ? "anyone" : "requester";
            if (audience === "requester" && !requesterId) {
              return json({ ok: false, error: "无法确定发起用户，请使用 audience=anyone" });
            }
            const base = { account, wsClient: wsClient!, groupCode, sessionKey, ownerUserId: requesterId, audience };
            const tpl = p.template ? getTemplate(p.template) : undefined;
            if (!tpl) return json(unknownTemplate(p.template));
            const input = parseTemplateData(p.data);
            if ("error" in input) return json({ ...parseFailure(input.error, p.data), fields: tpl.fields, example: tpl.example });
            const prepared = prepareTemplateData(tpl, input.data);
            if (!prepared.ok) return json(dataFailure(tpl, prepared.errors, prepared.warnings));
            const rec = await createTemplateCard({ ...base, template: tpl, data: prepared.data });
            return sent(rec, prepared.warnings.length ? { warnings: prepared.warnings } : {});
          }

          case "update": {
            const rec = findOwn();
            if (!rec) return json({ ok: false, error: "卡片不存在或不属于当前群" });
            const tpl = rec.template ? getTemplate(rec.template) : undefined;
            if (!tpl) return json({ ok: false, error: `卡片模板已不存在: ${rec.template}` });
            const input = parseTemplateData(p.data);
            if ("error" in input) return json(parseFailure(input.error, p.data));
            // Shallow merge: top-level fields in data replace the card's current values
            const prepared = prepareTemplateData(tpl, { ...structuredClone(rec.data), ...input.data });
            if (!prepared.ok) return json(dataFailure(tpl, prepared.errors, prepared.warnings));
            const err = await withSurfaceLock(rec.surfaceId, async () => {
              if (rec.state !== "active") return `卡片已是 ${rec.state} 状态，不能更新`;
              try {
                await updateTemplateCard(rec, tpl, prepared.data, account, wsClient!);
              } catch (e) {
                return e instanceof Error ? e.message : String(e);
              }
              return null;
            });
            if (err) return json({ ok: false, error: err });
            return sent(rec, prepared.warnings.length ? { warnings: prepared.warnings } : {});
          }

          case "close": {
            const rec = findOwn();
            if (!rec) return json({ ok: false, error: "卡片不存在或不属于当前群" });
            const err = await withSurfaceLock(rec.surfaceId, async () => {
              if (rec.state !== "active") return null;
              rec.state = rec.lastResult ? "completed" : "cancelled";
              try {
                await pushSurfaceUpdate(rec, account, wsClient!);
              } catch (e) {
                return e instanceof Error ? e.message : String(e);
              }
              return null;
            });
            return json({ ok: !err, ...describe(rec, account), ...(err ? { warning: `卡片已关闭，但界面刷新失败: ${err}` } : {}) });
          }

          case "get": {
            if (p.surfaceId) {
              const rec = findOwn();
              if (!rec) return json({ ok: false, error: "卡片不存在或已过期" });
              return json({ ok: true, ...describe(rec, account) });
            }
            return json({
              ok: true,
              cards: listSurfaces(account.accountId, groupCode)
                .filter((rec) => rec.kind === "template")
                .map((rec) => describe(rec, account)),
            });
          }

          default:
            return json({
              ok: false,
              error: `不支持的 action: ${String(p.action)}。可选 list_templates/get_template/create/update/close/get`,
            });
        }
      } catch (e) {
        log.error("xcard tool failed", { action: p.action, error: String(e) });
        if (e instanceof XCardSendError) return json(sendFailureResult(e));
        return json({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}

export function registerXCardTools(api: OpenClawPluginApi): void {
  const log = createLog("tools.xcard");
  log.info("register tool", { name: TOOL_NAME, optional: false });
  api.registerTool(createYuanbaoXCardTemplateTool, { name: TOOL_NAME, optional: false });
}
