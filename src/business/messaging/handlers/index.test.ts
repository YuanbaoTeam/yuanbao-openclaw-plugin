/**
 * messaging/handlers/index.ts unit tests.
 *
 * Test scope: getHandler, getAllHandlers, buildMsgBody, prepareOutboundContent, buildOutboundMsgBody
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  getHandler,
  getAllHandlers,
  buildMsgBody,
  prepareOutboundContent,
  buildOutboundMsgBody,
} from "./index.js";

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

void test("prepareOutboundContent plain text", async () => {
  const items = await prepareOutboundContent("hello world");
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "text");
  assert.equal((items[0] as { type: "text"; text: string }).text, "hello world");
});

void test("prepareOutboundContent empty text returns empty array", async () => {
  assert.deepEqual(await prepareOutboundContent(""), []);
  assert.deepEqual(await prepareOutboundContent(null as unknown as string), []);
  assert.deepEqual(await prepareOutboundContent(undefined as unknown as string), []);
});

void test("prepareOutboundContent keeps CSS @keyframes in one text item", async () => {
  const css = [
    "        animation: pulse 1.5s ease-in-out infinite;",
    "        }",
    "        @keyframes pulse {",
  ].join("\n");
  const items = await prepareOutboundContent(css);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "text");
  const text = (items[0] as { type: "text"; text: string }).text;
  assert.ok(text.includes("@keyframes pulse {"), "should not split @keyframes into separate elems");
  assert.ok(!text.includes("}@keyframes"), "should not lose newline before @keyframes");
});

void test("prepareOutboundContent resolves @mention via fallback getMembers when cache misses", async () => {
  // Simulate 元宝 (AI member) only present after API fetch: lookupUserByNickName
  // misses first, group.getMembers fills the cache, retry lookup hits.
  const cache = new Map<string, { userId: string; nickName: string }>();
  const memberInst = {
    lookupUserByNickName: (_groupCode: string, nickName: string) => {
      const rec = cache.get(nickName.toLowerCase());
      return rec ? { userId: rec.userId, nickName: rec.nickName, lastSeen: 0 } : undefined;
    },
    group: {
      getMembers: async (_groupCode: string) => {
        cache.set("元宝", { userId: "yb-1", nickName: "元宝" });
        return [{ userId: "yb-1", nickName: "元宝", lastSeen: 0 }];
      },
    },
  };
  const items = await prepareOutboundContent("提醒 @元宝 喝水", "g-1", memberInst as any);
  // Expected: text "提醒", custom @元宝 (elem_type=1002), text "喝水"
  assert.equal(items.length, 3);
  assert.equal(items[0].type, "text");
  assert.equal((items[0] as { type: "text"; text: string }).text, "提醒");
  assert.equal(items[1].type, "custom");
  const custom = JSON.parse((items[1] as { type: "custom"; data: string }).data) as {
    elem_type: number;
    text: string;
    user_id: string;
  };
  assert.equal(custom.elem_type, 1002);
  assert.equal(custom.user_id, "yb-1");
  assert.equal(items[2].type, "text");
  assert.equal((items[2] as { type: "text"; text: string }).text, "喝水");
});

void test("prepareOutboundContent leaves @ as plain text when fallback still misses", async () => {
  // group.getMembers returns nothing useful; lookup stays undefined → warn + plain text.
  const memberInst = {
    lookupUserByNickName: () => undefined,
    group: { getMembers: async () => [] },
  };
  const items = await prepareOutboundContent("hi @nobody here", "g-1", memberInst as any);
  // No @ resolved → whole text collapses into a single text item (plain @ preserved).
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "text");
  const text = (items[0] as { type: "text"; text: string }).text;
  assert.ok(text.includes("@nobody"), "unresolved @ should be preserved as plain text");
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
