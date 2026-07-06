/**
 * Unit tests for access/ws/biz-codec.ts — business-layer protobuf codec.
 *
 * Covers encode round-trips (encode req → decode back via decodeBizPB), every
 * Rsp/inbound decoder (encode a server-shaped message → decode → assert the
 * snake_case mapping), msg-body conversion, and error branches.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  BIZ_MSG_TYPES,
  decodeBizPB,
  decodeGetGroupMemberListRsp,
  decodeInboundMessage,
  decodeQueryGroupInfoRsp,
  decodeSendC2CMessageRsp,
  decodeSendGroupHeartbeatRsp,
  decodeSendGroupMessageRsp,
  decodeSendMessageRsp,
  decodeSendPrivateHeartbeatRsp,
  decodeSyncInformationRsp,
  decodeQueryBotInfoRsp,
  encodeBizPB,
  encodeGetGroupMemberListReq,
  encodeQueryBotInfoReq,
  encodeQueryGroupInfoReq,
  encodeSendC2CMessageReq,
  encodeSendGroupHeartbeatReq,
  encodeSendGroupMessageReq,
  encodeSendPrivateHeartbeatReq,
  encodeSyncInformationReq,
  fromProtoMsgBody,
  toProtoMsgBody,
} from "./biz-codec.js";
import { WS_HEARTBEAT } from "./types.js";
import type { YuanbaoMsgBodyElement } from "../../types.js";

// protobufjs decodes to a loosely-typed object whose nested fields are accessed
// freely in assertions; a permissive shape keeps the round-trip tests readable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DecodedPB = Record<string, any>;

const textBody: YuanbaoMsgBodyElement[] = [
  { msg_type: "TIMTextElem", msg_content: { text: "hello" } },
];

// ── msg-body conversion round-trip ─────────────────────────────────────────
void test("toProtoMsgBody → fromProtoMsgBody round-trips text element", () => {
  const proto = toProtoMsgBody(textBody);
  const back = fromProtoMsgBody(proto);
  assert.equal(back.length, 1);
  assert.equal(back[0].msg_type, "TIMTextElem");
  assert.equal(back[0].msg_content.text, "hello");
});

void test("toProtoMsgBody → fromProtoMsgBody round-trips a fully-populated element", () => {
  const full: YuanbaoMsgBodyElement[] = [{
    msg_type: "TIMImageElem",
    msg_content: {
      text: "t", uuid: "u", image_format: 2, data: "d", desc: "ds", ext: "e", sound: "s",
      image_info_array: [{ url: "http://x", height: 1, width: 2, type: 0, size: 3 }],
      index: 4, url: "http://y", file_size: 5, file_name: "f.png",
    },
  }];
  const back = fromProtoMsgBody(toProtoMsgBody(full));
  const c = back[0].msg_content;
  assert.equal(c.text, "t");
  assert.equal(c.uuid, "u");
  assert.equal(c.image_format, 2);
  assert.equal(c.sound, "s");
  assert.equal(c.file_name, "f.png");
  assert.equal((c.image_info_array as unknown[]).length, 1);
});

void test("toProtoMsgBody → fromProtoMsgBody round-trips ext_map (forwarded record detail)", () => {
  const extMap = { wexin_forward_msg_fid_u1: "CAEiBG1pbmUqAwoBbQ==" };
  const body: YuanbaoMsgBodyElement[] = [
    { msg_type: "TIMCustomElem", msg_content: { data: JSON.stringify({ elem_type: 1009 }), ext_map: extMap } },
  ];
  const back = fromProtoMsgBody(toProtoMsgBody(body));
  assert.deepEqual(back[0].msg_content.ext_map, extMap);
});

void test("fromProtoMsgBody omits empty ext_map", () => {
  const body: YuanbaoMsgBodyElement[] = [
    { msg_type: "TIMCustomElem", msg_content: { data: "{}", ext_map: {} } },
  ];
  const back = fromProtoMsgBody(toProtoMsgBody(body));
  assert.equal(back[0].msg_content.ext_map, undefined);
});

void test("fromProtoMsgBody returns [] for non-array input", () => {
  assert.deepEqual(fromProtoMsgBody(undefined as unknown as []), []);
  assert.deepEqual(fromProtoMsgBody([]), []);
});

void test("toProtoMsgBody maps snake_case media fields to camelCase", () => {
  const proto = toProtoMsgBody([
    { msg_type: "TIMImageElem", msg_content: { uuid: "u1", image_format: 1, file_size: 99, file_name: "a.png" } },
  ]);
  const mc = proto[0].msgContent as Record<string, unknown>;
  assert.equal(mc.uuid, "u1");
  assert.equal(mc.imageFormat, 1);
  assert.equal(mc.fileSize, 99);
  assert.equal(mc.fileName, "a.png");
});

// ── encode requests (round-trip via decodeBizPB) ────────────────────────────
void test("encodeSendC2CMessageReq encodes target + body + seq", () => {
  const bytes = encodeSendC2CMessageReq({
    to_account: "u-2", from_account: "bot", msg_id: "m-1", msg_random: 7, msg_seq: 3,
    trace_id: "t-1", msg_body: textBody,
  });
  assert.ok(bytes);
  const back = decodeBizPB(BIZ_MSG_TYPES.SendC2CMessageReq, bytes) as DecodedPB;
  assert.equal(back.toAccount, "u-2");
  assert.equal(back.fromAccount, "bot");
  assert.equal(Number(back.msgSeq), 3); // int64 → protobufjs Long
  assert.equal(back.logExt.traceId, "t-1");
  assert.equal(back.msgBody[0].msgContent.text, "hello");
});

void test("encodeSendGroupMessageReq encodes group + ref + body", () => {
  const bytes = encodeSendGroupMessageReq({
    group_code: "g-1", from_account: "bot", ref_msg_id: "ref-1", msg_body: textBody,
  });
  assert.ok(bytes);
  const back = decodeBizPB(BIZ_MSG_TYPES.SendGroupMessageReq, bytes) as DecodedPB;
  assert.equal(back.groupCode, "g-1");
  assert.equal(back.refMsgId, "ref-1");
  assert.equal(back.msgBody[0].msgContent.text, "hello");
});

void test("encodeSendGroupMessageReq round-trips cloudCustomData when set", () => {
  const bytes = encodeSendGroupMessageReq({
    group_code: "g-1", msg_body: textBody, cloud_custom_data: JSON.stringify({ topicId: "t-42" }),
  });
  assert.ok(bytes);
  const back = decodeBizPB(BIZ_MSG_TYPES.SendGroupMessageReq, bytes) as DecodedPB;
  assert.equal(back.cloudCustomData, JSON.stringify({ topicId: "t-42" }));
});

void test("encodeSendPrivateHeartbeatReq dual-writes fromAccount/fromtAccount", () => {
  const bytes = encodeSendPrivateHeartbeatReq({
    from_account: "bot", to_account: "u-1", heartbeat: WS_HEARTBEAT.RUNNING,
  });
  assert.ok(bytes);
  const back = decodeBizPB(BIZ_MSG_TYPES.SendPrivateHeartbeatReq, bytes) as DecodedPB;
  assert.equal(back.fromAccount, "bot");
  assert.equal(back.heartbeat, WS_HEARTBEAT.RUNNING);
});

void test("encodeSendGroupHeartbeatReq encodes group heartbeat", () => {
  const bytes = encodeSendGroupHeartbeatReq({
    from_account: "bot", to_account: "u-1", group_code: "g-1", send_time: 123, heartbeat: WS_HEARTBEAT.FINISH,
  });
  assert.ok(bytes);
  const back = decodeBizPB(BIZ_MSG_TYPES.SendGroupHeartbeatReq, bytes) as DecodedPB;
  assert.equal(back.groupCode, "g-1");
  assert.equal(Number(back.sendTime), 123); // int64 → protobufjs Long
});

void test("encodeQueryGroupInfoReq / encodeGetGroupMemberListReq carry groupCode", () => {
  const q = decodeBizPB(BIZ_MSG_TYPES.QueryGroupInfoReq, encodeQueryGroupInfoReq({ group_code: "g-1" })!) as DecodedPB;
  assert.equal(q.groupCode, "g-1");
  const m = decodeBizPB(BIZ_MSG_TYPES.GetGroupMemberListReq, encodeGetGroupMemberListReq({ group_code: "g-2" })!) as DecodedPB;
  assert.equal(m.groupCode, "g-2");
});

void test("encodeSyncInformationReq includes commandData when provided", () => {
  const bytes = encodeSyncInformationReq({
    syncType: 1, botVersion: "1.0", pluginVersion: "2.0",
    commandData: { botCommands: [{ name: "/new", description: "new" }], pluginCommands: [] },
  });
  assert.ok(bytes);
  const back = decodeBizPB(BIZ_MSG_TYPES.SyncInformationReq, bytes) as DecodedPB;
  assert.equal(back.botVersion, "1.0");
  assert.equal(back.commandData.botCommands[0].name, "/new");
});

// ── decode inbound message (camel → snake mapping) ──────────────────────────
void test("decodeInboundMessage maps fields and converts msgBody", () => {
  const bytes = encodeBizPB(BIZ_MSG_TYPES.InboundMessagePush, {
    fromAccount: "u-1", toAccount: "bot", groupCode: "g-1", msgId: "m-1", msgSeq: 42,
    msgBody: toProtoMsgBody(textBody), logExt: { traceId: "trace-9" },
  });
  assert.ok(bytes);
  const inbound = decodeInboundMessage(bytes);
  assert.ok(inbound);
  assert.equal(inbound.from_account, "u-1");
  assert.equal(inbound.group_code, "g-1");
  assert.equal(inbound.msg_seq, 42);
  assert.equal(inbound.trace_id, "trace-9");
  assert.equal(inbound.seq_id, "42");
  assert.equal(inbound.msg_body?.[0].msg_content.text, "hello");
});

void test("decodeInboundMessage populates every optional field (truthy branches)", () => {
  const bytes = encodeBizPB(BIZ_MSG_TYPES.InboundMessagePush, {
    callbackCommand: "cb", fromAccount: "u-1", toAccount: "bot", senderNickname: "Nick",
    groupId: "gid", groupCode: "g-1", groupName: "G", msgSeq: 5, msgRandom: 9, msgTime: 111,
    msgKey: "k", msgId: "m-1", cloudCustomData: "cc", eventTime: 222, botOwnerId: "owner",
    recallMsgSeqList: [{ msgSeq: 1 }], clawMsgType: 1, privateFromGroupCode: "pg",
    msgBody: toProtoMsgBody(textBody), logExt: { traceId: "tr" },
  });
  assert.ok(bytes);
  const m = decodeInboundMessage(bytes)!;
  assert.equal(m.callback_command, "cb");
  assert.equal(m.sender_nickname, "Nick");
  assert.equal(m.group_name, "G");
  assert.equal(m.cloud_custom_data, "cc");
  assert.equal(m.bot_owner_id, "owner");
  assert.equal(m.private_from_group_code, "pg");
  assert.equal(m.claw_msg_type, 1);
  assert.ok(Array.isArray(m.recall_msg_seq_list));
});

void test("decodeInboundMessage on empty push yields undefined optionals (falsy branches)", () => {
  const bytes = encodeBizPB(BIZ_MSG_TYPES.InboundMessagePush, {})!;
  const m = decodeInboundMessage(bytes)!;
  assert.equal(m.from_account, undefined);
  assert.equal(m.group_code, undefined);
  assert.deepEqual(m.msg_body, []); // repeated field decodes to [] (truthy) → fromProtoMsgBody([])
  assert.equal(m.trace_id, undefined);
  assert.equal(m.seq_id, "0"); // msgSeq int64 defaults to Long(0), always present → String(0)
});

// ── decode responses ─────────────────────────────────────────────────────────
void test("decodeSendC2CMessageRsp / GroupMessageRsp preserve msgId + code/message", () => {
  const c2c = encodeBizPB(BIZ_MSG_TYPES.SendC2CMessageRsp, { code: 0, message: "ok" })!;
  assert.deepEqual(decodeSendC2CMessageRsp(c2c, "m-1"), { msgId: "m-1", code: 0, message: "ok" });
  const grp = encodeBizPB(BIZ_MSG_TYPES.SendGroupMessageRsp, { code: 1, message: "err" })!;
  assert.deepEqual(decodeSendGroupMessageRsp(grp, "m-2"), { msgId: "m-2", code: 1, message: "err" });
});

void test("decodeSendMessageRsp falls back across c2c/group shapes", () => {
  const bytes = encodeBizPB(BIZ_MSG_TYPES.SendC2CMessageRsp, { code: 0, message: "ok" })!;
  assert.deepEqual(decodeSendMessageRsp(bytes, "m-3"), { msgId: "m-3", code: 0, message: "ok" });
});

void test("decodeQueryGroupInfoRsp maps nested groupInfo", () => {
  const bytes = encodeBizPB(BIZ_MSG_TYPES.QueryGroupInfoRsp, {
    code: 0, msg: "ok",
    groupInfo: { groupName: "G", groupOwnerUserId: "o", groupOwnerNickname: "owner", groupSize: 5 },
  })!;
  const rsp = decodeQueryGroupInfoRsp(bytes, "m-4");
  assert.equal(rsp!.group_info?.group_name, "G");
  assert.equal(rsp!.group_info?.group_size, 5);
});

void test("decodeGetGroupMemberListRsp maps member list", () => {
  const bytes = encodeBizPB(BIZ_MSG_TYPES.GetGroupMemberListRsp, {
    code: 0, message: "ok",
    memberList: [{ userId: "u1", nickName: "n1", userType: 1 }],
  })!;
  const rsp = decodeGetGroupMemberListRsp(bytes, "m-5");
  assert.equal(rsp!.member_list.length, 1);
  assert.deepEqual(rsp!.member_list[0], { user_id: "u1", nick_name: "n1", user_type: 1 });
});

void test("decodeGetGroupMemberListRsp yields [] when memberList absent", () => {
  const bytes = encodeBizPB(BIZ_MSG_TYPES.GetGroupMemberListRsp, { code: 0, message: "ok" })!;
  assert.deepEqual(decodeGetGroupMemberListRsp(bytes, "m-6")!.member_list, []);
});

void test("heartbeat Rsp decoders mirror msg into both msg and message", () => {
  const pvt = encodeBizPB(BIZ_MSG_TYPES.SendPrivateHeartbeatRsp, { code: 0, msg: "running" })!;
  assert.deepEqual(decodeSendPrivateHeartbeatRsp(pvt, "m-7"), { msgId: "m-7", code: 0, msg: "running", message: "running" });
  const grp = encodeBizPB(BIZ_MSG_TYPES.SendGroupHeartbeatRsp, { code: 0, msg: "done" })!;
  assert.deepEqual(decodeSendGroupHeartbeatRsp(grp, "m-8"), { msgId: "m-8", code: 0, msg: "done", message: "done" });
});

void test("decodeSyncInformationRsp preserves msgId + code/msg", () => {
  const bytes = encodeBizPB(BIZ_MSG_TYPES.SyncInformationRsp, { code: 0, msg: "synced" })!;
  assert.deepEqual(decodeSyncInformationRsp(bytes, "m-9"), { msgId: "m-9", code: 0, msg: "synced" });
});

void test("decodeQueryGroupInfoRsp returns undefined group_info when absent", () => {
  const bytes = encodeBizPB(BIZ_MSG_TYPES.QueryGroupInfoRsp, { code: 0, msg: "ok" })!;
  const rsp = decodeQueryGroupInfoRsp(bytes, "m");
  assert.equal(rsp!.group_info, undefined);
});

void test("decodeSendMessageRsp / heartbeat rsp handle empty payloads (default code/msg)", () => {
  const c2c = encodeBizPB(BIZ_MSG_TYPES.SendC2CMessageRsp, {})!;
  assert.deepEqual(decodeSendMessageRsp(c2c, "m"), { msgId: "m", code: 0, message: "" });
  const pvt = encodeBizPB(BIZ_MSG_TYPES.SendPrivateHeartbeatRsp, {})!;
  assert.deepEqual(decodeSendPrivateHeartbeatRsp(pvt, "m"), { msgId: "m", code: 0, msg: "", message: "" });
});

void test("encodeSendC2CMessageReq works without msg_seq / trace_id (optional branches)", () => {
  const bytes = encodeSendC2CMessageReq({ to_account: "u", msg_body: textBody })!;
  const back = decodeBizPB(BIZ_MSG_TYPES.SendC2CMessageReq, bytes) as DecodedPB;
  assert.equal(back.toAccount, "u");
});

void test("encodeSendGroupMessageReq works without optional fields (falsy branches)", () => {
  const bytes = encodeSendGroupMessageReq({ group_code: "g", msg_body: textBody })!;
  const back = decodeBizPB(BIZ_MSG_TYPES.SendGroupMessageReq, bytes) as DecodedPB;
  assert.equal(back.groupCode, "g");
});

void test("encodeSendC2CMessageReq with traceContext sets msgSeq + logExt branches", () => {
  const bytes = encodeSendC2CMessageReq({ to_account: "u", msg_body: textBody, msg_seq: 9, trace_id: "tr" })!;
  const back = decodeBizPB(BIZ_MSG_TYPES.SendC2CMessageReq, bytes) as DecodedPB;
  assert.equal(Number(back.msgSeq), 9);
  assert.equal(back.logExt.traceId, "tr");
});

void test("decodeQueryGroupInfoRsp fills defaults for missing nested fields", () => {
  const bytes = encodeBizPB(BIZ_MSG_TYPES.QueryGroupInfoRsp, { code: 0, msg: "ok", groupInfo: { groupOwnerUserId: "o" } })!;
  const rsp = decodeQueryGroupInfoRsp(bytes, "m");
  assert.equal(rsp!.group_info?.group_name, ""); // || "" branch
  assert.equal(rsp!.group_info?.group_size, 0);
});

// ── QueryBotInfo (owner-id query) ───────────────────────────────────────────
void test("encodeQueryBotInfoReq encodes botId (round-trips via decodeBizPB)", () => {
  const bytes = encodeQueryBotInfoReq("bot-001")!;
  const back = decodeBizPB(BIZ_MSG_TYPES.QueryBotInfoReq, bytes) as DecodedPB;
  assert.equal(back.botId, "bot-001");
});

void test("decodeQueryBotInfoRsp maps message→msg and botInfo.{botId,encryptOwnerId}", () => {
  const bytes = encodeBizPB(BIZ_MSG_TYPES.QueryBotInfoRsp, {
    code: 0,
    message: "ok",
    botInfo: { botId: "bot-001", encryptOwnerId: "owner-xyz" },
  })!;
  assert.deepEqual(decodeQueryBotInfoRsp(bytes, "m-1"), {
    msgId: "m-1",
    code: 0,
    msg: "ok",
    botId: "bot-001",
    ownerId: "owner-xyz",
  });
});

void test("decodeQueryBotInfoRsp fills defaults when botInfo / fields are absent", () => {
  const bytes = encodeBizPB(BIZ_MSG_TYPES.QueryBotInfoRsp, {})!;
  assert.deepEqual(decodeQueryBotInfoRsp(bytes, "m-2"), {
    msgId: "m-2",
    code: 0,
    msg: "",
    botId: "",
    ownerId: "",
  });
});

void test("decodeQueryBotInfoRsp returns null on malformed bytes", () => {
  const bad = new Uint8Array([0x08, 0xff]);
  assert.equal(decodeQueryBotInfoRsp(bad, "m"), null);
});

// ── error branches ────────────────────────────────────────────────────────────
void test("encodeBizPB returns null for unknown type", () => {
  assert.equal(encodeBizPB("trpc.unknown.NotAType", {}), null);
});

void test("decodeBizPB returns null for unknown type", () => {
  assert.equal(decodeBizPB("trpc.unknown.NotAType", new Uint8Array([1, 2])), null);
});

void test("decoders return null on malformed bytes", () => {
  const bad = new Uint8Array([0x08, 0xff]); // field 1 varint with truncated value → decode throws
  assert.equal(decodeInboundMessage(bad), null);
  assert.equal(decodeSendC2CMessageRsp(bad, "m"), null);
  assert.equal(decodeQueryGroupInfoRsp(bad, "m"), null);
  assert.equal(decodeGetGroupMemberListRsp(bad, "m"), null);
  assert.equal(decodeSyncInformationRsp(bad, "m"), null);
});
