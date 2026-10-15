/**
 * Handling of xCard event submits (a user operated an xCard, or its renderer failed).
 *
 * Entry point: extend_type=102 upevent group/direct messages are normalized by transport-im1007.ts,
 * then validated and handled here. Receipts go back as extend_type=103 downevents.
 *
 * Flow:
 *   decode → (surface lock) validate → ONE receipt (accepted / rejected / unknown) → apply
 *   quota/state → close (once) or bump revision (perRevision) → deliver.
 * The receipt only says whether the operation was accepted; the proxy completes the App's
 * Submit with it. Results always reach the user through IM (card update / replies), never
 * through a second receipt. The settled status is cached per request so a duplicate submit
 * replays it (completed / failed may appear there).
 *
 * Delivery has two paths, decided at accept time:
 * - a tool call is blocked waiting on this surface (`waitForAction`): resolve it directly,
 *   WITHOUT the session queue — that tool call is running inside the queued turn, so queueing
 *   would deadlock until the wait times out;
 * - otherwise wake the originating IM session as a new turn via its serial session queue
 *   (serialized behind any in-flight reply), using the reduced xCard pipeline.
 *
 * Trust: operator / bot / conversation / replyToken come from the push's trusted envelope (derived by
 * the proxy from the authenticated connection), or for im1007 from the IM sender / group of the
 * upevent message. The payload is App-supplied and only used for
 * requestId / surfaceId / binding / action, all of which are checked against the registry.
 *
 * Cards accept only their template's own event names; the template's `decideAction` checks the
 * context (e.g. the option exists) and produces the trusted summary + context handed to the
 * model. mode=once templates close on the first accepted operation unless the template asks to
 * keep the card open (e.g. a form submitted with required fields missing); mode=perRevision
 * accepts one operation per revision, and the card is re-sent at revision+1 to take the next.
 *
 * `payload.event` is the renderer's A2UI v1.0 message: `{version, action}` for a user
 * operation, or `{version, error:{code, surfaceId, message}}` for a renderer failure.
 * MIN_RENDERER_VERSION_NOT_SATISFIED means the client cannot show the card at all: the card is
 * cancelled, its plain-text fallback is posted and a waiting tool call ends with that error.
 * Other renderer errors are only recorded (visible via action=get).
 *
 * Reject reasons are stable machine codes from the client contract (permission_denied,
 * stale_revision, epoch_expired, surface_closed, invalid_action, invalid_context, ...).
 */

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { YuanbaoWsClient } from "../../access/ws/client.js";
import type { WsXCardReceiptStatus, WsXCardTrusted } from "../../access/ws/types.js";
import {
  buildPipelineContext,
  enqueueSessionTask,
  onGroupAbort,
} from "../../dispatcher/debouncer/index.js";
import { createLog } from "../../logger.js";
import type { ResolvedYuanbaoAccount, YuanbaoInboundMessage } from "../../types.js";
import { createXCardEventPipeline } from "../pipeline/create.js";
import type { DebouncerItem } from "../pipeline/types.js";
import { MIN_RENDERER_VERSION_ERROR, XCARD_EVENT_PROTOCOL } from "./constants.js";
import {
  cancelGroupWaiters,
  cancelWaiter,
  getSurface,
  PLUGIN_EPOCH,
  recordAcceptedAction,
  rememberRequest,
  rememberUserMessageEcho,
  requestKey,
  resolveWaiter,
  withSurfaceLock,
  type SurfaceRecord,
  type XCardActionResult,
} from "./registry.js";
import { pushSurfaceUpdate, sendConversationText } from "./service.js";
import { getTemplate } from "./templates/index.js";
import { getXCardTransport } from "./transport.js";

const log = createLog("xcard.event");
const xcardPipeline = createXCardEventPipeline();

// Owner /stop in a group also cancels tool calls waiting on that group's cards
onGroupAbort((accountId, groupCode) => {
  const n = cancelGroupWaiters(accountId, groupCode, "stopped");
  if (n > 0) log.info("cancelled xcard waiters on /stop", { accountId, groupCode, count: n });
});

interface XCardEventPayload {
  protocol?: string;
  requestId?: string;
  targetBotId?: string;
  surfaceId?: string;
  binding?: { pluginEpoch?: string; revision?: number; groupCode?: string; messageId?: string; messageSeq?: string };
  event?: {
    version?: string;
    action?: {
      name?: string;
      surfaceId?: string;
      sourceComponentId?: string;
      timestamp?: string;
      userMessage?: string;
      trigger?: string;
      context?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    };
    error?: {
      code?: string;
      surfaceId?: string;
      message?: string;
      path?: string;
    };
  };
}

const MAX_NAME_LEN = 64;

export interface XCardEventDeps {
  account: ResolvedYuanbaoAccount;
  config: OpenClawConfig;
  core?: PluginRuntime;
  wsClient: YuanbaoWsClient;
  log?: DebouncerItem["log"];
  statusSink?: DebouncerItem["statusSink"];
  abortSignal?: AbortSignal;
}

type Decision =
  | { kind: "reject"; status: WsXCardReceiptStatus; reason: string; rec?: SurfaceRecord }
  | { kind: "replay"; status: string; reason?: string; rec: SurfaceRecord }
  | { kind: "accept"; rec: SurfaceRecord; result: XCardActionResult; keepOpen: boolean };

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Request identity shared by validation, dedupe and the receipt */
interface SubmitRef {
  requestId: string;
  surfaceId: string;
  cardMessageId?: string;
  /** Revision the App bound the request to */
  revision?: number;
  trusted: WsXCardTrusted;
}

async function sendReceipt(
  deps: XCardEventDeps,
  ref: SubmitRef,
  p: { status: WsXCardReceiptStatus; reason?: string; currentRevision?: number },
): Promise<void> {
  const revision = ref.revision ?? p.currentRevision;
  try {
    const transport = getXCardTransport(deps.account);
    const target = {
      replyToken: ref.trusted.replyToken,
      isGroup: ref.trusted.isGroup,
      groupCode: ref.trusted.groupCode,
      ...(ref.cardMessageId ? { cardMessageId: ref.cardMessageId } : {}),
    };
    const rsp = await transport.sendReceipt({ account: deps.account, wsClient: deps.wsClient }, target, {
      requestId: ref.requestId,
      surfaceId: ref.surfaceId,
      pluginEpoch: PLUGIN_EPOCH,
      ...(revision !== undefined ? { revision } : {}),
      ...(p.currentRevision !== undefined ? { currentRevision: p.currentRevision } : {}),
      status: p.status,
      reason: p.reason ?? "",
    });
    if (rsp.code !== 0) log.warn("receipt rejected by server", { requestId: ref.requestId, code: rsp.code });
  } catch (err) {
    log.warn("receipt send failed", { requestId: ref.requestId, status: p.status, error: String(err) });
  }
}

/** Validate an operation against the registry; must run under the surface lock. */
function decide(rec: SurfaceRecord | undefined, ref: SubmitRef, payload: XCardEventPayload): Decision {
  if (!rec) return { kind: "reject", status: "unknown", reason: "unknown_surface" };

  const prior = rec.seenRequests.get(requestKey(ref.trusted.operatorUserId, ref.requestId));
  if (prior) return { kind: "replay", status: prior.status, reason: prior.reason, rec };

  const reject = (reason: string, status: WsXCardReceiptStatus = "rejected"): Decision => ({
    kind: "reject", status, reason, rec,
  });
  if (ref.trusted.isGroup !== rec.isGroup || ref.trusted.groupCode !== rec.groupCode) {
    return reject("permission_denied");
  }
  if (rec.state === "expired") return reject("surface_expired");
  if (rec.state !== "active") return reject("surface_closed");
  if (rec.audience === "requester" && ref.trusted.operatorUserId !== rec.ownerUserId) return reject("permission_denied");

  if (ref.revision !== undefined && ref.revision !== rec.revision) return reject("stale_revision");
  // once cards are closed after their accepted operation; this covers a perRevision card whose
  // current revision was consumed but not yet re-sent (e.g. the refresh failed)
  if (rec.acceptedRevisions.has(rec.revision)) return reject("stale_revision");

  const action = payload.event?.action;
  const name = typeof action?.name === "string" ? action.name.trim() : "";
  if (!action || !name || name.length > MAX_NAME_LEN) return reject("invalid_action");
  const context = isObj(action.context) ? action.context : {};
  const common = {
    requestId: ref.requestId,
    operatorUserId: ref.trusted.operatorUserId,
    action: name,
    context,
    ...(typeof action.userMessage === "string" && action.userMessage.trim() ? { userMessage: action.userMessage.trim() } : {}),
    ...(typeof action.sourceComponentId === "string" ? { sourceComponentId: action.sourceComponentId } : {}),
    trigger: typeof action.trigger === "string" && action.trigger ? action.trigger : "click",
    revision: rec.revision,
    at: Date.now(),
  };

  if (rec.kind === "generated") {
    if (!(rec.actions ?? []).includes(name)) return reject("invalid_action");
    return {
      kind: "accept",
      rec,
      result: {
        ...common,
        summary: typeof common.userMessage === "string"
          ? common.userMessage
          : `触发了事件「${name}」`,
      },
      keepOpen: false,
    };
  }

  const tpl = rec.template ? getTemplate(rec.template) : undefined;
  if (!tpl || !(name in tpl.events)) return reject("invalid_action");
  const verdict = tpl.decideAction(rec.data, name, context);
  if ("reject" in verdict) return reject(verdict.reject);
  return {
    kind: "accept",
    rec,
    result: { ...common, context: verdict.context, summary: verdict.summary },
    keepOpen: verdict.keepOpen === true,
  };
}

/** Body handed to the model when an operation wakes the session as a new turn. */
export function buildXCardActionBody(rec: SurfaceRecord, result: XCardActionResult): string {
  const data = {
    kind: "yuanbao_xcard_action",
    surfaceId: rec.surfaceId,
    source: rec.kind,
    ...(rec.template ? { template: rec.template } : {}),
    title: rec.title,
    action: result.action,
    summary: result.summary,
    context: result.context,
    operatorUserId: result.operatorUserId,
    revision: result.revision,
    cardState: rec.state,
  };
  const tail = rec.state === "active"
    ? rec.kind === "template"
      ? "卡片仍可操作，如需反馈可用 yuanbao_xcard_template action=update 更新它。"
      : `卡片仍可操作；如需改变棋盘、选项、进度或其他业务内容，必须调用 yuanbao_xcard_update 更新原 surfaceId=${rec.surfaceId}，不要再次调用 yuanbao_xcard_send 创建新卡。`
    : "卡片已关闭。";
  return [
    `[xCard 操作回调] 用户在你之前发送的卡片「${rec.title}」上${result.summary ?? `触发了事件「${result.action}」`}。`,
    `这是卡片点击产生的结构化事件，不是用户输入的文字；请基于该操作继续之前的任务（若之前在等待用户决策）。${tail}`,
    JSON.stringify(data),
  ].join("\n");
}

let lastWakeSeq = 0;
/** Strictly increasing per process, so two events in the same millisecond never share a MessageSid. */
function nextWakeSeq(at: number): number {
  lastWakeSeq = Math.max(at, lastWakeSeq + 1);
  return lastWakeSeq;
}

async function runWakeTurn(
  deps: XCardEventDeps,
  rec: SurfaceRecord,
  result: XCardActionResult,
): Promise<"ok" | "superseded"> {
  const core = deps.core;
  if (!core) throw new Error("PluginRuntime not provided");
  const body = buildXCardActionBody(rec, result);
  const msg: YuanbaoInboundMessage = {
    from_account: result.operatorUserId,
    ...(rec.isGroup ? { group_code: rec.groupCode } : {}),
    // The host dedupes inbound turns by MessageSid (msg_id ?? msg_seq), so every card event gets
    // a unique synthetic sequence.
    msg_seq: nextWakeSeq(result.at),
    msg_time: Math.floor(result.at / 1000),
    msg_body: [{ msg_type: "TIMTextElem", msg_content: { text: body } }],
  };
  const item: DebouncerItem = {
    msg,
    isGroup: rec.isGroup,
    account: deps.account,
    config: deps.config,
    core,
    wsClient: deps.wsClient,
    log: deps.log,
    statusSink: deps.statusSink,
    abortSignal: deps.abortSignal,
  };

  // SessionQueue swallows task errors and silently skips tasks invalidated by owner /stop,
  // so outcome is tracked here to pick the right final receipt.
  let ran = false;
  let failure: unknown;
  await enqueueSessionTask(deps.account.accountId, rec.isGroup, rec.groupCode, async () => {
    ran = true;
    try {
      const ctx = buildPipelineContext(item, [item]);
      ctx.fromAccount = result.operatorUserId;
      ctx.groupCode = rec.isGroup ? rec.groupCode : undefined;
      ctx.rawBody = body;
      ctx.rewrittenBody = body;
      ctx.isAtBot = true;
      ctx.effectiveWasMentioned = true;
      await xcardPipeline.execute(ctx);
    } catch (err) {
      failure = err;
    }
  });
  if (!ran) return "superseded";
  if (failure) throw failure;
  return "ok";
}

async function handleRendererError(
  deps: XCardEventDeps,
  ref: SubmitRef,
  error: NonNullable<NonNullable<XCardEventPayload["event"]>["error"]>,
): Promise<void> {
  await withSurfaceLock(ref.surfaceId, async () => {
    const rec = getSurface(ref.surfaceId);
    if (!rec) return;
    const key = requestKey(ref.trusted.operatorUserId, ref.requestId);
    const prior = rec.seenRequests.get(key);
    if (prior) {
      await sendReceipt(deps, ref, { status: prior.status as WsXCardReceiptStatus, reason: prior.reason, currentRevision: rec.revision });
      return;
    }
    const code = typeof error.code === "string" && error.code ? error.code : "UNKNOWN";
    const message = typeof error.message === "string" ? error.message.slice(0, 500) : "";
    rec.lastError = { code, message, at: Date.now() };
    log.warn("xcard renderer error", { surfaceId: ref.surfaceId, code, message, path: error.path, operator: ref.trusted.operatorUserId });
    rememberRequest(rec, key, "accepted");
    await sendReceipt(deps, ref, { status: "accepted", currentRevision: rec.revision });

    if (code === MIN_RENDERER_VERSION_ERROR && rec.state === "active") {
      rec.state = "cancelled";
      cancelWaiter(rec, `renderer_error:${code}`);
      try {
        await pushSurfaceUpdate(rec, deps.account, deps.wsClient);
      } catch (err) {
        log.warn("close-on-renderer-error update failed", { surfaceId: ref.surfaceId, error: String(err) });
      }
      await sendConversationText(deps.account, deps.wsClient, rec.isGroup, rec.groupCode, rec.fallbackText);
    }
    rememberRequest(rec, key, "completed");
  });
}

/**
 * Entry from the WS gateway for an upevent IM message. The operator
 * is the IM sender; there is no reply token — the receipt is a downevent into the same conversation.
 * Never throws.
 */
export async function handleXCardUpEvent(
  msg: YuanbaoInboundMessage,
  payload: Record<string, unknown>,
  deps: XCardEventDeps,
  isGroup = Boolean(msg.group_code),
): Promise<void> {
  const conversationId = isGroup ? msg.group_code : msg.from_account;
  const trusted: WsXCardTrusted = {
    operatorUserId: msg.from_account ?? "",
    botId: deps.account.botId ?? "",
    isGroup,
    groupCode: conversationId ?? "",
    pluginEpoch: "",
    replyToken: "",
  };
  if (!trusted.operatorUserId || !trusted.groupCode) {
    log.warn("xcard upevent without sender/conversation, dropped");
    return;
  }
  await handleXCardSubmit(payload as XCardEventPayload, trusted, deps);
}

async function handleXCardSubmit(payload: XCardEventPayload, trusted: WsXCardTrusted, deps: XCardEventDeps): Promise<void> {
  const rendererError = isObj(payload.event?.error) ? payload.event.error : undefined;
  const innerSurfaceId = rendererError ? rendererError.surfaceId : payload.event?.action?.surfaceId;
  const surfaceId = typeof payload.surfaceId === "string" && payload.surfaceId ? payload.surfaceId : innerSurfaceId;
  const ref: SubmitRef = {
    requestId: typeof payload.requestId === "string" ? payload.requestId : "",
    surfaceId: typeof surfaceId === "string" ? surfaceId : "",
    ...(typeof payload.binding?.messageId === "string" && payload.binding.messageId
      ? { cardMessageId: payload.binding.messageId }
      : {}),
    ...(typeof payload.binding?.revision === "number" ? { revision: payload.binding.revision } : {}),
    trusted,
  };

  const hasOneEvent = Boolean(rendererError) !== Boolean(payload.event?.action);
  if (
    payload.protocol !== XCARD_EVENT_PROTOCOL ||
    !ref.requestId ||
    !ref.surfaceId ||
    !hasOneEvent ||
    (innerSurfaceId !== undefined && innerSurfaceId !== ref.surfaceId)
  ) {
    await sendReceipt(deps, ref, { status: "rejected", reason: "invalid_payload" });
    return;
  }
  const botId = deps.account.botId;
  if (botId && trusted.botId && trusted.botId !== botId) {
    await sendReceipt(deps, ref, { status: "rejected", reason: "permission_denied" });
    return;
  }
  // Cards from a previous plugin process: never re-bind them to a new session
  const epochs = [payload.binding?.pluginEpoch, trusted.pluginEpoch].filter(Boolean);
  if (epochs.some((e) => e !== PLUGIN_EPOCH)) {
    await sendReceipt(deps, ref, { status: "rejected", reason: "epoch_expired" });
    return;
  }
  const known = getSurface(ref.surfaceId);
  if (!known || known.accountId !== deps.account.accountId) {
    await sendReceipt(deps, ref, { status: "unknown", reason: "unknown_surface" });
    return;
  }
  if (known.cardMessageId && ref.cardMessageId && known.cardMessageId !== ref.cardMessageId) {
    await sendReceipt(deps, ref, { status: "rejected", reason: "invalid_payload", currentRevision: known.revision });
    return;
  }
  if (rendererError) {
    // Renderer errors can cancel a surface and trigger a fallback, so bind them to the same
    // authenticated conversation as normal actions before mutating any card state.
    if (trusted.isGroup !== known.isGroup || trusted.groupCode !== known.groupCode) {
      await sendReceipt(deps, ref, {
        status: "rejected",
        reason: "permission_denied",
        currentRevision: known.revision,
      });
      return;
    }
    if (known.audience === "requester" && trusted.operatorUserId !== known.ownerUserId) {
      await sendReceipt(deps, ref, { status: "rejected", reason: "permission_denied", currentRevision: known.revision });
      return;
    }
    if (!known.cardMessageId && ref.cardMessageId) known.cardMessageId = ref.cardMessageId;
    await handleRendererError(deps, ref, rendererError);
    return;
  }

  const key = requestKey(trusted.operatorUserId, ref.requestId);
  const accepted = await withSurfaceLock(ref.surfaceId, async () => {
    const d = decide(getSurface(ref.surfaceId), ref, payload);
    if (d.kind === "replay") {
      await sendReceipt(deps, ref, { status: d.status as WsXCardReceiptStatus, reason: d.reason, currentRevision: d.rec.revision });
      return null;
    }
    if (d.kind === "reject") {
      if (d.rec) rememberRequest(d.rec, key, d.status, d.reason);
      log.info("xcard event rejected", { surfaceId: ref.surfaceId, requestId: ref.requestId, reason: d.reason });
      await sendReceipt(deps, ref, { status: d.status, reason: d.reason, ...(d.rec ? { currentRevision: d.rec.revision } : {}) });
      return null;
    }

    const { rec, result, keepOpen } = d;
    // The send-group response does not expose the server IM id. Bind it only after the event has
    // passed permission/revision/action validation; rejected events must not poison the Surface.
    if (!rec.cardMessageId && ref.cardMessageId) rec.cardMessageId = ref.cardMessageId;
    // A kept-open once-mode card must stay answerable at the same revision
    if (!keepOpen) rec.acceptedRevisions.add(rec.revision);
    recordAcceptedAction(rec, result);
    if (result.userMessage) {
    rememberUserMessageEcho(rec.accountId, rec.isGroup, rec.groupCode, result.operatorUserId, result.userMessage);
    }
    rememberRequest(rec, key, "accepted");
    await sendReceipt(deps, ref, { status: "accepted", currentRevision: rec.revision });

    // once: close; perRevision: re-send at revision+1 so the next operation can be accepted
    if (!keepOpen) {
      if (rec.mode === "once") rec.state = "completed";
      try {
        await pushSurfaceUpdate(rec, deps.account, deps.wsClient);
      } catch (err) {
        // A once card stays logically closed; a perRevision card stays on the consumed
        // revision (further clicks get stale_revision) until the model updates it
        log.warn("post-accept card update failed", { surfaceId: ref.surfaceId, mode: rec.mode, error: String(err) });
      }
    }
    // Decide the delivery path atomically with acceptance
    const delivered = resolveWaiter(rec, result);
    return { rec, result, delivered };
  });
  if (!accepted) return;

  const { rec, result, delivered } = accepted;
  log.info("xcard event accepted", {
    surfaceId: ref.surfaceId,
    requestId: ref.requestId,
    action: result.action,
    summary: result.summary,
    path: delivered ? "waiter" : "wake",
  });
  if (delivered) {
    rememberRequest(rec, key, "completed");
    return;
  }

  try {
    const outcome = await runWakeTurn(deps, rec, result);
    if (outcome === "superseded") {
      log.info("xcard wake turn skipped (session superseded)", { surfaceId: ref.surfaceId, requestId: ref.requestId });
      rememberRequest(rec, key, "failed", "session_reset");
      return;
    }
    rememberRequest(rec, key, "completed");
  } catch (err) {
    log.error("xcard wake turn failed", { surfaceId: ref.surfaceId, error: String(err) });
    rememberRequest(rec, key, "failed", "dispatch_failed");
  }
}
