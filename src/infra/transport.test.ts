/**
 * Unit tests for infra/transport.ts — sendC2CMsgBody / sendGroupMsgBody.
 * A fake wsClient captures outbound args; the reply-ref attach logic (off/all/
 * first + dedup) is exercised through sendGroupMsgBody.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { sendC2CMsgBody, sendGroupMsgBody } from "./transport.js";
import type { ResolvedYuanbaoAccount, YuanbaoMsgBodyElement } from "../types.js";
import type { YuanbaoWsClient } from "../access/ws/client.js";

const body: YuanbaoMsgBodyElement[] = [{ msg_type: "TIMTextElem", msg_content: { text: "hi" } }];

function account(over: Record<string, unknown> = {}): ResolvedYuanbaoAccount {
  return { accountId: `acct-${Math.random().toString(36).slice(2)}`, replyToMode: "first", ...over } as unknown as ResolvedYuanbaoAccount;
}

function fakeWs(opts: { code?: number; msgId?: string; message?: string; throwErr?: boolean } = {}) {
  const c2cArgs: Record<string, unknown>[] = [];
  const groupArgs: Record<string, unknown>[] = [];
  const rsp = { code: opts.code ?? 0, msgId: opts.msgId ?? "m-1", message: opts.message ?? "" };
  const ws = {
    sendC2CMessage: async (a: Record<string, unknown>) => { if (opts.throwErr) { throw new Error("ws boom"); } c2cArgs.push(a); return rsp; },
    sendGroupMessage: async (a: Record<string, unknown>) => { if (opts.throwErr) { throw new Error("ws boom"); } groupArgs.push(a); return rsp; },
  } as unknown as YuanbaoWsClient;
  return { ws, c2cArgs, groupArgs };
}

void test("sendC2CMsgBody returns ok on code 0", async () => {
  const { ws } = fakeWs({ code: 0, msgId: "x" });
  const r = await sendC2CMsgBody({ account: account(), toAccount: "u-1", msgBody: body, wsClient: ws });
  assert.equal(r.ok, true);
  assert.equal(r.messageId, "x");
});

void test("sendC2CMsgBody returns error on non-zero code", async () => {
  const { ws } = fakeWs({ code: 500, message: "nope" });
  const r = await sendC2CMsgBody({ account: account(), toAccount: "u-1", msgBody: body, wsClient: ws });
  assert.equal(r.ok, false);
  assert.equal(r.error, "nope");
});

void test("sendC2CMsgBody catches a thrown ws error", async () => {
  const { ws } = fakeWs({ throwErr: true });
  const r = await sendC2CMsgBody({ account: account(), toAccount: "u-1", msgBody: body, wsClient: ws });
  assert.equal(r.ok, false);
  assert.match(r.error!, /ws boom/);
});

void test("sendC2CMsgBody forwards trace_id + msg_seq when traceContext present", async () => {
  const { ws, c2cArgs } = fakeWs();
  await sendC2CMsgBody({
    account: account(), toAccount: "u-1", msgBody: body, wsClient: ws,
    traceContext: { traceId: "tr-1", traceparent: "", nextMsgSeq: () => 5 },
  });
  assert.equal(c2cArgs[0].trace_id, "tr-1");
  assert.equal(c2cArgs[0].msg_seq, 5);
});

void test("sendGroupMsgBody: replyToMode 'all' attaches ref_msg_id", async () => {
  const { ws, groupArgs } = fakeWs();
  await sendGroupMsgBody({ account: account({ replyToMode: "all" }), groupCode: "g-1", msgBody: body, refMsgId: "ref-1", refFromAccount: "u-2", wsClient: ws });
  assert.equal(groupArgs[0].ref_msg_id, "ref-1");
});

void test("sendGroupMsgBody: replyToMode 'off' does not attach ref", async () => {
  const { ws, groupArgs } = fakeWs();
  await sendGroupMsgBody({ account: account({ replyToMode: "off" }), groupCode: "g-1", msgBody: body, refMsgId: "ref-1", refFromAccount: "u-2", wsClient: ws });
  assert.equal(groupArgs[0].ref_msg_id, undefined);
});

void test("sendGroupMsgBody: replyToMode 'first' attaches once then dedups", async () => {
  const acct = account({ replyToMode: "first" });
  const { ws, groupArgs } = fakeWs();
  await sendGroupMsgBody({ account: acct, groupCode: "g-1", msgBody: body, refMsgId: "ref-dedup", refFromAccount: "u-2", wsClient: ws });
  await sendGroupMsgBody({ account: acct, groupCode: "g-1", msgBody: body, refMsgId: "ref-dedup", refFromAccount: "u-2", wsClient: ws });
  assert.equal(groupArgs[0].ref_msg_id, "ref-dedup");
  assert.equal(groupArgs[1].ref_msg_id, undefined); // deduped
});

void test("sendGroupMsgBody catches a thrown ws error", async () => {
  const { ws } = fakeWs({ throwErr: true });
  const r = await sendGroupMsgBody({ account: account({ replyToMode: "off" }), groupCode: "g-1", msgBody: body, wsClient: ws });
  assert.equal(r.ok, false);
});
