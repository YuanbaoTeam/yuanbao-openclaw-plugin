/**
 * messaging/handlers/index.ts unit tests.
 *
 * Test scope: getHandler, getAllHandlers, buildMsgBody, prepareOutboundContent, buildOutboundMsgBody,
 * plus member-nickname-driven @mention resolution (TAPD 1070112211160719458).
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { Member, UserRecord } from "../../../infra/cache/member.js";
import {
  getHandler,
  getAllHandlers,
  buildMsgBody,
  prepareOutboundContent,
  buildOutboundMsgBody,
} from "./index.js";

/** Build a fake Member whose lookupUsers returns the given records. */
function makeMember(members: UserRecord[]): Member {
  return {
    lookupUsers: () => members,
    lookupUserByNickName: (_code: string, name: string) =>
      members.find(m => m.nickName.toLowerCase() === name.toLowerCase()),
  } as unknown as Member;
}

const yuanbaoMember: UserRecord = { userId: "u-yb-001", nickName: "元宝", lastSeen: 0, userType: 2 };

void test("getHandler returns registered handler", () => {
  assert.ok(getHandler("TIMTextElem"));
  assert.ok(getHandler("TIMCustomElem"));
  assert.ok(getHandler("TIMImageElem"));
  assert.ok(getHandler("TIMSoundElem"));
  assert.ok(getHandler("TIMFileElem"));
  assert.ok(getHandler("TIMVideoFileElem"));
  assert.ok(getHandler("TIMFaceElem"));
});

void test("getHandler returns undefined for unregistered type", () => {
  assert.equal(getHandler("TIMUnknownElem"), undefined);
  assert.equal(getHandler(""), undefined);
});

void test("getAllHandlers returns all registered handlers", () => {
  const handlers = getAllHandlers();
  assert.ok(handlers.length >= 7, "should have at least 7 message type handlers");

  const types = new Set(handlers.map((h) => h.msgType));
  assert.ok(types.has("TIMTextElem"));
  assert.ok(types.has("TIMCustomElem"));
  assert.ok(types.has("TIMImageElem"));
  assert.ok(types.has("TIMFaceElem"));
});

void test("buildMsgBody constructs message body by msgType", () => {
  const result = buildMsgBody("TIMTextElem", { text: "hello" });
  assert.ok(result);
  assert.equal(result.length, 1);
  assert.equal(result[0].msg_type, "TIMTextElem");
  assert.equal(result[0].msg_content.text, "hello");
});

void test("buildMsgBody returns undefined for unregistered type", () => {
  assert.equal(buildMsgBody("TIMUnknownElem", {}), undefined);
});

void test("prepareOutboundContent plain text", () => {
  const items = prepareOutboundContent("hello world");
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "text");
  assert.equal((items[0] as { type: "text"; text: string }).text, "hello world");
});

void test("prepareOutboundContent empty text returns empty array", () => {
  assert.deepEqual(prepareOutboundContent(""), []);
  assert.deepEqual(prepareOutboundContent(null as unknown as string), []);
  assert.deepEqual(prepareOutboundContent(undefined as unknown as string), []);
});

void test("prepareOutboundContent keeps CSS @keyframes in one text item", () => {
  const css = [
    "        animation: pulse 1.5s ease-in-out infinite;",
    "        }",
    "        @keyframes pulse {",
  ].join("\n");
  const items = prepareOutboundContent(css);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "text");
  const text = (items[0] as { type: "text"; text: string }).text;
  assert.ok(text.includes("@keyframes pulse {"), "should not split @keyframes into separate elems");
  assert.ok(!text.includes("}@keyframes"), "should not lose newline before @keyframes");
});

void test("buildOutboundMsgBody converts content items to MsgBody", () => {
  const items = [
    { type: "text" as const, text: "hello" },
    { type: "text" as const, text: "world" },
  ];
  const msgBody = buildOutboundMsgBody(items);
  assert.equal(msgBody.length, 2);
  assert.equal(msgBody[0].msg_type, "TIMTextElem");
  assert.equal(msgBody[0].msg_content.text, "hello");
  assert.equal(msgBody[1].msg_type, "TIMTextElem");
  assert.equal(msgBody[1].msg_content.text, "world");
});

void test("buildOutboundMsgBody skips unknown types", () => {
  const items = [
    { type: "text" as const, text: "hello" },
    { type: "unknown" as const, data: "skip me" } as any,
  ];
  const msgBody = buildOutboundMsgBody(items);
  assert.equal(msgBody.length, 1);
  assert.equal(msgBody[0].msg_content.text, "hello");
});

// ── Member-nickname-driven @mention resolution (TAPD 1070112211160719458) ──

void test("prepareOutboundContent resolves Chinese no-space @nickName into text + 1002 + text", () => {
  const member = makeMember([yuanbaoMember]);
  const items = prepareOutboundContent("提醒@元宝喝水", "658317543", member);
  assert.equal(items.length, 3);
  assert.equal(items[0].type, "text");
  assert.equal((items[0] as { type: "text"; text: string }).text, "提醒");
  assert.equal(items[1].type, "custom");
  const data = JSON.parse((items[1] as { type: "custom"; data: string }).data);
  assert.equal(data.elem_type, 1002);
  assert.equal(data.user_id, "u-yb-001");
  assert.equal(data.text, "@元宝");
  assert.equal(items[2].type, "text");
  assert.equal((items[2] as { type: "text"; text: string }).text, "喝水");
});

void test("prepareOutboundContent resolves @nickName at string end", () => {
  const member = makeMember([yuanbaoMember]);
  const items = prepareOutboundContent("提醒@元宝", "658317543", member);
  assert.equal(items.length, 2);
  assert.equal(items[0].type, "text");
  assert.equal((items[0] as { type: "text"; text: string }).text, "提醒");
  assert.equal(items[1].type, "custom");
  const data = JSON.parse((items[1] as { type: "custom"; data: string }).data);
  assert.equal(data.elem_type, 1002);
  assert.equal(data.user_id, "u-yb-001");
});

void test("prepareOutboundContent keeps @keyframes as one text item even with member cache present", () => {
  const member = makeMember([yuanbaoMember]);
  const css = [
    "        animation: pulse 1.5s ease-in-out infinite;",
    "        }",
    "        @keyframes pulse {",
  ].join("\n");
  const items = prepareOutboundContent(css, "658317543", member);
  assert.equal(items.length, 1, "@keyframes is not a member → must not split");
  assert.equal(items[0].type, "text");
  const text = (items[0] as { type: "text"; text: string }).text;
  assert.ok(text.includes("@keyframes pulse {"));
});

void test("prepareOutboundContent with empty member cache returns whole text", () => {
  const member = makeMember([]);
  const items = prepareOutboundContent("提醒@元宝喝水", "658317543", member);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "text");
  assert.equal((items[0] as { type: "text"; text: string }).text, "提醒@元宝喝水");
});

void test("prepareOutboundContent longest nickName wins over substring nickName", () => {
  const members: UserRecord[] = [
    { userId: "u-al", nickName: "Al", lastSeen: 0 },
    { userId: "u-alice", nickName: "Alice", lastSeen: 0 },
  ];
  const member = makeMember(members);
  const items = prepareOutboundContent("hi @Alice", "g-1", member);
  assert.equal(items.length, 2);
  assert.equal(items[0].type, "text");
  assert.equal((items[0] as { type: "text"; text: string }).text, "hi");
  assert.equal(items[1].type, "custom");
  const data = JSON.parse((items[1] as { type: "custom"; data: string }).data);
  assert.equal(data.user_id, "u-alice", "longer nickName Alice must win over Al");
});
