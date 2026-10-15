/**
 * xCard card lifecycle: create (TIMCustomElem card message, text fallback on failure), incremental
 * updates of the existing Surface, and close.
 *
 * Wire contract:
 * - create: a normal send_group_message whose msg_body is a single TIMCustomElem; the IM
 *   protocol itself is not extended.
 * - update/close: the card is re-rendered with revision+1, then its createSurface message is
 *   removed and the remaining updateComponents/updateDataModel messages are sent as a
 *   client-addressed downevent. Both card and update bodies are held to
 *   MAX_CARD_CONTENT_BYTES.
 * - The card is sent first. Only when the server refuses it (e.g. 10002 "消息体为空" while the
 *   backend whitelist is not enabled) is the plain-text version sent instead, at most once per
 *   identical text per group within FALLBACK_DEDUPE_MS, so model retries don't spam the group.
 * - The server can answer `code: 0` with message "bot rate limited": the message was dropped,
 *   so it is treated as a failure (and no fallback is sent — that would be dropped as well).
 *
 * Cards are built from templates (templates/): the model supplies data only; every render
 * rebuilds the messages from the template + data + state (closed flag, last accepted operation).
 */

import { randomUUID } from "node:crypto";
import type { YuanbaoWsClient } from "../../access/ws/client.js";
import type { WsSendMessageResponse } from "../../access/ws/types.js";
import { createLog } from "../../logger.js";
import type { ResolvedYuanbaoAccount, YuanbaoMsgBodyElement } from "../../types.js";
import { MAX_CARD_CONTENT_BYTES, SURFACE_TTL_MS } from "./constants.js";
import {
  PLUGIN_EPOCH,
  registerSurface,
  type SurfaceAudience,
  type SurfaceMode,
  type SurfaceRecord,
} from "./registry.js";
import { extractGeneratedActions, renderGeneratedMessages } from "./generated.js";
import { buildTemplateMessages } from "./templates/builder.js";
import { getTemplate, type TemplateData, type XCardTemplate } from "./templates/index.js";
import { getXCardTransport, type XCardTransport } from "./transport.js";
import type { A2uiMessage } from "./validate.js";

const log = createLog("xcard");

const RATE_LIMITED_RE = /rate\s*limit/i;
const FALLBACK_DEDUPE_MS = 5 * 60_000;
/** `${accountId}:${groupCode}:${fallbackText}` → sentAt */
const recentFallbacks = new Map<string, number>();

export type XCardFailureKind = "rate_limited" | "rejected" | "too_large" | "error";

export class XCardSendError extends Error {
  readonly kind: XCardFailureKind;
  /** Plain-text version of the card was delivered instead */
  readonly fallbackSent: boolean;
  constructor(message: string, kind: XCardFailureKind = "error", fallbackSent = false) {
    super(message);
    this.kind = kind;
    this.fallbackSent = fallbackSent;
  }
}

/** Classify a send/update response; `code: 0` + "rate limited" means the message was dropped. */
export function classifySendRsp(rsp: WsSendMessageResponse): { ok: true } | { ok: false; kind: XCardFailureKind; message: string } {
  if (rsp.code !== 0) return { ok: false, kind: "rejected", message: rsp.message || `code ${rsp.code}` };
  if (RATE_LIMITED_RE.test(rsp.message ?? "")) return { ok: false, kind: "rate_limited", message: rsp.message };
  return { ok: true };
}

type ExtensionSource = Pick<SurfaceRecord,
  "kind" | "template" | "actions" | "revision" | "ownerUserId" | "audience" | "mode" | "state" | "fallbackText">;

/** Event names + context keys a template card can emit (for server-side checks / receipts). */
function actionSchemas(tpl: XCardTemplate): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(tpl.events).map(([name, spec]) => [
      name,
      { type: "object", properties: Object.fromEntries(Object.keys(spec.context).map((k) => [k, {}])) },
    ]),
  );
}

function buildExtension(rec: ExtensionSource, tpl?: XCardTemplate): Record<string, unknown> {
  return {
    schemaVersion: 1,
    pluginEpoch: PLUGIN_EPOCH,
    revision: rec.revision,
    ownerUserId: rec.ownerUserId,
    audience: rec.audience,
    mode: rec.mode,
    state: rec.state,
    fallbackText: rec.fallbackText,
    eventTransport: "openclaw",
    source: rec.kind,
    ...(rec.template ? { template: rec.template } : {}),
    actionSchemas: tpl
      ? actionSchemas(tpl)
      : Object.fromEntries((rec.actions ?? []).map((name) => [name, { type: "object" }])),
  };
}

/** Full A2UI message list for the current state of a surface. */
export function renderSurfaceMessages(rec: SurfaceRecord): A2uiMessage[] {
  if (rec.kind === "generated") {
    if (!rec.messages) throw new Error("generated xcard has no messages");
    return renderGeneratedMessages(rec.messages, rec.surfaceId, buildExtension(rec), {
      state: rec.state,
      revision: rec.revision,
      ...(rec.lastResult ? { lastResult: rec.lastResult } : {}),
    });
  }
  const tpl = rec.template ? getTemplate(rec.template) : undefined;
  if (!tpl) throw new Error(`unknown xcard template: ${rec.template}`);
  const ext = buildExtension(rec, tpl);
  return buildTemplateMessages(tpl, rec.data, { closed: rec.state !== "active", last: rec.lastResult }, rec.surfaceId, ext);
}

/** Existing Surfaces accept updates, not a second createSurface for the same id. */
export function renderSurfaceUpdateMessages(rec: SurfaceRecord): A2uiMessage[] {
  return renderSurfaceMessages(rec).filter((message) => !message.createSurface);
}

/** Throws too_large when the custom elem payload would not fit in one IM packet. */
function checkCardSize(body: YuanbaoMsgBodyElement[]): YuanbaoMsgBodyElement[] {
  const data = body[0]?.msg_content.data;
  const bytes = typeof data === "string" ? Buffer.byteLength(data, "utf8") : 0;
  if (bytes > MAX_CARD_CONTENT_BYTES) {
    throw new XCardSendError(`卡片内容过大（${bytes} 字节，上限 ${MAX_CARD_CONTENT_BYTES}）`, "too_large");
  }
  return body;
}

/** msg_body creating the card for the current state of `rec`. */
export function renderSurface(rec: SurfaceRecord, transport: XCardTransport): YuanbaoMsgBodyElement[] {
  return checkCardSize(transport.cardBody(rec.title, renderSurfaceMessages(rec)));
}

function textBody(text: string): YuanbaoMsgBodyElement[] {
  return [{ msg_type: "TIMTextElem", msg_content: { text } }];
}

function sendConversationMessage(
  account: ResolvedYuanbaoAccount,
  wsClient: YuanbaoWsClient,
  isGroup: boolean,
  targetId: string,
  body: YuanbaoMsgBodyElement[],
): Promise<WsSendMessageResponse> {
  if (!isGroup) {
    return wsClient.sendC2CMessage({
      to_account: targetId,
      from_account: account.botId ?? "",
      msg_random: Math.floor(Math.random() * 4294967295),
      msg_body: body,
    });
  }
  return wsClient.sendGroupMessage({
    group_code: targetId,
    from_account: account.botId ?? "",
    random: String(Math.floor(Math.random() * 4294967295)),
    msg_body: body,
  });
}

/** Send plain-text fallback into the card's conversation. */
export async function sendConversationText(
  account: ResolvedYuanbaoAccount,
  wsClient: YuanbaoWsClient,
  isGroup: boolean,
  targetId: string,
  text: string,
): Promise<boolean> {
  const key = `${account.accountId}:${isGroup ? "group" : "direct"}:${targetId}:${text}`;
  const now = Date.now();
  for (const [k, at] of recentFallbacks) if (now - at > FALLBACK_DEDUPE_MS) recentFallbacks.delete(k);
  if (recentFallbacks.has(key)) return true;
  try {
    const rsp = await sendConversationMessage(account, wsClient, isGroup, targetId, textBody(text));
    const res = classifySendRsp(rsp);
    if (!res.ok) {
      log.warn("text fallback send failed", { kind: res.kind, message: res.message });
      return false;
    }
    recentFallbacks.set(key, now);
    return true;
  } catch (err) {
    log.warn("text fallback send error", { error: String(err) });
    return false;
  }
}

interface CreateBaseParams {
  account: ResolvedYuanbaoAccount;
  wsClient: YuanbaoWsClient;
  groupCode: string;
  isGroup?: boolean;
  sessionKey: string;
  ownerUserId: string;
  mode: SurfaceMode;
  audience: SurfaceAudience;
}

export interface CreateTemplateCardParams extends Omit<CreateBaseParams, "mode"> {
  template: XCardTemplate;
  /** Already validated by prepareTemplateData */
  data: TemplateData;
}

export interface CreateGeneratedCardParams extends CreateBaseParams {
  title: string;
  fallbackText: string;
  messages: A2uiMessage[];
}

type CreateDraft = Omit<SurfaceRecord, "state" | "createdAt" | "expiresAt" | "acceptedRevisions" | "seenRequests">;

async function sendCard(p: CreateBaseParams, draft: CreateDraft): Promise<SurfaceRecord> {
  const transport = getXCardTransport(p.account);
  const body = renderSurface({ ...draft, state: "active" } as SurfaceRecord, transport);

  let rsp: WsSendMessageResponse;
  try {
    rsp = await sendConversationMessage(p.account, p.wsClient, p.isGroup !== false, p.groupCode, body);
  } catch (err) {
    throw new XCardSendError(`卡片发送失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  const res = classifySendRsp(rsp);
  if (!res.ok) {
    log.warn("card send failed", { surfaceId: draft.surfaceId, kind: res.kind, code: rsp.code, message: res.message });
    const fallbackSent = res.kind === "rejected"
      ? await sendConversationText(p.account, p.wsClient, p.isGroup !== false, p.groupCode, draft.fallbackText)
      : false;
    throw new XCardSendError(`卡片发送失败: ${res.message}`, res.kind, fallbackSent);
  }
  const rec = registerSurface(draft);
  log.info("card created", {
    surfaceId: rec.surfaceId,
    template: rec.template,
    groupCode: p.groupCode,
  });
  return rec;
}

function baseDraft(p: CreateBaseParams) {
  return {
    surfaceId: randomUUID(),
    accountId: p.account.accountId,
    isGroup: p.isGroup !== false,
    groupCode: p.groupCode,
    sessionKey: p.sessionKey,
    ownerUserId: p.ownerUserId,
    audience: p.audience,
    mode: p.mode,
    revision: 1,
  };
}

export async function createTemplateCard(p: CreateTemplateCardParams): Promise<SurfaceRecord> {
  const q = { ...p, mode: p.template.mode };
  return sendCard(q, {
    ...baseDraft(q),
    kind: "template",
    template: p.template.key,
    title: p.template.title(p.data),
    data: p.data,
    fallbackText: p.template.fallbackText(p.data),
  });
}

/** Send a self-contained Inline Surface authored by the xcard-generator Skill. */
export async function createGeneratedCard(p: CreateGeneratedCardParams): Promise<SurfaceRecord> {
  const actions = extractGeneratedActions(p.messages);
  return sendCard(p, {
    ...baseDraft(p),
    kind: "generated",
    data: {},
    messages: structuredClone(p.messages),
    actions,
    title: p.title,
    fallbackText: p.fallbackText,
  });
}

/**
 * Replace an AI-authored card's complete source bundle and update the existing client Surface.
 * The createSurface message remains in the stored bundle for validation/rendering, but is omitted
 * from the 103 state update by pushSurfaceUpdate.
 */
export async function updateGeneratedCard(
  rec: SurfaceRecord,
  messages: A2uiMessage[],
  title: string,
  fallbackText: string,
  account: ResolvedYuanbaoAccount,
  wsClient: YuanbaoWsClient,
): Promise<void> {
  const prev = {
    messages: rec.messages,
    actions: rec.actions,
    title: rec.title,
    fallbackText: rec.fallbackText,
  };
  rec.messages = structuredClone(messages);
  rec.actions = extractGeneratedActions(messages);
  rec.title = title;
  rec.fallbackText = fallbackText;
  try {
    await pushSurfaceUpdate(rec, account, wsClient);
  } catch (err) {
    Object.assign(rec, prev);
    throw err;
  }
}

/**
 * Replace a template card's data (already validated) and push; data/title/fallback are restored
 * on failure. Caller holds the surface lock.
 */
export async function updateTemplateCard(
  rec: SurfaceRecord,
  tpl: XCardTemplate,
  data: TemplateData,
  account: ResolvedYuanbaoAccount,
  wsClient: YuanbaoWsClient,
): Promise<void> {
  const prev = { data: rec.data, title: rec.title, fallbackText: rec.fallbackText };
  rec.data = data;
  rec.title = tpl.title(data);
  rec.fallbackText = tpl.fallbackText(data);
  try {
    await pushSurfaceUpdate(rec, account, wsClient);
  } catch (err) {
    Object.assign(rec, prev);
    throw err;
  }
}

/**
 * Re-render the card with revision+1 and update its existing client Surface. Caller holds the
 * surface lock and has already applied the state change (data / state / last result) to `rec`;
 * on failure the revision bump is rolled back (state rollback is the
 * caller's job).
 */
export async function pushSurfaceUpdate(
  rec: SurfaceRecord,
  account: ResolvedYuanbaoAccount,
  wsClient: YuanbaoWsClient,
): Promise<void> {
  const transport = getXCardTransport(account);
  if (!transport.canUpdate(rec)) throw new XCardSendError("该卡片缺少服务端 msg_id，无法更新");
  rec.revision += 1;
  try {
    const body = checkCardSize(transport.updateBody(rec, renderSurfaceUpdateMessages(rec)));
    const rsp = await transport.sendUpdate({ account, wsClient }, rec, body);
    const res = classifySendRsp(rsp);
    if (!res.ok) throw new XCardSendError(`卡片更新失败: ${res.message}`, res.kind);
    // Active multi-interaction cards get a fresh validity window after every successful update.
    if (rec.state === "active") rec.expiresAt = Date.now() + SURFACE_TTL_MS;
    log.info("card updated", { surfaceId: rec.surfaceId, revision: rec.revision, state: rec.state });
  } catch (err) {
    rec.revision -= 1;
    throw err;
  }
}

/** Test helper */
export function __resetXCardFallbacksForTest(): void {
  recentFallbacks.clear();
}
