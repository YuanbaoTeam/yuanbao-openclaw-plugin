/**
 * Integration test for the receive path: wsPushToInboundMessage — converting a
 * WsPushEvent (decoded WS frame) into a YuanbaoInboundMessage + chat type.
 *
 * Covers all decode strategies: connData protobuf, rawData protobuf, rawData
 * JSON fallback, and content (JSON / plain-text) parsing, plus chat-type
 * inference and the no-match → null path.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BIZ_MSG_TYPES, encodeBizPB, toProtoMsgBody } from "./biz-codec.js";
import { wsPushToInboundMessage } from "./gateway.js";
import type { WsPushEvent } from "./types.js";
import type { YuanbaoMsgBodyElement } from "../../types.js";

const textBody: YuanbaoMsgBodyElement[] = [{ msg_type: "TIMTextElem", msg_content: { text: "hi" } }];

/** Encode an InboundMessagePush protobuf frame (camelCase proto fields). */
function inboundProto(fields: Record<string, unknown>): Uint8Array {
  return encodeBizPB(BIZ_MSG_TYPES.InboundMessagePush, { msgBody: toProtoMsgBody(textBody), ...fields })!;
}

void test("connData protobuf (c2c) decodes to a c2c inbound message", () => {
  const ev: WsPushEvent = { connData: inboundProto({ fromAccount: "u-1" }) };
  const res = wsPushToInboundMessage(ev);
  assert.ok(res);
  assert.equal(res!.chatType, "c2c");
  assert.equal(res!.msg.from_account, "u-1");
  assert.equal(res!.msg.msg_body?.[0].msg_content.text, "hi");
});

void test("connData protobuf with groupCode decodes to a group message", () => {
  const ev: WsPushEvent = { connData: inboundProto({ fromAccount: "u-1", groupCode: "g-1" }) };
  const res = wsPushToInboundMessage(ev);
  assert.equal(res!.chatType, "group");
  assert.equal(res!.msg.group_code, "g-1");
});

void test("falls back to rawData protobuf when connData is absent", () => {
  const ev: WsPushEvent = { rawData: inboundProto({ fromAccount: "u-2" }) };
  const res = wsPushToInboundMessage(ev);
  assert.ok(res);
  assert.equal(res!.msg.from_account, "u-2");
});

void test("content as JSON with msg_body + group_code → group message", () => {
  const ev: WsPushEvent = {
    content: JSON.stringify({ from_account: "u-4", group_code: "g-2", msg_body: textBody }),
  };
  const res = wsPushToInboundMessage(ev);
  assert.ok(res);
  assert.equal(res!.chatType, "group");
  assert.equal(res!.msg.callback_command, "Group.CallbackAfterSendMsg");
  assert.equal(res!.msg.from_account, "u-4");
});

void test("content as plain text wraps into a TIMTextElem (c2c)", () => {
  const ev: WsPushEvent = { content: "just text" };
  const res = wsPushToInboundMessage(ev);
  assert.ok(res);
  assert.equal(res!.chatType, "c2c");
  assert.equal(res!.msg.callback_command, "C2C.CallbackAfterSendMsg");
  assert.equal(res!.msg.msg_body?.[0].msg_content.text, "just text");
});

void test("content JSON carrying only a text field is wrapped as text", () => {
  const ev: WsPushEvent = { content: JSON.stringify({ text: "from-json" }) };
  const res = wsPushToInboundMessage(ev);
  assert.ok(res);
  assert.equal(res!.msg.msg_body?.[0].msg_content.text, "from-json");
});

void test("empty push event with no decodable payload returns null", () => {
  assert.equal(wsPushToInboundMessage({}), null);
  assert.equal(wsPushToInboundMessage({ rawData: new Uint8Array(0) }), null);
});

void test("group callback_command infers group chat type even without group_code", () => {
  const ev: WsPushEvent = { connData: inboundProto({ fromAccount: "u-5", callbackCommand: "Group.CallbackAfterSendMsg" }) };
  const res = wsPushToInboundMessage(ev);
  assert.equal(res!.chatType, "group");
});
