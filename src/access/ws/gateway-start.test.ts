/**
 * Integration test for startYuanbaoWsGateway — wires the WS client to the
 * channel lifecycle: auth → onReady status, push → handleInboundMessage, and
 * abort → teardown. ws / sign-token / inbound handler are mocked.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import { BIZ_MSG_TYPES, encodeBizPB, toProtoMsgBody } from "./biz-codec.js";
import { CMD, CMD_TYPE, encodeConnMsg, encodePB, PB_MSG_TYPES, type PBHead } from "./conn-codec.js";
import type { ResolvedYuanbaoAccount } from "../../types.js";

class FakeWebSocket {
  static OPEN = 1; static CONNECTING = 0; static CLOSING = 2; static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  private handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  on(e: string, cb: (...a: unknown[]) => void) { (this.handlers[e] ??= []).push(cb); return this; }
  removeAllListeners() { this.handlers = {}; }
  send() {}
  close() { this.readyState = FakeWebSocket.CLOSED; this.emit("close", 1000, Buffer.from("")); }
  emit(e: string, ...a: unknown[]) { for (const cb of this.handlers[e] ?? []) { cb(...a); } }
}

let inboundCalls: unknown[];
let startYuanbaoWsGateway: typeof import("./gateway.js").startYuanbaoWsGateway;

beforeEach(async () => {
  FakeWebSocket.instances = [];
  inboundCalls = [];
  mock.module("ws", { defaultExport: FakeWebSocket, namedExports: { WebSocket: FakeWebSocket } });
  mock.module("../api.js", {
    namedExports: {
      getSignToken: async () => ({ bot_id: "bot-1", token: "tok", source: "bot", duration: 0, product: "yuanbao" }),
      forceRefreshSignToken: async () => ({ bot_id: "bot-1", token: "tok2", source: "bot", duration: 0, product: "yuanbao" }),
    },
  });
  mock.module("../../business/inbound/index.js", {
    namedExports: { handleInboundMessage: async (p: unknown) => { inboundCalls.push(p); } },
  });
  ({ startYuanbaoWsGateway } = await import("./gateway.js"));
});

afterEach(() => { mock.timers.reset(); mock.restoreAll(); });

function pushFrame(): Buffer {
  const inner = encodeBizPB(BIZ_MSG_TYPES.InboundMessagePush, { fromAccount: "u-1", msgBody: toProtoMsgBody([{ msg_type: "TIMTextElem", msg_content: { text: "hi" } }]) })!;
  const pushData = encodePB(PB_MSG_TYPES.PushMsg, { cmd: "inbound", module: "yuanbao_openclaw_proxy", msgId: "pm", data: inner })!;
  const head: PBHead = { cmdType: CMD_TYPE.Push, cmd: "inbound", seqNo: 1, msgId: "pm", module: "yuanbao_openclaw_proxy", needAck: false };
  return Buffer.from(encodeConnMsg(head, pushData)!);
}

void test("gateway auths, reports connected, dispatches a push to the pipeline, and tears down on abort", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const statuses: Record<string, unknown>[] = [];
  const ac = new AbortController();
  const account = { accountId: "a-1", wsGatewayUrl: "wss://t", wsMaxReconnectAttempts: 3, botId: "", config: {} } as unknown as ResolvedYuanbaoAccount;

  const done = startYuanbaoWsGateway({
    account, config: {} as never, abortSignal: ac.signal,
    runtime: { channel: {} } as never,
    statusSink: (p) => statuses.push(p),
  });

  await new Promise(r => setImmediate(r)); // let resolveWsAuth (async sign-token) settle
  const fake = FakeWebSocket.instances[0];
  assert.ok(fake, "a socket should be created");

  fake.emit("open");
  fake.emit("message", Buffer.from(encodeConnMsg({ cmdType: CMD_TYPE.Response, cmd: CMD.AuthBind, seqNo: 1, msgId: "s", module: "conn_access", status: 0 }, encodePB(PB_MSG_TYPES.AuthBindRsp, { code: 0, connectId: "c-1" })!)!));
  assert.ok(statuses.some(s => s.connected === true), "onReady should report connected");

  fake.emit("message", pushFrame());
  await Promise.resolve();
  assert.equal(inboundCalls.length, 1, "push should reach handleInboundMessage");

  ac.abort();
  await done; // resolves on abort teardown
  assert.ok(statuses.some(s => s.running === false));
});

void test("push without a runtime is decoded but not dispatched to the pipeline", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const ac = new AbortController();
  const account = { accountId: "a-2", wsGatewayUrl: "wss://t", wsMaxReconnectAttempts: 3, botId: "", config: {} } as unknown as ResolvedYuanbaoAccount;

  const done = startYuanbaoWsGateway({ account, config: {} as never, abortSignal: ac.signal }); // no runtime
  await new Promise(r => setImmediate(r));
  const fake = FakeWebSocket.instances[0];
  fake.emit("open");
  fake.emit("message", Buffer.from(encodeConnMsg({ cmdType: CMD_TYPE.Response, cmd: CMD.AuthBind, seqNo: 1, msgId: "s", module: "conn_access", status: 0 }, encodePB(PB_MSG_TYPES.AuthBindRsp, { code: 0, connectId: "c" })!)!));
  fake.emit("message", pushFrame());
  await Promise.resolve();
  assert.equal(inboundCalls.length, 0, "no runtime → message not handled");

  ac.abort();
  await done;
});

void test("immediately-aborted signal tears down without connecting further", async () => {
  const ac = new AbortController();
  ac.abort(); // already aborted before start
  const account = { accountId: "a-3", wsGatewayUrl: "wss://t", wsMaxReconnectAttempts: 3, botId: "", config: {} } as unknown as ResolvedYuanbaoAccount;
  await startYuanbaoWsGateway({ account, config: {} as never, abortSignal: ac.signal, runtime: { channel: {} } as never });
  // resolves immediately via the aborted-signal fast path
});
