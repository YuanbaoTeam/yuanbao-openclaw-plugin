/**
 * Send module type definitions
 *
 * Define core types for outbound messages: message items, send results, send targets, and sender interface.
 */

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { OutboundReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { YuanbaoWsClient } from "../../access/ws/client.js";
import type { ModuleLog } from "../../logger.js";
import type { ResolvedYuanbaoAccount, YuanbaoMsgBodyElement } from "../../types.js";
import type { YuanbaoTraceContext } from "../trace/context.js";

/** Outbound message item */
export type OutboundItem =
  | { type: "text"; text: string }
  | { type: "media"; mediaUrl: string; fallbackText?: string }
  | { type: "sticker"; stickerId: string }
  | { type: "raw"; msgBody: YuanbaoMsgBodyElement[] };

/** Send result */
export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

/** Send target context — assembled by prepareSender middleware */
export interface SendParams {
  isGroup: boolean;
  groupCode?: string;
  account: ResolvedYuanbaoAccount;
  /** C2C: toAccount; group chat: groupCode */
  target: string;
  fromAccount?: string;
  refMsgId?: string;
  refFromAccount?: string;
  wsClient: YuanbaoWsClient;
  config: OpenClawConfig;
  core: PluginRuntime;
  traceContext?: YuanbaoTraceContext;
  /**
   * Optional cloud_custom_data JSON echoed on every outbound message from this
   * sender (currently used for topic-id round-trip so the front-end can
   * attribute Bot replies back to the originating topic).
   */
  cloudCustomData?: string;
  /**
   * Optional caller-provided logger. When passed (typically pipeline `ctx.log`),
   * every send driven by this sender will forward it down to the transport
   * layer so out-frame logs share the same sink as the pipeline logs.
   */
  log?: ModuleLog;
}

/** Message sender interface */
export interface MessageSender {
  sendText(text: string): Promise<SendResult>;
  sendMedia(mediaUrl: string, fallbackText?: string): Promise<SendResult>;
  sendSticker(stickerId: string): Promise<SendResult>;
  sendRaw(msgBody: YuanbaoMsgBodyElement[]): Promise<SendResult>;
  send(item: OutboundItem): Promise<SendResult>;
  /** Auto-dispatch from SDK OutboundReplyPayload */
  deliver(payload: OutboundReplyPayload): Promise<void>;
}
