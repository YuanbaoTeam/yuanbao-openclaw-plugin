/**
 * xCard wire transport: how a card, its updates and event receipts travel over IM.
 *
 * Everything above this layer (registry, templates, event decisions) is transport-agnostic.
 * xCard rides on the existing elem_type 1013 custom message; there is currently one supported
 * wire format, so callers do not expose a transport switch.
 */

import type { YuanbaoWsClient } from "../../access/ws/client.js";
import type { WsSendMessageResponse, WsXCardReceipt } from "../../access/ws/types.js";
import type { ResolvedYuanbaoAccount, YuanbaoMsgBodyElement } from "../../types.js";
import type { SurfaceRecord } from "./registry.js";
import { im1007Transport } from "./transport-im1007.js";
import type { A2uiMessage } from "./validate.js";

export type XCardTransportKind = "im1007";

export interface XCardTransportCtx {
  account: ResolvedYuanbaoAccount;
  wsClient: YuanbaoWsClient;
}

/** A receipt is posted back to the group as an extend_type=103 downevent. */
export interface XCardReceiptTarget {
  replyToken: string;
  groupCode: string;
  /** Original card IM id echoed by the client's 102 event. */
  cardMessageId?: string;
}

export interface XCardTransport {
  readonly kind: XCardTransportKind;
  /** msg_body of the message that creates the card */
  cardBody(title: string, messages: A2uiMessage[]): YuanbaoMsgBodyElement[];
  /** Whether an already-sent card can still be replaced. */
  canUpdate(rec: SurfaceRecord): boolean;
  /** msg_body carrying incremental messages for the existing Surface (size-checked by the caller) */
  updateBody(rec: SurfaceRecord, messages: A2uiMessage[]): YuanbaoMsgBodyElement[];
  sendUpdate(ctx: XCardTransportCtx, rec: SurfaceRecord, body: YuanbaoMsgBodyElement[]): Promise<WsSendMessageResponse>;
  sendReceipt(ctx: XCardTransportCtx, target: XCardReceiptTarget, receipt: WsXCardReceipt): Promise<WsSendMessageResponse>;
}

export function getXCardTransport(_account: ResolvedYuanbaoAccount): XCardTransport {
  return im1007Transport;
}
