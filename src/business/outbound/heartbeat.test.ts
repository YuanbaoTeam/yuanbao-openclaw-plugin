/**
 * Unit tests for outbound/heartbeat.ts — emitReplyHeartbeat (C2C/group, guards,
 * non-zero code) and the running-heartbeat controller (start/stop/finish).
 * A fake wsClient captures heartbeat calls.
 */

import assert from "node:assert/strict";
import test, { afterEach, mock } from "node:test";
import { WS_HEARTBEAT, WS_HEARTBEAT_GROUP_DISSOLVED_CODE } from "../../access/ws/types.js";
import { createReplyHeartbeatController, emitReplyHeartbeat } from "./heartbeat.js";
import type { ResolvedYuanbaoAccount } from "../../types.js";
import type { MessageHandlerContext } from "../messaging/context.js";

function fakeCtx(opts: { code?: number; noWs?: boolean } = {}) {
  const calls: { kind: string; args: Record<string, unknown> }[] = [];
  const rsp = { code: opts.code ?? 0, msg: "" };
  const wsClient = opts.noWs ? undefined : {
    sendPrivateHeartbeat: async (a: Record<string, unknown>) => { calls.push({ kind: "private", args: a }); return rsp; },
    sendGroupHeartbeat: async (a: Record<string, unknown>) => { calls.push({ kind: "group", args: a }); return rsp; },
  };
  return { ctx: { wsClient } as unknown as MessageHandlerContext, calls };
}

const account = { accountId: "a-1", botId: "bot-1" } as unknown as ResolvedYuanbaoAccount;

afterEach(() => mock.timers.reset());

void test("emitReplyHeartbeat sends a C2C private heartbeat", async () => {
  const { ctx, calls } = fakeCtx();
  await emitReplyHeartbeat({ ctx, account, toAccount: "u-1", heartbeat: WS_HEARTBEAT.RUNNING, sendTime: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].kind, "private");
  assert.equal(calls[0].args.from_account, "bot-1");
});

void test("emitReplyHeartbeat sends a group heartbeat when groupCode present", async () => {
  const { ctx, calls } = fakeCtx();
  await emitReplyHeartbeat({ ctx, account, toAccount: "u-1", groupCode: "g-1", heartbeat: WS_HEARTBEAT.FINISH, sendTime: 1 });
  assert.equal(calls[0].kind, "group");
  assert.equal(calls[0].args.group_code, "g-1");
});

void test("emitReplyHeartbeat no-ops when wsClient is missing", async () => {
  const { ctx, calls } = fakeCtx({ noWs: true });
  await emitReplyHeartbeat({ ctx, account, toAccount: "u-1", heartbeat: WS_HEARTBEAT.RUNNING, sendTime: 1 });
  assert.equal(calls.length, 0);
});

void test("emitReplyHeartbeat no-ops when from/to account missing", async () => {
  const { ctx, calls } = fakeCtx();
  const noBotAcct = { accountId: "a-1", botId: "" } as unknown as ResolvedYuanbaoAccount;
  await emitReplyHeartbeat({ ctx, account: noBotAcct, toAccount: "u-1", heartbeat: WS_HEARTBEAT.RUNNING, sendTime: 1 });
  assert.equal(calls.length, 0);
});

void test("emitReplyHeartbeat tolerates a non-zero response code (no throw)", async () => {
  const { ctx } = fakeCtx({ code: 500 });
  await assert.doesNotReject(emitReplyHeartbeat({ ctx, account, toAccount: "u-1", heartbeat: WS_HEARTBEAT.RUNNING, sendTime: 1 }));
});

void test("controller emit(FINISH) sends a finish heartbeat and stops", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { ctx, calls } = fakeCtx();
  const ctrl = createReplyHeartbeatController({ meta: { ctx, account, toAccount: "u-1" } });
  ctrl.emit(WS_HEARTBEAT.FINISH);
  await Promise.resolve();
  assert.ok(calls.some(c => c.args.heartbeat === WS_HEARTBEAT.FINISH));
  ctrl.finishIfNeeded();
  assert.equal(calls.filter(c => c.args.heartbeat === WS_HEARTBEAT.FINISH).length, 1, "FINISH should only be sent once");
});

void test("controller emit(RUNNING) starts the running heartbeat then stop() clears it", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { ctx, calls } = fakeCtx();
  const ctrl = createReplyHeartbeatController({ meta: { ctx, account, toAccount: "u-1" } });
  ctrl.emit(WS_HEARTBEAT.RUNNING);
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(calls.some(c => c.args.heartbeat === WS_HEARTBEAT.RUNNING), "running heartbeat emitted");
  ctrl.stop(); // clears the scheduled timer
});

void test("controller emit(RUNNING) twice keeps a single running loop (idempotent start)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { ctx } = fakeCtx();
  const ctrl = createReplyHeartbeatController({ meta: { ctx, account, toAccount: "u-1" } });
  ctrl.emit(WS_HEARTBEAT.RUNNING);
  ctrl.emit(WS_HEARTBEAT.RUNNING); // second call only refreshes lastEmit, no new loop
  await Promise.resolve();
  ctrl.finishIfNeeded();
});

void test("finishIfNeeded sends FINISH when RUNNING was started", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { ctx, calls } = fakeCtx();
  const ctrl = createReplyHeartbeatController({ meta: { ctx, account, toAccount: "u-1" } });
  ctrl.emit(WS_HEARTBEAT.RUNNING);
  await Promise.resolve();
  ctrl.finishIfNeeded();
  await Promise.resolve();
  assert.ok(calls.some(c => c.args.heartbeat === WS_HEARTBEAT.RUNNING));
  assert.ok(calls.some(c => c.args.heartbeat === WS_HEARTBEAT.FINISH));
});

void test("finishIfNeeded is a no-op when RUNNING never started", async () => {
  const { ctx, calls } = fakeCtx();
  const ctrl = createReplyHeartbeatController({ meta: { ctx, account, toAccount: "u-1" } });
  ctrl.finishIfNeeded();
  assert.equal(calls.length, 0);
});

void test("RUNNING emit after FINISH is ignored", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { ctx, calls } = fakeCtx();
  const ctrl = createReplyHeartbeatController({ meta: { ctx, account, toAccount: "u-1" } });
  ctrl.emit(WS_HEARTBEAT.RUNNING);
  await Promise.resolve();
  ctrl.finishIfNeeded();
  await Promise.resolve();
  const runningBefore = calls.filter(c => c.args.heartbeat === WS_HEARTBEAT.RUNNING).length;
  ctrl.emit(WS_HEARTBEAT.RUNNING);
  await Promise.resolve();
  mock.timers.tick(5000);
  await Promise.resolve();
  assert.equal(
    calls.filter(c => c.args.heartbeat === WS_HEARTBEAT.RUNNING).length,
    runningBefore,
    "RUNNING must not restart after FINISH",
  );
});

void test("emitReplyHeartbeat returns shouldStop for group dissolved code", async () => {
  const { ctx } = fakeCtx({ code: WS_HEARTBEAT_GROUP_DISSOLVED_CODE });
  const outcome = await emitReplyHeartbeat({
    ctx,
    account,
    toAccount: "u-1",
    groupCode: "g-1",
    heartbeat: WS_HEARTBEAT.RUNNING,
    sendTime: 1,
  });
  assert.equal(outcome.shouldStop, true);
});

void test("emitReplyHeartbeat returns shouldStop=false for other non-zero codes", async () => {
  const { ctx } = fakeCtx({ code: 500 });
  const outcome = await emitReplyHeartbeat({
    ctx,
    account,
    toAccount: "u-1",
    groupCode: "g-1",
    heartbeat: WS_HEARTBEAT.RUNNING,
    sendTime: 1,
  });
  assert.equal(outcome.shouldStop, false);
});

void test("controller stops periodic heartbeat when group dissolved code received", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { ctx, calls } = fakeCtx({ code: WS_HEARTBEAT_GROUP_DISSOLVED_CODE });
  const ctrl = createReplyHeartbeatController({
    meta: { ctx, account, toAccount: "u-1", groupCode: "g-1" },
    runningIntervalMs: 100,
  });
  ctrl.emit(WS_HEARTBEAT.RUNNING);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, "first RUNNING should be sent");
  mock.timers.tick(100);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, "no further heartbeat after group dissolved");
  ctrl.finishIfNeeded();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, "FINISH should not be sent after group dissolved abort");
});

void test("emitReplyHeartbeat returns when the heartbeat call rejects (caught)", async () => {
  const ctx = { wsClient: { sendPrivateHeartbeat: async () => { throw new Error("ws err"); } } } as unknown as MessageHandlerContext;
  const outcome = await emitReplyHeartbeat({ ctx, account, toAccount: "u-1", heartbeat: WS_HEARTBEAT.RUNNING, sendTime: 1 });
  assert.equal(outcome.shouldStop, false);
});
