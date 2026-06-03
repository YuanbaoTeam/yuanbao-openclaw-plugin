/**
 * Integration test for YuanbaoWsClient connection lifecycle.
 *
 * The `ws` module is mocked with a FakeWebSocket so the handshake (auth-bind),
 * heartbeat scheduling, and auto-reconnect are driven deterministically via
 * emitted events + fake timers. Server frames are built with the real
 * conn-codec so encode/decode is exercised end-to-end on the receive path.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import { CMD, CMD_TYPE, decodeConnMsg, encodeConnMsg, encodePB, PB_MSG_TYPES, type PBHead } from "./conn-codec.js";
import { BIZ_MSG_TYPES, encodeBizPB } from "./biz-codec.js";

/** Minimal stand-in for the `ws` WebSocket. */
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  url: string;
  readyState = FakeWebSocket.OPEN;
  sent: Uint8Array[] = [];
  private handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  on(event: string, cb: (...args: unknown[]) => void): this {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }
  removeAllListeners(): void { this.handlers = {}; }
  send(data: Uint8Array): void { this.sent.push(data); }
  close(code = 1000, reason = ""): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", code, Buffer.from(reason));
  }
  emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers[event] ?? []) { cb(...args); }
  }
}

/** Build a server ConnMsg frame (Response) for a given cmd + inner payload. */
function serverFrame(cmd: string, innerType: string, payload: Record<string, unknown>, status = 0): Buffer {
  const head: PBHead = { cmdType: CMD_TYPE.Response, cmd, seqNo: 1, msgId: "srv", module: "conn_access", status };
  const data = encodePB(innerType, payload)!;
  return Buffer.from(encodeConnMsg(head, data)!);
}

let YuanbaoWsClient: typeof import("./client.js").YuanbaoWsClient;

beforeEach(async () => {
  FakeWebSocket.instances = [];
  mock.module("ws", { defaultExport: FakeWebSocket });
  ({ YuanbaoWsClient } = await import("./client.js"));
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

function makeClient(callbacks: Record<string, unknown> = {}) {
  return new YuanbaoWsClient({
    connection: { gatewayUrl: "wss://test/ws", auth: { bizId: "yuanbao", uid: "u-1", source: "bot", token: "tok" } },
    config: { maxReconnectAttempts: 3, reconnectDelays: [1000, 2000] },
    callbacks: callbacks as never,
  });
}

void test("connect → open → auth-bind handshake reaches connected + onReady", () => {
  mock.timers.enable({ apis: ["setTimeout"] }); // swallow the post-auth heartbeat timer
  const states: string[] = [];
  let ready: { connectId: string } | null = null;
  const client = makeClient({ onStateChange: (s: string) => states.push(s), onReady: (r: { connectId: string }) => { ready = r; } });

  client.connect();
  const fake = FakeWebSocket.instances[0];
  assert.equal(client.getState(), "connecting");

  fake.emit("open"); // client sends auth-bind
  assert.equal(client.getState(), "authenticating");
  assert.ok(fake.sent.length >= 1, "auth-bind frame should be sent");

  // Server replies auth success
  fake.emit("message", serverFrame(CMD.AuthBind, PB_MSG_TYPES.AuthBindRsp, { code: 0, connectId: "conn-1", message: "ok" }));

  assert.equal(client.getState(), "connected");
  assert.equal(client.getConnectId(), "conn-1");
  assert.ok(ready);
  assert.equal(ready!.connectId, "conn-1");
  assert.ok(states.includes("connected"));

  client.disconnect();
});

void test("heartbeat fires after connect and a ping frame is sent", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const client = makeClient();
  client.connect();
  const fake = FakeWebSocket.instances[0];
  fake.emit("open");
  fake.emit("message", serverFrame(CMD.AuthBind, PB_MSG_TYPES.AuthBindRsp, { code: 0, connectId: "c" }));

  const sentBefore = fake.sent.length;
  mock.timers.tick(5000); // first heartbeat delay
  assert.ok(fake.sent.length > sentBefore, "a ping frame should be sent after the heartbeat delay");

  client.disconnect();
});

void test("missing heartbeat ACKs trigger reconnect after consecutive timeout checks", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const client = makeClient();
  client.connect();
  const fake = FakeWebSocket.instances[0];
  fake.emit("open");
  fake.emit("message", serverFrame(CMD.AuthBind, PB_MSG_TYPES.AuthBindRsp, { code: 0, connectId: "c" }));

  mock.timers.tick(5000); // send first ping
  assert.equal(client.getState(), "connected");
  assert.equal(FakeWebSocket.instances.length, 1);

  mock.timers.tick(4000); // first missing-ACK check: warn, keep connection
  assert.equal(client.getState(), "connected");
  assert.equal(FakeWebSocket.instances.length, 1);

  mock.timers.tick(4000); // second consecutive missing-ACK check: reconnect
  assert.equal(client.getState(), "reconnecting");
  mock.timers.tick(1000);
  assert.equal(FakeWebSocket.instances.length, 2, "a new socket should be created after heartbeat timeouts");

  client.disconnect();
});

void test("retryable close schedules a reconnect (new socket after delay)", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const client = makeClient();
  client.connect();
  const fake = FakeWebSocket.instances[0];

  fake.emit("close", 1006, Buffer.from("abnormal")); // retryable
  assert.equal(client.getState(), "reconnecting");
  assert.equal(FakeWebSocket.instances.length, 1);

  mock.timers.tick(1000); // first reconnect delay
  assert.equal(FakeWebSocket.instances.length, 2, "a new socket should be created on reconnect");

  client.disconnect();
});

void test("non-retryable close code gives up and reports error", () => {
  let errored: Error | null = null;
  const client = makeClient({ onError: (e: Error) => { errored = e; } });
  client.connect();
  const fake = FakeWebSocket.instances[0];

  fake.emit("close", 4012, Buffer.from("version ban")); // non-retryable
  assert.equal(client.getState(), "disconnected");
  assert.ok(errored, "onError should fire for a non-retryable close");
  assert.equal(FakeWebSocket.instances.length, 1, "must not reconnect");

  client.disconnect();
});

/** Connect + complete auth so the client is in "connected" state. */
function connectAndAuth(callbacks: Record<string, unknown> = {}) {
  const client = makeClient(callbacks);
  client.connect();
  const fake = FakeWebSocket.instances[0];
  fake.emit("open");
  fake.emit("message", serverFrame(CMD.AuthBind, PB_MSG_TYPES.AuthBindRsp, { code: 0, connectId: "c" }));
  return { client, fake };
}

void test("sendC2CMessage round-trips: encodes request, resolves on matching response", async () => {
  mock.timers.enable({ apis: ["setTimeout"] }); // swallow heartbeat + request-timeout timers
  const { client, fake } = connectAndAuth();

  const p = client.sendC2CMessage({ to_account: "u-2", msg_body: [{ msg_type: "TIMTextElem", msg_content: { text: "hi" } }] });

  // The last sent frame is the business request; pull its generated msgId back out.
  const reqFrame = fake.sent[fake.sent.length - 1];
  const msgId = decodeConnMsg(reqFrame)!.head.msgId;
  assert.ok(msgId);

  // Server answers with the same msgId.
  const head: PBHead = { cmdType: CMD_TYPE.Response, cmd: "send_c2c_message", seqNo: 2, msgId, module: "yuanbao_openclaw_proxy", status: 0 };
  const data = encodeBizPB(BIZ_MSG_TYPES.SendC2CMessageRsp, { code: 0, message: "ok" })!;
  fake.emit("message", Buffer.from(encodeConnMsg(head, data)!));

  const rsp = await p;
  assert.equal(rsp.code, 0);
  assert.equal(rsp.msgId, msgId);

  client.disconnect();
});

void test("onPush dispatches an inbound push event to onDispatch", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let dispatched: { cmd?: string } | null = null;
  const { client, fake } = connectAndAuth({ onDispatch: (e: { cmd?: string }) => { dispatched = e; } });

  const pushData = encodePB(PB_MSG_TYPES.PushMsg, { cmd: "inbound", module: "yuanbao_openclaw_proxy", msgId: "pm-1", data: new Uint8Array([1, 2, 3]) })!;
  const head: PBHead = { cmdType: CMD_TYPE.Push, cmd: "inbound", seqNo: 3, msgId: "pm-1", module: "yuanbao_openclaw_proxy", needAck: false };
  fake.emit("message", Buffer.from(encodeConnMsg(head, pushData)!));

  assert.ok(dispatched, "onDispatch should fire for a push");
  assert.equal(dispatched!.cmd, "inbound");

  client.disconnect();
});

void test("ALREADY_AUTH (41101) is treated as auth success", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const client = makeClient();
  client.connect();
  const fake = FakeWebSocket.instances[0];
  fake.emit("open");
  fake.emit("message", serverFrame(CMD.AuthBind, PB_MSG_TYPES.AuthBindRsp, { code: 41101, connectId: "c2" }, 41101));
  assert.equal(client.getState(), "connected");
  assert.equal(client.getConnectId(), "c2");
  client.disconnect();
});

void test("kickout push fires onKickout", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let kicked: { reason: string } | null = null;
  const { client, fake } = connectAndAuth({ onKickout: (k: { reason: string }) => { kicked = k; } });
  const data = encodePB(PB_MSG_TYPES.KickoutMsg, { status: 1, reason: "dup-login", otherDeviceName: "iPhone" })!;
  const head: PBHead = { cmdType: CMD_TYPE.Push, cmd: CMD.Kickout, seqNo: 4, msgId: "k-1", module: "conn_access", needAck: false };
  fake.emit("message", Buffer.from(encodeConnMsg(head, data)!));
  assert.ok(kicked);
  assert.equal(kicked!.reason, "dup-login");
  client.disconnect();
});

void test("business response with non-zero head.status overrides code to FAIL", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { client, fake } = connectAndAuth();
  const p = client.sendC2CMessage({ to_account: "u", msg_body: [{ msg_type: "TIMTextElem", msg_content: { text: "x" } }] });
  const msgId = decodeConnMsg(fake.sent[fake.sent.length - 1])!.head.msgId;
  const head: PBHead = { cmdType: CMD_TYPE.Response, cmd: "send_c2c_message", seqNo: 5, msgId, module: "yuanbao_openclaw_proxy", status: 500 };
  const data = encodeBizPB(BIZ_MSG_TYPES.SendC2CMessageRsp, { code: 0, message: "" })!;
  fake.emit("message", Buffer.from(encodeConnMsg(head, data)!));
  const rsp = await p;
  assert.equal(rsp.code, 500);
  assert.equal(rsp.message, "FAIL");
  client.disconnect();
});

/** Drive a request method to completion by echoing a response with the same msgId. */
async function roundTrip<T>(
  fake: FakeWebSocket,
  call: () => Promise<T>,
  rspType: string,
  rspPayload: Record<string, unknown>,
): Promise<T> {
  const p = call();
  await Promise.resolve();
  const msgId = decodeConnMsg(fake.sent[fake.sent.length - 1])!.head.msgId;
  const head: PBHead = { cmdType: CMD_TYPE.Response, cmd: "biz", seqNo: 9, msgId, module: "yuanbao_openclaw_proxy", status: 0 };
  fake.emit("message", Buffer.from(encodeConnMsg(head, encodeBizPB(rspType, rspPayload)!)!));
  return p;
}

void test("sendGroupMessage resolves on matching response", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { client, fake } = connectAndAuth();
  const rsp = await roundTrip(fake, () => client.sendGroupMessage({ group_code: "g-1", msg_body: [{ msg_type: "TIMTextElem", msg_content: { text: "hi" } }] }), BIZ_MSG_TYPES.SendGroupMessageRsp, { code: 0, message: "ok" });
  assert.equal(rsp.code, 0);
  client.disconnect();
});

void test("queryGroupInfo decodes nested group info", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { client, fake } = connectAndAuth();
  const rsp = await roundTrip(fake, () => client.queryGroupInfo({ group_code: "g-1" }), BIZ_MSG_TYPES.QueryGroupInfoRsp, {
    code: 0, msg: "ok", groupInfo: { groupName: "G", groupOwnerUserId: "o", groupOwnerNickname: "owner", groupSize: 3 },
  });
  assert.equal(rsp.group_info?.group_name, "G");
  client.disconnect();
});

void test("getGroupMemberList decodes the member list", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { client, fake } = connectAndAuth();
  const rsp = await roundTrip(fake, () => client.getGroupMemberList({ group_code: "g-1" }), BIZ_MSG_TYPES.GetGroupMemberListRsp, {
    code: 0, message: "ok", memberList: [{ userId: "u1", nickName: "n1", userType: 1 }],
  });
  assert.equal(rsp.member_list.length, 1);
  client.disconnect();
});

void test("sendPrivateHeartbeat / sendGroupHeartbeat resolve", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { client, fake } = connectAndAuth();
  const pvt = await roundTrip(fake, () => client.sendPrivateHeartbeat({ from_account: "b", to_account: "u", heartbeat: 1 as never }), BIZ_MSG_TYPES.SendPrivateHeartbeatRsp, { code: 0, msg: "running" });
  assert.equal(pvt.code, 0);
  const grp = await roundTrip(fake, () => client.sendGroupHeartbeat({ from_account: "b", to_account: "u", group_code: "g", send_time: 1, heartbeat: 2 as never }), BIZ_MSG_TYPES.SendGroupHeartbeatRsp, { code: 0, msg: "done" });
  assert.equal(grp.code, 0);
  client.disconnect();
});

void test("syncInformation resolves", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { client, fake } = connectAndAuth();
  const rsp = await roundTrip(fake, () => client.syncInformation({ syncType: 1, botVersion: "1", pluginVersion: "2" }), BIZ_MSG_TYPES.SyncInformationRsp, { code: 0, msg: "ok" });
  assert.equal(rsp.code, 0);
  client.disconnect();
});

void test("queryBotInfo round-trips and decodes the bot owner id", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { client, fake } = connectAndAuth();
  const rsp = await roundTrip(
    fake,
    () => client.queryBotInfo("bot-001"),
    BIZ_MSG_TYPES.QueryBotInfoRsp,
    { code: 0, message: "ok", botInfo: { botId: "bot-001", encryptOwnerId: "owner-xyz" } },
  );
  assert.equal(rsp.code, 0);
  assert.equal(rsp.botId, "bot-001");
  assert.equal(rsp.ownerId, "owner-xyz");
  client.disconnect();
});

void test("sendC2CMessage rejects when the socket is not connected", async () => {
  const client = makeClient();
  // never connect → no socket
  await assert.rejects(client.sendC2CMessage({ to_account: "u", msg_body: [{ msg_type: "TIMTextElem", msg_content: { text: "x" } }] }), /not connected/);
});

void test("sendAndWait rejects on request timeout", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { client } = connectAndAuth();
  const p = client.sendC2CMessage({ to_account: "u", msg_body: [{ msg_type: "TIMTextElem", msg_content: { text: "x" } }] });
  const assertion = assert.rejects(p, /timeout/);
  mock.timers.tick(30_000); // default send timeout
  await assertion;
  client.disconnect();
});

void test("auth failure code triggers onAuthFailed refresh then reconnect", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let refreshed = false;
  const client = makeClient({
    onAuthFailed: async () => { refreshed = true; return { bizId: "yuanbao", uid: "u-1", source: "bot", token: "new-tok" }; },
  });
  client.connect();
  const fake = FakeWebSocket.instances[0];
  fake.emit("open");
  // head.status non-zero + rsp.code = 41103 (AUTH_FAILED)
  fake.emit("message", serverFrame(CMD.AuthBind, PB_MSG_TYPES.AuthBindRsp, { code: 41103 }, 41103));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(refreshed, true, "onAuthFailed should be invoked");
  assert.equal(client.getState(), "reconnecting");
  mock.timers.tick(1000);
  assert.equal(FakeWebSocket.instances.length, 2, "reconnect with refreshed token");
  client.disconnect();
});

void test("retryable auth error reconnects without token refresh", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const client = makeClient();
  client.connect();
  const fake = FakeWebSocket.instances[0];
  fake.emit("open");
  // head.status non-zero + rsp.code = 50400 (AUTH_RETRYABLE)
  fake.emit("message", serverFrame(CMD.AuthBind, PB_MSG_TYPES.AuthBindRsp, { code: 50400 }, 50400));
  assert.equal(client.getState(), "reconnecting");
  mock.timers.tick(1000);
  assert.equal(FakeWebSocket.instances.length, 2);
  client.disconnect();
});

void test("unrecognized push (empty data) still dispatches raw + ACKs when needAck", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  let dispatched = false;
  const { client, fake } = connectAndAuth({ onDispatch: () => { dispatched = true; } });
  const sentBefore = fake.sent.length;
  const head: PBHead = { cmdType: CMD_TYPE.Push, cmd: "x", seqNo: 3, msgId: "p", module: "m", needAck: true };
  fake.emit("message", Buffer.from(encodeConnMsg(head, new Uint8Array(0))!));
  assert.equal(dispatched, true);
  assert.ok(fake.sent.length > sentBefore, "needAck push should send an ACK");
  client.disconnect();
});

void test("unmatched business response is ignored", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { client, fake } = connectAndAuth();
  const head: PBHead = { cmdType: CMD_TYPE.Response, cmd: "send_c2c_message", seqNo: 4, msgId: "never-sent", module: "m", status: 0 };
  // no pending request with this msgId → handled gracefully (no throw)
  assert.doesNotThrow(() => fake.emit("message", Buffer.from(encodeConnMsg(head, encodeBizPB(BIZ_MSG_TYPES.SendC2CMessageRsp, { code: 0 })!)!)));
  client.disconnect();
});

void test("business response with undecodable data resolves to a basic response", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { client, fake } = connectAndAuth();
  const p = client.sendC2CMessage({ to_account: "u", msg_body: [{ msg_type: "TIMTextElem", msg_content: { text: "x" } }] });
  await Promise.resolve();
  const msgId = decodeConnMsg(fake.sent[fake.sent.length - 1])!.head.msgId;
  const head: PBHead = { cmdType: CMD_TYPE.Response, cmd: "send_c2c_message", seqNo: 5, msgId, module: "m", status: 7 };
  fake.emit("message", Buffer.from(encodeConnMsg(head, new Uint8Array([0x08, 0xff]))!)); // undecodable
  const rsp = await p;
  assert.equal(rsp.code, 7); // basic response uses head.status
  client.disconnect();
});

void test("sendBinary fails (rejects send) when socket is not OPEN", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { client, fake } = connectAndAuth();
  fake.readyState = FakeWebSocket.CLOSED; // simulate closed socket
  await assert.rejects(client.sendC2CMessage({ to_account: "u", msg_body: [{ msg_type: "TIMTextElem", msg_content: { text: "x" } }] }), /not connected/);
  client.disconnect();
});

void test("disconnect resolves pending requests with a disconnect response", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { client } = connectAndAuth();
  const p = client.sendC2CMessage({ to_account: "u", msg_body: [{ msg_type: "TIMTextElem", msg_content: { text: "x" } }] });
  client.disconnect(); // cleanup resolves pending with code -1
  const rsp = await p;
  assert.equal(rsp.code, -1);
});

void test("disconnect after connecting transitions to disconnected and blocks reconnect", () => {
  const client = makeClient();
  client.connect();
  client.disconnect();
  assert.equal(client.getState(), "disconnected");
  // A close after disposal must not schedule a reconnect.
  FakeWebSocket.instances[0].emit("close", 1006, Buffer.from(""));
  assert.equal(FakeWebSocket.instances.length, 1);
});
