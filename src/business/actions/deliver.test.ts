/**
 * Unit tests for actions/deliver.ts — routes to group vs C2C transport based on
 * the isGroup flag. Transport is mocked to capture the routed call + args.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import type { DeliverTarget } from "./deliver.js";
import type { ResolvedYuanbaoAccount, YuanbaoMsgBodyElement } from "../../types.js";
import type { YuanbaoWsClient } from "../../access/ws/client.js";

let routed: { fn: string; args: Record<string, unknown> }[];
let deliver: typeof import("./deliver.js").deliver;

beforeEach(async () => {
  routed = [];
  mock.module("../../infra/transport.js", {
    namedExports: {
      sendC2CMsgBody: async (a: Record<string, unknown>) => { routed.push({ fn: "c2c", args: a }); return { ok: true }; },
      sendGroupMsgBody: async (a: Record<string, unknown>) => { routed.push({ fn: "group", args: a }); return { ok: true }; },
    },
  });
  ({ deliver } = await import("./deliver.js"));
});

afterEach(() => mock.restoreAll());

const body: YuanbaoMsgBodyElement[] = [{ msg_type: "TIMTextElem", msg_content: { text: "hi" } }];
const account = { accountId: "a-1" } as unknown as ResolvedYuanbaoAccount;
const wsClient = {} as YuanbaoWsClient;

void test("deliver routes group messages to sendGroupMsgBody", async () => {
  const dt: DeliverTarget = { isGroup: true, target: "g-1", account, wsClient, refMsgId: "r-1" };
  await deliver(dt, body);
  assert.equal(routed[0].fn, "group");
  assert.equal(routed[0].args.groupCode, "g-1");
  assert.equal(routed[0].args.refMsgId, "r-1");
});

void test("deliver routes C2C messages to sendC2CMsgBody", async () => {
  const dt: DeliverTarget = { isGroup: false, target: "u-1", account, wsClient, groupCode: "ctx-g" };
  await deliver(dt, body);
  assert.equal(routed[0].fn, "c2c");
  assert.equal(routed[0].args.toAccount, "u-1");
  assert.equal(routed[0].args.groupCode, "ctx-g");
});
