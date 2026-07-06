/** Business-layer Protobuf codec — encode/decode for business messages. */

import protobuf from "protobufjs";
import { createLog, formatLog, logger } from "../../logger.js";
import type {
  YuanbaoInboundMessage,
  YuanbaoLogInfoExt,
  YuanbaoMsgBodyElement,
  ImMsgSeq,
} from "../../types.js";
import { EnumCLawMsgType } from "../../types.js";
import bizDescriptor from "./proto/biz.json" with { type: "json" };
import type {
  WsSendC2CMessageData,
  WsSendGroupMessageData,
  WsSendMessageResponse,
  WsSendPrivateHeartbeatData,
  WsSendGroupHeartbeatData,
  WsHeartbeatResponse,
  WsQueryGroupInfoData,
  WsQueryGroupInfoResponse,
  WsGetGroupMemberListData,
  WsGetGroupMemberListResponse,
  WsSyncInformationData,
  WsSyncInformationResponse,
  WsQueryBotInfoResponse,
} from "./types.js";

// Module-level logger instance

type PBInboundMessage = {
  callbackCommand?: string;
  fromAccount?: string;
  toAccount?: string;
  senderNickname?: string;
  groupId?: string;
  groupCode?: string;
  groupName?: string;
  msgSeq?: number;
  msgRandom?: number;
  msgTime?: number;
  msgKey?: string;
  msgId?: string;
  msgBody?: Array<Record<string, unknown>>;
  cloudCustomData?: string;
  eventTime?: number;
  botOwnerId?: string;
  recallMsgSeqList?: ImMsgSeq[];
  clawMsgType?: EnumCLawMsgType;
  privateFromGroupCode?: string;
  logExt?: { traceId?: string };
};

type PBCodeMessageRsp = {
  code?: number;
  message?: string;
};

type PBCodeMsgRsp = {
  code?: number;
  msg?: string;
};

type PBQueryGroupInfoRsp = PBCodeMsgRsp & {
  groupInfo?: {
    groupName?: string;
    groupOwnerUserId?: string;
    groupOwnerNickname?: string;
    groupSize?: number;
  };
};

type PBGetGroupMemberListRsp = PBCodeMessageRsp & {
  memberList?: Array<{ userId?: string; nickName?: string; userType?: number }>;
};

type PBSyncInformationRsp = PBCodeMsgRsp;

let root: protobuf.Root | null = null;

function getRoot(): protobuf.Root {
  if (!root) {
    root = protobuf.Root.fromJSON(bizDescriptor);
  }
  return root;
}

const PKG = "trpc.yuanbao.yuanbao_conn.yuanbao_openclaw_proxy";

export const BIZ_MSG_TYPES = {
  MsgContent: `${PKG}.MsgContent`,
  MsgBodyElement: `${PKG}.MsgBodyElement`,
  InboundMessagePush: `${PKG}.InboundMessagePush`,
  SendC2CMessageReq: `${PKG}.SendC2CMessageReq`,
  SendGroupMessageReq: `${PKG}.SendGroupMessageReq`,
  SendC2CMessageRsp: `${PKG}.SendC2CMessageRsp`,
  SendGroupMessageRsp: `${PKG}.SendGroupMessageRsp`,
  QueryGroupInfoReq: `${PKG}.QueryGroupInfoReq`,
  QueryGroupInfoRsp: `${PKG}.QueryGroupInfoRsp`,
  GetGroupMemberListReq: `${PKG}.GetGroupMemberListReq`,
  GetGroupMemberListRsp: `${PKG}.GetGroupMemberListRsp`,
  SendPrivateHeartbeatReq: `${PKG}.SendPrivateHeartbeatReq`,
  SendPrivateHeartbeatRsp: `${PKG}.SendPrivateHeartbeatRsp`,
  SendGroupHeartbeatReq: `${PKG}.SendGroupHeartbeatReq`,
  SendGroupHeartbeatRsp: `${PKG}.SendGroupHeartbeatRsp`,
  SyncInformationReq: `${PKG}.SyncInformationReq`,
  SyncInformationRsp: `${PKG}.SyncInformationRsp`,
  QueryBotInfoReq: `${PKG}.QueryBotInfoReq`,
  QueryBotInfoRsp: `${PKG}.QueryBotInfoRsp`,
} as const;

export function encodeBizPB(key: string, value: Record<string, unknown>): Uint8Array | null {
  try {
    const type = getRoot().lookupType(key);
    const message = type.create(value);
    return type.encode(message).finish();
  } catch (error: unknown) {
    const log = createLog("biz-codec");
    log.error("encode failed", { key, error: (error as Error).message });
    return null;
  }
}

export function decodeBizPB(key: string, data: Uint8Array | ArrayBuffer): unknown {
  try {
    const buf = data instanceof Uint8Array ? data : new Uint8Array(data);
    const type = getRoot().lookupType(key);
    return type.decode(buf);
  } catch {
    // protobuf decode failure is expected, silently return null
    return null;
  }
}

/** Convert TS MsgBodyElement[] to protobuf format. */
export function toProtoMsgBody(elements: YuanbaoMsgBodyElement[]): Record<string, unknown>[] {
  return elements.map((el) => {
    const c = el.msg_content;
    return {
      msgType: el.msg_type,
      msgContent: {
        text: c.text,
        uuid: c.uuid,
        imageFormat: c.image_format,
        data: c.data,
        desc: c.desc,
        ext: c.ext,
        sound: c.sound,
        imageInfoArray: c.image_info_array,
        index: c.index,
        url: c.url,
        fileSize: c.file_size,
        fileName: c.file_name,
        extMap: c.ext_map,
      },
    };
  });
}

/** Convert protobuf format message body back to TS MsgBodyElement[]. */
export function fromProtoMsgBody(elements: Array<Record<string, unknown>>): YuanbaoMsgBodyElement[] {
  if (!elements || !Array.isArray(elements)) {
    return [];
  }
  return elements.map((el) => {
    const mc = el.msgContent as Record<string, unknown> | undefined;
    const content: Record<string, unknown> = {};

    if (mc?.text) {
      content.text = mc.text;
    }
    if (mc?.uuid) {
      content.uuid = mc.uuid;
    }
    if (mc?.imageFormat) {
      content.image_format = mc.imageFormat;
    }
    if (mc?.data) {
      content.data = mc.data;
    }
    if (mc?.desc) {
      content.desc = mc.desc;
    }
    if (mc?.ext) {
      content.ext = mc.ext;
    }
    if (mc?.sound) {
      content.sound = mc.sound;
    }
    if (mc?.imageInfoArray && (mc.imageInfoArray as unknown[]).length > 0) {
      content.image_info_array = mc.imageInfoArray;
    }
    if (mc?.index) {
      content.index = mc.index;
    }
    if (mc?.url) {
      content.url = mc.url;
    }
    if (mc?.fileSize) {
      content.file_size = mc.fileSize;
    }
    if (mc?.fileName) {
      content.file_name = mc.fileName;
    }
    if (mc?.extMap && Object.keys(mc.extMap as Record<string, unknown>).length > 0) {
      content.ext_map = mc.extMap;
    }

    return {
      msg_type: (el.msgType as string) || "",
      msg_content: content,
    };
  });
}

function toProtoLogExt(
  logExt?: YuanbaoLogInfoExt,
  traceId?: string,
): { traceId: string } | undefined {
  const resolvedTraceId = traceId?.trim() || logExt?.trace_id?.trim();
  return resolvedTraceId ? { traceId: resolvedTraceId } : undefined;
}

/** Encode a C2C send message request. */
export function encodeSendC2CMessageReq(data: WsSendC2CMessageData): Uint8Array | null {
  const logExt = toProtoLogExt(undefined, data.trace_id);
  const log = createLog("biz-codec");
  log.debug("[msg-trace] encode c2c outbound", {
    traceId: data.trace_id ?? "(none)",
    msgSeq: data.msg_seq ?? "(none)",
    toAccount: data.to_account,
  });
  return encodeBizPB(BIZ_MSG_TYPES.SendC2CMessageReq, {
    msgId: data.msg_id ?? "",
    toAccount: data.to_account,
    fromAccount: data.from_account ?? "",
    groupCode: data.group_code ?? "",
    msgRandom: data.msg_random ?? 0,
    ...(data.msg_seq !== undefined ? { msgSeq: data.msg_seq } : {}),
    msgBody: toProtoMsgBody(data.msg_body),
    ...(logExt ? { logExt } : {}),
  });
}

/** Encode group message send request. */
export function encodeSendGroupMessageReq(data: WsSendGroupMessageData): Uint8Array | null {
  const logExt = toProtoLogExt(undefined, data.trace_id);
  const log = createLog("biz-codec");
  log.debug("[msg-trace] encode group outbound", {
    traceId: data.trace_id ?? "(none)",
    msgSeq: data.msg_seq ?? "(none)",
    groupCode: data.group_code,
  });
  return encodeBizPB(BIZ_MSG_TYPES.SendGroupMessageReq, {
    msgId: data.msg_id ?? "",
    groupCode: data.group_code,
    fromAccount: data.from_account ?? "",
    toAccount: data.to_account ?? "",
    random: data.random ?? "",
    msgBody: toProtoMsgBody(data.msg_body),
    refMsgId: data.ref_msg_id ?? "",
    ...(data.msg_seq !== undefined ? { msgSeq: data.msg_seq } : {}),
    ...(logExt ? { logExt } : {}),
    ...(data.cloud_custom_data ? { cloudCustomData: data.cloud_custom_data } : {}),
  });
}

/** Encode direct chat reply status heartbeat request. */
export function encodeSendPrivateHeartbeatReq(data: WsSendPrivateHeartbeatData): Uint8Array | null {
  return encodeBizPB(BIZ_MSG_TYPES.SendPrivateHeartbeatReq, {
    // Dual-write fromAccount/fromtAccount for backward compatibility with old descriptor typo
    fromAccount: data.from_account,
    fromtAccount: data.from_account,
    toAccount: data.to_account,
    heartbeat: data.heartbeat,
  });
}

/** Encode group chat reply status heartbeat request. */
export function encodeSendGroupHeartbeatReq(data: WsSendGroupHeartbeatData): Uint8Array | null {
  return encodeBizPB(BIZ_MSG_TYPES.SendGroupHeartbeatReq, {
    fromAccount: data.from_account,
    toAccount: data.to_account,
    groupCode: data.group_code,
    sendTime: data.send_time,
    heartbeat: data.heartbeat,
  });
}

/**
 * Build a display-safe clone of a proto/TS msg_body that truncates any large
 * base64 `data` / `dataBase64` fields (e.g. image payloads). Used only for
 * logging — must never mutate the real message.
 */
function truncateMsgBodyForLog(
  msgBody: unknown,
  maxLen = 64,
): unknown {
  if (!Array.isArray(msgBody)) return msgBody;
  return msgBody.map((el) => {
    if (!el || typeof el !== "object") return el;
    const cloned: Record<string, unknown> = { ...(el as Record<string, unknown>) };
    // Handle both proto shape (msgContent) and TS shape (msg_content)
    for (const key of ["msgContent", "msg_content"] as const) {
      const mc = cloned[key];
      if (mc && typeof mc === "object") {
        const mcClone: Record<string, unknown> = { ...(mc as Record<string, unknown>) };
        for (const dataKey of ["data", "dataBase64"] as const) {
          const v = mcClone[dataKey];
          if (typeof v === "string" && v.length > maxLen) {
            mcClone[dataKey] = `${v.slice(0, maxLen)}…(len=${v.length})`;
          }
        }
        cloned[key] = mcClone;
      }
    }
    return cloned;
  });
}

/** Decode inbound message proto bytes into YuanbaoInboundMessage. */
export function decodeInboundMessage(
  data: Uint8Array | ArrayBuffer,
  logSink?: { info?: (msg: string) => void; error?: (msg: string) => void },
): YuanbaoInboundMessage | null {
  const decoded = decodeBizPB(BIZ_MSG_TYPES.InboundMessagePush, data) as PBInboundMessage | null;
  if (!decoded) {
    return null;
  }

  const msgBody = decoded.msgBody ? fromProtoMsgBody(decoded.msgBody) : undefined;
  const traceId = decoded.logExt?.traceId?.trim();
  const seqId = decoded.msgSeq !== undefined && decoded.msgSeq !== null ? String(decoded.msgSeq) : undefined;

  const log = createLog("biz-codec");
  log.debug("[msg-trace] decoded inbound", {
    traceId: traceId ?? "(none)",
    seqId: seqId ?? "(none)",
    from: decoded.fromAccount || "?",
    msgId: decoded.msgId || "?",
  });

  // Route info-level dumps through the SDK-provided log sink (surfaces in
  // gateway.log). The plugin `logger` singleton writes to a different sink
  // that does not appear in gateway.log at this call site.
  const emitInfo = (line: string): void => {
    if (logSink?.info) {
      logSink.info(line);
    } else {
      logger.info(line); // fallback (may not surface in gateway.log)
    }
  };

  // [inbound-proto] Dump the full protobuf-decoded object (camelCase) — the
  // earliest structured form of the message after `type.decode()`. Base64
  // media payloads are truncated. Uses skipSanitize so cloud_custom_data is
  // visible for debugging (temporary; safe because gateway.log is local-only).
  try {
    const line = formatLog(
      "biz-codec",
      "[inbound-proto] decoded protobuf payload",
      {
        msgId: decoded.msgId,
        fromAccount: decoded.fromAccount,
        groupCode: decoded.groupCode ?? decoded.groupId,
        senderNickname: decoded.senderNickname,
        cloudCustomData: decoded.cloudCustomData,
        callbackCommand: decoded.callbackCommand,
        clawMsgType: decoded.clawMsgType,
        msgBody: truncateMsgBodyForLog(decoded.msgBody),
        traceId: traceId ?? "(none)",
        seqId: seqId ?? "(none)",
      },
      true, // skipSanitize
    );
    emitInfo(line);
  } catch (err) {
    log.error("[inbound-proto] serialize failed", { error: String(err) });
  }

  const result: YuanbaoInboundMessage = {
    callback_command: decoded.callbackCommand || undefined,
    from_account: decoded.fromAccount || undefined,
    to_account: decoded.toAccount || undefined,
    sender_nickname: decoded.senderNickname || undefined,
    group_id: decoded.groupId || undefined,
    group_code: decoded.groupCode || undefined,
    group_name: decoded.groupName || undefined,
    msg_seq: decoded.msgSeq || undefined,
    msg_random: decoded.msgRandom || undefined,
    msg_time: decoded.msgTime || undefined,
    msg_key: decoded.msgKey || undefined,
    msg_id: decoded.msgId || undefined,
    msg_body: msgBody,
    cloud_custom_data: decoded.cloudCustomData || undefined,
    event_time: decoded.eventTime || undefined,
    bot_owner_id: decoded.botOwnerId || undefined,
    recall_msg_seq_list: decoded.recallMsgSeqList || undefined,
    claw_msg_type: decoded.clawMsgType || undefined,
    private_from_group_code: decoded.privateFromGroupCode || undefined,
    trace_id: traceId,
    seq_id: seqId,
  };

  // [inbound-ts] Dump the final YuanbaoInboundMessage (snake_case) — this is
  // exactly what the pipeline will see as `ctx.raw` before engine's
  // [inbound-inject] workaround mutates cloud_custom_data.
  try {
    const line = formatLog(
      "biz-codec",
      "[inbound-ts] YuanbaoInboundMessage built",
      {
        msg_id: result.msg_id,
        from_account: result.from_account,
        to_account: result.to_account,
        group_code: result.group_code ?? result.group_id,
        sender_nickname: result.sender_nickname,
        cloud_custom_data: result.cloud_custom_data,
        callback_command: result.callback_command,
        claw_msg_type: result.claw_msg_type,
        msg_body: truncateMsgBodyForLog(result.msg_body),
        trace_id: result.trace_id,
        seq_id: result.seq_id,
      },
      true, // skipSanitize
    );
    emitInfo(line);
  } catch (err) {
    log.error("[inbound-ts] serialize failed", { error: String(err) });
  }

  return result;
}

/** Decode C2C outbound response. */
export function decodeSendC2CMessageRsp(
  data: Uint8Array | ArrayBuffer,
  msgId: string,
): WsSendMessageResponse | null {
  const decoded = decodeBizPB(BIZ_MSG_TYPES.SendC2CMessageRsp, data) as PBCodeMessageRsp | null;
  if (!decoded) {
    return null;
  }

  return {
    msgId,
    code: decoded.code || 0,
    message: decoded.message || "",
  };
}

/** Decode group message outbound response. */
export function decodeSendGroupMessageRsp(
  data: Uint8Array | ArrayBuffer,
  msgId: string,
): WsSendMessageResponse | null {
  const decoded = decodeBizPB(BIZ_MSG_TYPES.SendGroupMessageRsp, data) as PBCodeMessageRsp | null;
  if (!decoded) {
    return null;
  }

  return {
    msgId,
    code: decoded.code || 0,
    message: decoded.message || "",
  };
}

/** Decode outbound response (compatible with both C2C and group). */
export function decodeSendMessageRsp(
  data: Uint8Array | ArrayBuffer,
  msgId: string,
): WsSendMessageResponse | null {
  // C2C and group Rsp share the same structure (code + message); try C2C first
  return decodeSendC2CMessageRsp(data, msgId) ?? decodeSendGroupMessageRsp(data, msgId);
}

/** Encode query group info request. */
export function encodeQueryGroupInfoReq(data: WsQueryGroupInfoData): Uint8Array | null {
  return encodeBizPB(BIZ_MSG_TYPES.QueryGroupInfoReq, {
    groupCode: data.group_code,
  });
}

/** Decode query group info response. */
export function decodeQueryGroupInfoRsp(
  data: Uint8Array | ArrayBuffer,
  msgId: string,
): WsQueryGroupInfoResponse | null {
  const decoded = decodeBizPB(BIZ_MSG_TYPES.QueryGroupInfoRsp, data) as PBQueryGroupInfoRsp | null;
  if (!decoded) {
    return null;
  }

  const gi = decoded.groupInfo;

  return {
    msgId,
    code: decoded.code || 0,
    msg: decoded.msg || "",
    group_info: gi
      ? {
        group_name: gi.groupName || "",
        group_owner_user_id: gi.groupOwnerUserId || "",
        group_owner_nickname: gi.groupOwnerNickname || "",
        group_size: gi.groupSize || 0,
      }
      : undefined,
  };
}

/** Encode get group member list request. */
export function encodeGetGroupMemberListReq(data: WsGetGroupMemberListData): Uint8Array | null {
  return encodeBizPB(BIZ_MSG_TYPES.GetGroupMemberListReq, {
    groupCode: data.group_code,
  });
}

/** Decode get group member list response. */
export function decodeGetGroupMemberListRsp(
  data: Uint8Array | ArrayBuffer,
  msgId: string,
): WsGetGroupMemberListResponse | null {
  const decoded = decodeBizPB(
    BIZ_MSG_TYPES.GetGroupMemberListRsp,
    data,
  ) as PBGetGroupMemberListRsp | null;
  if (!decoded) {
    return null;
  }

  const memberList = Array.isArray(decoded.memberList)
    ? decoded.memberList.map(m => ({
      user_id: m.userId || "",
      nick_name: m.nickName || "",
      user_type: m.userType || 0,
    }))
    : [];

  return {
    msgId,
    code: decoded.code || 0,
    message: decoded.message || "",
    member_list: memberList,
  };
}

/**
 * Decode direct chat reply status heartbeat response.
 * Preserves request-side msgId for stable request-response correlation.
 */
export function decodeSendPrivateHeartbeatRsp(
  data: Uint8Array | ArrayBuffer,
  msgId: string,
): WsHeartbeatResponse | null {
  const decoded = decodeBizPB(BIZ_MSG_TYPES.SendPrivateHeartbeatRsp, data) as PBCodeMsgRsp | null;
  if (!decoded) {
    return null;
  }
  return {
    msgId,
    code: decoded.code || 0,
    msg: decoded.msg || "",
    message: decoded.msg || "",
  };
}

/**
 * Decode group chat reply status heartbeat response.
 * Carries original msgId for correct request-response matching.
 */
export function decodeSendGroupHeartbeatRsp(
  data: Uint8Array | ArrayBuffer,
  msgId: string,
): WsHeartbeatResponse | null {
  const decoded = decodeBizPB(BIZ_MSG_TYPES.SendGroupHeartbeatRsp, data) as PBCodeMsgRsp | null;
  if (!decoded) {
    return null;
  }
  return {
    msgId,
    code: decoded.code || 0,
    msg: decoded.msg || "",
    message: decoded.msg || "",
  };
}

/** Encode SyncInformationReq (sync command list to backend). */
export function encodeSyncInformationReq(data: WsSyncInformationData): Uint8Array | null {
  return encodeBizPB(BIZ_MSG_TYPES.SyncInformationReq, {
    syncType: data.syncType,
    botVersion: data.botVersion,
    pluginVersion: data.pluginVersion,
    ...(data.commandData ? { commandData: data.commandData } : {}),
  });
}

/** Decode SyncInformationRsp. */
export function decodeSyncInformationRsp(
  data: Uint8Array | ArrayBuffer,
  msgId: string,
): WsSyncInformationResponse | null {
  const decoded = decodeBizPB(
    BIZ_MSG_TYPES.SyncInformationRsp,
    data,
  ) as PBSyncInformationRsp | null;
  if (!decoded) {
    return null;
  }
  return {
    msgId,
    code: decoded.code || 0,
    msg: decoded.msg || "",
  };
}

type PBBotInfo = {
  botId?: string;
  encryptOwnerId?: string;
};

type PBQueryBotInfoRsp = {
  code?: number;
  message?: string;
  botInfo?: PBBotInfo;
};

/** Encode QueryBotInfoReq. */
export function encodeQueryBotInfoReq(botId: string): Uint8Array | null {
  return encodeBizPB(BIZ_MSG_TYPES.QueryBotInfoReq, { botId });
}

/** Decode QueryBotInfoRsp. */
export function decodeQueryBotInfoRsp(
  data: Uint8Array | ArrayBuffer,
  msgId: string,
): WsQueryBotInfoResponse | null {
  const decoded = decodeBizPB(BIZ_MSG_TYPES.QueryBotInfoRsp, data) as PBQueryBotInfoRsp | null;
  if (!decoded) {
    return null;
  }
  return {
    msgId,
    code: decoded.code || 0,
    msg: decoded.message || "",
    botId: decoded.botInfo?.botId || "",
    ownerId: decoded.botInfo?.encryptOwnerId || "",
  };
}
