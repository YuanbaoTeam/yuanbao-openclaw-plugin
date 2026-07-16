/**
 * Unit tests for actions/text/send.ts — builds a MsgBody from text and delivers.
 * deliver is mocked to capture the built body; content prep runs for real.
 * getMember is mocked to return a fake member instance for group @ cases.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import type { DeliverTarget } from "../deliver.js";
import type { ResolvedYuanbaoAccount } from "../../../types.js";
import type { YuanbaoWsClient } from "../../../access/ws/client.js";

let delivered: { dt: DeliverTarget; body: unknown[] }[];
let sendText: typeof import("./send.js").sendText;

// Fake group member fixture: a single member nicknamed "元宝" (userType=2 = yuanbao).
const yuanbaoMember = { userId: "u-yb-001", nickName: "元宝", lastSeen: 0, userType: 2 };
const fakeMember = {
  queryMembers: async () => [yuanbaoMember],
  lookupUsers: () => [yuanbaoMember],
  lookupUserByNickName: (_code: string, name: string) =>
    name === "元宝" ? yuanbaoMember : undefined,
};

beforeEach(async () => {
  delivered = [];
  mock.module("../deliver.js", {
    namedExports: { deliver: async (dt: DeliverTarget, body: unknown[]) => { delivered.push({ dt, body }); return { ok: true }; } },
  });
  mock.module("../../../infra/cache/member.js", {
    namedExports: { getMember: () => fakeMember },
  });
  ({ sendText } = await import("./send.js"));
});

afterEach(() => mock.restoreAll());

const dt: DeliverTarget = {
  isGroup: false, target: "u-1", account: { accountId: "a-1" } as unknown as ResolvedYuanbaoAccount, wsClient: {} as YuanbaoWsClient,
};

const groupDt: DeliverTarget = {
  isGroup: true, target: "658317543", account: { accountId: "a-1" } as unknown as ResolvedYuanbaoAccount, wsClient: {} as YuanbaoWsClient,
};

void test("empty text resolves ok without delivering", async () => {
  const r = await sendText({ text: "   ", dt });
  assert.equal(r.ok, true);
  assert.equal(delivered.length, 0);
});

void test("non-empty text builds a MsgBody and delivers it", async () => {
  const r = await sendText({ text: "hello world", dt });
  assert.equal(r.ok, true);
  assert.equal(delivered.length, 1);
  assert.ok(Array.isArray(delivered[0].body));
  assert.ok(delivered[0].body.length >= 1);
});

void test("CSS @keyframes is delivered as a single text element", async () => {
  const css = "        animation: pulse 1.5s infinite;\n        }\n        @keyframes pulse {";
  const r = await sendText({ text: css, dt });
  assert.equal(r.ok, true);
  assert.equal(delivered.length, 1);
  const body = delivered[0].body as Array<{ msg_type: string; msg_content: { text: string } }>;
  assert.equal(body.length, 1, "should not split @keyframes across TIMTextElem");
  assert.ok(body[0].msg_content.text.includes("@keyframes pulse {"));
});

// ── Group @mention (TAPD 1070112211160719458) ──
// Verifies preheat + member-driven resolveAtMentions emits TIMCustomElem(elem_type=1002).

void test("group text with @member emits TIMCustomElem(1002) with correct user_id and routes to group", async () => {
  const r = await sendText({ text: "请在群里 @元宝 提醒他喝水", dt: groupDt });
  assert.equal(r.ok, true);
  assert.equal(delivered.length, 1);
  // Routed as group, not C2C
  assert.equal(delivered[0].dt.isGroup, true);
  assert.equal(delivered[0].dt.target, "658317543");

  const body = delivered[0].body as Array<{ msg_type: string; msg_content: { data?: string; text?: string } }>;
  const atElem = body.find(e => e.msg_type === "TIMCustomElem");
  assert.ok(atElem, "msg_body should contain a TIMCustomElem @ element");
  const parsed = JSON.parse(atElem!.msg_content.data!);
  assert.equal(parsed.elem_type, 1002);
  assert.equal(parsed.user_id, "u-yb-001");
  assert.equal(parsed.text, "@元宝");
});

void test("group text without @ does not emit custom elem", async () => {
  const r = await sendText({ text: "提醒大家喝水", dt: groupDt });
  assert.equal(r.ok, true);
  assert.equal(delivered.length, 1);
  const body = delivered[0].body as Array<{ msg_type: string }>;
  assert.ok(!body.some(e => e.msg_type === "TIMCustomElem"), "no @ → no TIMCustomElem");
});
