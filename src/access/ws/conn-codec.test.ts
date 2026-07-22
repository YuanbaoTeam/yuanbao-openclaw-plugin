/**
 * Unit tests for access/ws/conn-codec.ts — connection-layer protobuf codec.
 *
 * Covers:
 *  - PROTO-001 golden decode vectors (semantics locked by yuanbao-bot-spec;
 *    hex literals copied inline so the plugin test stays self-contained — no
 *    cross-repo dependency).
 *  - encode/decode round-trip equivalence.
 *  - frame builders (auth-bind / ping / push-ack / business).
 *  - error branches (invalid type key, garbage bytes).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { initEnv } from "../../infra/env.js";
import {
  buildAuthBindMsg,
  buildBusinessConnMsg,
  buildPingMsg,
  buildPushAck,
  CMD,
  CMD_TYPE,
  createHead,
  decodeConnMsg,
  decodePB,
  encodeConnMsg,
  encodePB,
  MODULE,
  nextSeqNo,
  PB_MSG_TYPES,
  type PBConnMsg,
  type PBHead,
} from "./conn-codec.js";

/** Extract a comparable plain object from a decoded ConnMsg (mirrors PROTO-001 expected shape). */
function toFrame(msg: PBConnMsg | null) {
  assert.ok(msg, "decode returned null");
  const head = msg.head;
  return {
    cmd_type: head.cmdType ?? 0,
    cmd: head.cmd ?? "",
    seq_no: head.seqNo ?? 0,
    msg_id: head.msgId ?? "",
    module: head.module ?? "",
    need_ack: Boolean(head.needAck),
    status: head.status ?? 0,
    data_hex: Buffer.from(msg.data ?? new Uint8Array(0)).toString("hex"),
  };
}

// ── PROTO-001 golden vectors (from yuanbao-bot-spec; values inlined) ──────────
// Each logical message has two valid proto3 encodings (minimal vs protobufjs
// default-included); both must decode to the same frame.
const PROTO_001_CASES: Array<{ id: string; wire_hex: string; expected: ReturnType<typeof toFrame> }> = [
  {
    id: "auth-bind-empty-data-hermes-openhuman-style",
    wire_hex: "0a201209617574682d62696e6422066162633132332a0b636f6e6e5f616363657373",
    expected: { cmd_type: 0, cmd: "auth-bind", seq_no: 0, msg_id: "abc123", module: "conn_access", need_ack: false, status: 0, data_hex: "" },
  },
  {
    id: "auth-bind-empty-data-openclaw-style",
    wire_hex: "0a2808001209617574682d62696e64180022066162633132332a0b636f6e6e5f616363657373300050001200",
    expected: { cmd_type: 0, cmd: "auth-bind", seq_no: 0, msg_id: "abc123", module: "conn_access", need_ack: false, status: 0, data_hex: "" },
  },
  {
    id: "ping-with-seq-hermes-openhuman-style",
    wire_hex: "0a1e120470696e67182a22076d73672d78797a2a0b636f6e6e5f616363657373",
    expected: { cmd_type: 0, cmd: "ping", seq_no: 42, msg_id: "msg-xyz", module: "conn_access", need_ack: false, status: 0, data_hex: "" },
  },
  {
    id: "ping-with-seq-openclaw-style",
    wire_hex: "0a240800120470696e67182a22076d73672d78797a2a0b636f6e6e5f616363657373300050001200",
    expected: { cmd_type: 0, cmd: "ping", seq_no: 42, msg_id: "msg-xyz", module: "conn_access", need_ack: false, status: 0, data_hex: "" },
  },
  {
    id: "push-with-data-hermes-openhuman-style",
    wire_hex: "0a2f08021207696e626f756e6418642206706d2d3030312a167975616e62616f5f6f70656e636c61775f70726f7879300112070a0568656c6c6f",
    expected: { cmd_type: 2, cmd: "inbound", seq_no: 100, msg_id: "pm-001", module: "yuanbao_openclaw_proxy", need_ack: true, status: 0, data_hex: "0a0568656c6c6f" },
  },
  {
    id: "push-with-data-openclaw-style",
    wire_hex: "0a3108021207696e626f756e6418642206706d2d3030312a167975616e62616f5f6f70656e636c61775f70726f78793001500012070a0568656c6c6f",
    expected: { cmd_type: 2, cmd: "inbound", seq_no: 100, msg_id: "pm-001", module: "yuanbao_openclaw_proxy", need_ack: true, status: 0, data_hex: "0a0568656c6c6f" },
  },
  {
    id: "response-with-status-hermes-openhuman-style",
    wire_hex: "0a2708011209617574682d62696e64180122057273702d312a0b636f6e6e5f616363657373508dc102",
    expected: { cmd_type: 1, cmd: "auth-bind", seq_no: 1, msg_id: "rsp-1", module: "conn_access", need_ack: false, status: 41101, data_hex: "" },
  },
  {
    id: "response-with-status-openclaw-style",
    wire_hex: "0a2908011209617574682d62696e64180122057273702d312a0b636f6e6e5f6163636573733000508dc1021200",
    expected: { cmd_type: 1, cmd: "auth-bind", seq_no: 1, msg_id: "rsp-1", module: "conn_access", need_ack: false, status: 41101, data_hex: "" },
  },
];

for (const c of PROTO_001_CASES) {
  void test(`PROTO-001 golden decode: ${c.id}`, () => {
    const frame = toFrame(decodeConnMsg(Buffer.from(c.wire_hex, "hex")));
    assert.deepEqual(frame, c.expected);
  });
}

// ── round-trip ────────────────────────────────────────────────────────────────
void test("encodeConnMsg → decodeConnMsg round-trip preserves head + data", () => {
  const head: PBHead = { cmdType: CMD_TYPE.Push, cmd: "inbound", seqNo: 7, msgId: "m-7", module: "biz", needAck: true, status: 0 };
  const data = new Uint8Array([1, 2, 3, 4]);
  const encoded = encodeConnMsg(head, data);
  assert.ok(encoded);
  const decoded = toFrame(decodeConnMsg(encoded));
  assert.equal(decoded.cmd, "inbound");
  assert.equal(decoded.seq_no, 7);
  assert.equal(decoded.msg_id, "m-7");
  assert.equal(decoded.need_ack, true);
  assert.equal(decoded.data_hex, "01020304");
});

void test("encodePB → decodePB round-trip for AuthBindReq payload", () => {
  const payload = {
    bizId: "biz-1",
    authInfo: { uid: "u-1", source: "openclaw", token: "tok" },
    deviceInfo: { appVersion: "1.0", appOperationSystem: "mac", botVersion: "2.0", instanceId: "16" },
  };
  const bytes = encodePB(PB_MSG_TYPES.AuthBindReq, payload);
  assert.ok(bytes);
  const back = decodePB(PB_MSG_TYPES.AuthBindReq, bytes) as Record<string, any>;
  assert.equal(back.bizId, "biz-1");
  assert.equal(back.authInfo.uid, "u-1");
  assert.equal(back.deviceInfo.botVersion, "2.0");
});

// ── frame builders ──────────────────────────────────────────────────────────
void test("buildAuthBindMsg produces a decodable auth-bind frame with nested payload", () => {
  initEnv({ version: "1.0", config: { meta: { lastTouchedVersion: "2.0" } } } as any);
  const frame = buildAuthBindMsg({
    bizId: "biz-1",
    uid: "u-1",
    source: "openclaw",
    token: "tok",
    msgId: "m-1",
  });
  assert.ok(frame);
  const decoded = decodeConnMsg(frame);
  assert.ok(decoded);
  assert.equal(decoded.head.cmd, CMD.AuthBind);
  assert.equal(decoded.head.module, MODULE.ConnAccess);
  const inner = decodePB(PB_MSG_TYPES.AuthBindReq, decoded.data) as Record<string, any>;
  assert.equal(inner.bizId, "biz-1");
  assert.equal(inner.authInfo.token, "tok");
  assert.equal(inner.deviceInfo.appVersion, "1.0");
  assert.equal(inner.deviceInfo.botVersion, "2.0");
  assert.equal(inner.deviceInfo.instanceId, "16");
});

void test("buildAuthBindMsg includes envName when routeEnv provided", () => {
  const frame = buildAuthBindMsg({
    bizId: "b", uid: "u", source: "s", token: "t", msgId: "m", routeEnv: "test-env",
  });
  assert.ok(frame);
  const inner = decodePB(PB_MSG_TYPES.AuthBindReq, decodeConnMsg(frame)!.data) as Record<string, any>;
  assert.equal(inner.envName, "test-env");
});

void test("buildPingMsg produces a ping frame", () => {
  const frame = buildPingMsg("ping-1");
  assert.ok(frame);
  const decoded = decodeConnMsg(frame);
  assert.equal(decoded!.head.cmd, CMD.Ping);
  assert.equal(decoded!.head.msgId, "ping-1");
});

void test("buildPushAck flips cmdType to PushAck and keeps identity fields", () => {
  const original: PBHead = { cmdType: CMD_TYPE.Push, cmd: "inbound", seqNo: 5, msgId: "m-5", module: "biz", needAck: true };
  const ack = buildPushAck(original);
  assert.ok(ack);
  const decoded = decodeConnMsg(ack);
  assert.equal(decoded!.head.cmdType, CMD_TYPE.PushAck);
  assert.equal(decoded!.head.cmd, "inbound");
  assert.equal(decoded!.head.msgId, "m-5");
});

void test("buildBusinessConnMsg wraps biz data under given cmd/module", () => {
  const bizData = new Uint8Array([9, 8, 7]);
  const frame = buildBusinessConnMsg("send-c2c", "biz_mod", bizData, "m-9");
  assert.ok(frame);
  const decoded = decodeConnMsg(frame);
  assert.equal(decoded!.head.cmd, "send-c2c");
  assert.equal(decoded!.head.module, "biz_mod");
  assert.equal(Buffer.from(decoded!.data).toString("hex"), "090807");
});

// ── helpers ──────────────────────────────────────────────────────────────────
void test("createHead sets Request cmdType and an incrementing seqNo", () => {
  const h1 = createHead("ping", "conn_access", "m-1");
  const h2 = createHead("ping", "conn_access", "m-2");
  assert.equal(h1.cmdType, CMD_TYPE.Request);
  assert.equal(h1.cmd, "ping");
  assert.equal(typeof h1.seqNo, "number");
  assert.equal(h2.seqNo, h1.seqNo + 1);
});

void test("nextSeqNo increments monotonically", () => {
  const a = nextSeqNo();
  const b = nextSeqNo();
  assert.equal(b, a + 1);
});

// ── error branches ────────────────────────────────────────────────────────────
void test("encodePB returns null for an unknown message type", () => {
  assert.equal(encodePB("trpc.unknown.NotAType", {}), null);
});

void test("decodePB returns null for an unknown message type", () => {
  assert.equal(decodePB("trpc.unknown.NotAType", new Uint8Array([1, 2, 3])), null);
});

void test("decodeConnMsg returns null on malformed bytes (truncated length-delimited)", () => {
  // tag 1 (head), wire type 2, declared length 0x7f but no payload → decode error.
  assert.equal(decodeConnMsg(new Uint8Array([0x0a, 0x7f])), null);
});

void test("decodeConnMsg accepts ArrayBuffer input", () => {
  const frame = buildPingMsg("ab-1");
  assert.ok(frame);
  const ab = frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength);
  const decoded = decodeConnMsg(ab);
  assert.equal(decoded!.head.cmd, CMD.Ping);
});
