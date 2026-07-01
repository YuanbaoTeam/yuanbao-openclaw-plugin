/**
 * Unit tests for actions/text/send.ts — builds a MsgBody from text and delivers.
 * deliver is mocked to capture the built body; content prep runs for real.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import type { DeliverTarget } from "../deliver.js";
import type { ResolvedYuanbaoAccount } from "../../../types.js";
import type { YuanbaoWsClient } from "../../../access/ws/client.js";

let delivered: { dt: DeliverTarget; body: unknown[] }[];
let sendText: typeof import("./send.js").sendText;

beforeEach(async () => {
  delivered = [];
  mock.module("../deliver.js", {
    namedExports: { deliver: async (dt: DeliverTarget, body: unknown[]) => { delivered.push({ dt, body }); return { ok: true }; } },
  });
  ({ sendText } = await import("./send.js"));
});

afterEach(() => mock.restoreAll());

const dt: DeliverTarget = {
  isGroup: false, target: "u-1", account: { accountId: "a-1" } as unknown as ResolvedYuanbaoAccount, wsClient: {} as YuanbaoWsClient,
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
