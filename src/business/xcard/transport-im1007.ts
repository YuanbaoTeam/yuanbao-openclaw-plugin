/**
 * TEMPORARY xCard transport over an existing custom message type (CARRIER_ELEM_TYPE).
 *
 * Cards borrow the 1013 markdown card (`{elem_type:1013, text}`), the custom elem the server lets
 * bots send intact: 1007 and
 * 1100 are rejected with 10002「消息体为空」, and extra top-level fields on 1013 are filtered out.
 * The xCard envelope therefore travels as the JSON string in `text`:
 *   TIMCustomElem.data = {"elem_type":1013,"text":"{\"extend_type\":10x,\"content\":{...}}"}
 * `content` is a JSON value inside that envelope (not serialized again). extend_type:
 *   101 card       bot → IM     : the A2UI v1.0 message array of a new card
 *   102 upevent    App → IM     : posted as the operator; content is the submit payload
 *                                 (protocol / requestId / surfaceId / binding / event)
 *   103 downevent  bot → IM     : the client host envelope. `action_ack` answers one upevent;
 *                                 `state_update` carries incremental A2UI messages for the
 *                                 existing card identity.
 *
 * Isolation from the original 1013 (markdown) logic: a 1013 whose `text` is not a JSON envelope
 * with one of the extend_types above is never touched here, and upevents are intercepted before the normal inbound pipeline (gateway.ts)
 * only when xCard is enabled.
 */

import { randomUUID } from "node:crypto";
import type { YuanbaoWsClient } from "../../access/ws/client.js";
import type { WsXCardReceipt } from "../../access/ws/types.js";
import type { ResolvedYuanbaoAccount, YuanbaoInboundMessage, YuanbaoMsgBodyElement } from "../../types.js";
import { XCARD_EVENT_PROTOCOL } from "./constants.js";
import type { SurfaceRecord } from "./registry.js";
import type { XCardTransport } from "./transport.js";
import type { A2uiMessage } from "./validate.js";

/** Carrier custom elem type: 1013 markdown card (named im1007 for history; see header) */
export const IM1007_ELEM_TYPE = 1013;

export const IM1007_EXTEND_TYPE = {
  card: 101,
  upEvent: 102,
  downEvent: 103,
} as const;

const DOWN_EVENT_PROTOCOL_VERSION = "1.0";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function objValue(v: unknown): Record<string, unknown> | undefined {
  if (isObj(v)) return v;
  if (typeof v !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(v);
    return isObj(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === "string" && v.length > 0);
}

function numberValue(...values: unknown[]): number | undefined {
  return values.find((v): v is number => typeof v === "number" && Number.isFinite(v));
}

/**
 * Translate the shipped client payload into the canonical event shape consumed by events.ts.
 *
 * The shipped client uses snake_case (`event_id`, `surface_id`, `event_name`, ...), while the
 * earlier proxy draft uses `{protocol, requestId, surfaceId, binding, event}`. Keep this
 * compatibility at the removable transport boundary rather than teaching the event core both
 * dialects. Object-valued fields may also arrive as JSON strings.
 */
function normalizeIm1007Payload(payload: Record<string, unknown>): Record<string, unknown> {
  if (typeof payload.requestId === "string" || isObj(payload.event)) return payload;

  const requestId = stringValue(payload.event_id, payload.request_id);
  const surfaceId = stringValue(payload.surface_id, payload.surfaceId);
  const eventName = stringValue(payload.event_name, payload.action_name);
  const eventData = objValue(payload.event_data) ?? objValue(payload.action) ?? {};
  const context =
    objValue(payload.context_json)
    ?? objValue(payload.event_context)
    ?? objValue(payload.action_context)
    ?? objValue(payload.context)
    ?? objValue(eventData.context)
    ?? objValue(eventData.data)
    ?? {};
  const revision = numberValue(payload.revision, payload.card_revision, eventData.revision);
  const pluginEpoch = stringValue(payload.plugin_epoch, eventData.plugin_epoch);

  return {
    protocol: XCARD_EVENT_PROTOCOL,
    ...(requestId ? { requestId } : {}),
    ...(surfaceId ? { surfaceId } : {}),
    binding: {
      ...(pluginEpoch ? { pluginEpoch } : {}),
      ...(revision !== undefined ? { revision } : {}),
      ...(typeof payload.card_message_id === "string" ? { messageId: payload.card_message_id } : {}),
    },
    event: {
      version: stringValue(payload.protocol_version, eventData.version) ?? "v1.0",
      action: {
        ...(eventName ? { name: eventName } : {}),
        ...(surfaceId ? { surfaceId } : {}),
        context,
        ...(stringValue(payload.source_component_id, eventData.sourceComponentId)
          ? { sourceComponentId: stringValue(payload.source_component_id, eventData.sourceComponentId) }
          : {}),
        ...(stringValue(payload.user_message, eventData.userMessage)
          ? { userMessage: stringValue(payload.user_message, eventData.userMessage) }
          : {}),
        ...(stringValue(payload.trigger, eventData.trigger)
          ? { trigger: stringValue(payload.trigger, eventData.trigger) }
          : {}),
        ...(stringValue(payload.timestamp, eventData.timestamp)
          ? { timestamp: stringValue(payload.timestamp, eventData.timestamp) }
          : {}),
      },
    },
  };
}

function elem1007(extendType: number, content: unknown): YuanbaoMsgBodyElement[] {
  const text = JSON.stringify({ extend_type: extendType, content });
  return [{ msg_type: "TIMCustomElem", msg_content: { data: JSON.stringify({ elem_type: IM1007_ELEM_TYPE, text }) } }];
}

function sendToConversation(
  account: ResolvedYuanbaoAccount,
  wsClient: YuanbaoWsClient,
  isGroup: boolean,
  targetId: string,
  body: YuanbaoMsgBodyElement[],
) {
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

export const im1007Transport: XCardTransport = {
  kind: "im1007",
  cardBody: (_title, messages) => elem1007(IM1007_EXTEND_TYPE.card, messages),
  // The real client keys state by both the original card message and Surface. The IM id becomes
  // available when the client echoes it in its first 102 event.
  canUpdate: (rec) => Boolean(rec.cardMessageId),
  updateBody: (rec: SurfaceRecord, messages: A2uiMessage[]) =>
    elem1007(IM1007_EXTEND_TYPE.downEvent, {
      protocol_version: DOWN_EVENT_PROTOCOL_VERSION,
      delivery_id: randomUUID(),
      card_message_id: rec.cardMessageId ?? "",
      surface_id: rec.surfaceId,
      state_update: {
        state_seq: rec.revision,
        operation: "snapshot",
        content: messages,
      },
    }),
  sendUpdate: ({ account, wsClient }, rec, body) =>
    sendToConversation(account, wsClient, rec.isGroup, rec.groupCode, body),
  sendReceipt: ({ account, wsClient }, target, receipt: WsXCardReceipt) =>
    sendToConversation(account, wsClient, target.isGroup, target.groupCode, elem1007(IM1007_EXTEND_TYPE.downEvent, {
      protocol_version: DOWN_EVENT_PROTOCOL_VERSION,
      delivery_id: randomUUID(),
      card_message_id: target.cardMessageId ?? "",
      surface_id: receipt.surfaceId,
      action_ack: {
        event_id: receipt.requestId,
        success: receipt.status === "accepted" || receipt.status === "completed",
        error_code: receipt.status === "accepted" || receipt.status === "completed"
          ? ""
          : receipt.reason || receipt.status,
        error_message: receipt.status === "accepted" || receipt.status === "completed"
          ? ""
          : receipt.reason || receipt.status,
      },
    })),
};

/**
 * The upevent payload if `msg` is exactly one carrier elem with extend_type=102, else null.
 * Any other message (including a plain markdown 1013) is left to the normal pipeline.
 */
export function parseIm1007UpEvent(msg: YuanbaoInboundMessage): Record<string, unknown> | null {
  const body = msg.msg_body ?? [];
  if (body.length !== 1) return null;
  const el = body[0];
  // The real inbound proxy currently labels the 1013 carrier as TIMTextElem even though its
  // custom-element JSON remains in msg_content.data. Identify it by data, not msg_type.
  if (!el || typeof el.msg_content?.data !== "string") return null;
  let envelope: unknown;
  try {
    const data: unknown = JSON.parse(el.msg_content.data);
    if (!isObj(data) || data.elem_type !== IM1007_ELEM_TYPE || typeof data.text !== "string") return null;
    // Plain markdown text is not JSON (or has no extend_type) and falls through untouched
    envelope = JSON.parse(data.text);
  } catch {
    return null;
  }
  if (!isObj(envelope) || envelope.extend_type !== IM1007_EXTEND_TYPE.upEvent) return null;
  // Malformed content still counts as an upevent: it is rejected as invalid_payload, not chatted
  return isObj(envelope.content) ? normalizeIm1007Payload(envelope.content) : {};
}
