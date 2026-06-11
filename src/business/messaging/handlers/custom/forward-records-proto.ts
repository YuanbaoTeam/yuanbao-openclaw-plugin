/**
 * Protobuf decoder for WeChat forwarded chat-record payloads.
 *
 * The server stores `ForwardMsgData` in `MsgContent.ext_map` as a base64
 * string whose decoded bytes are protobuf wire data.
 */

import protobuf from "protobufjs";
import type { ForwardMsgData } from "./forward-records.js";

const FORWARD_PROTO_DESCRIPTOR = {
  nested: {
    ForwardMsgData: {
      fields: {
        sub_type: { type: "int32", id: 1 },
        msg_begin_time: { type: "int64", id: 2 },
        msg_end_time: { type: "int64", id: 3 },
        nick_name: { type: "string", id: 4 },
        msg: { rule: "repeated", type: "Msg", id: 5 },
      },
    },
    Msg: {
      fields: {
        sender: { type: "string", id: 1 },
        time: { type: "int64", id: 2 },
        plainText: { type: "string", id: 3 },
        msgContent: { rule: "repeated", type: "MsgContent", id: 4 },
      },
    },
    MsgContent: {
      fields: {
        type: { type: "int32", id: 1 },
        text: { type: "string", id: 2 },
        multimedia: { rule: "repeated", type: "Multimedia", id: 3 },
      },
    },
    Multimedia: {
      fields: {
        type: { type: "string", id: 1 },
        url: { type: "string", id: 2 },
        origin_url: { type: "string", id: 3 },
        file_name: { type: "string", id: 4 },
        size: { type: "int64", id: 5 },
        width: { type: "int32", id: 6 },
        height: { type: "int32", id: 7 },
        style: { type: "string", id: 8 },
        pendants: { rule: "repeated", type: "string", id: 9 },
        created_time: { type: "int64", id: 10 },
        index_url: { type: "string", id: 11 },
        cover_url: { type: "string", id: 12 },
        duration: { type: "int64", id: 13 },
        guide_id: { type: "int32", id: 14 },
        media_id: { type: "string", id: 15 },
        extract: { type: "bool", id: 16 },
        title: { type: "string", id: 17 },
        content: { type: "string", id: 18 },
        session_id: { type: "string", id: 19 },
        question_id: { type: "string", id: 20 },
        goods_trace_id: { type: "string", id: 21 },
        cache_key: { type: "string", id: 22 },
        chat_record_id: { type: "string", id: 23 },
        doc_type: { type: "string", id: 24 },
        image_base64: { type: "string", id: 25 },
        parse_file_type: { type: "string", id: 26 },
        parse_file_url: { type: "string", id: 27 },
        sensitive: { type: "bool", id: 28 },
        extra: { type: "string", id: 29 },
        icon_url: { type: "string", id: 30 },
        source: { type: "string", id: 31 },
        app_id: { type: "string", id: 32 },
        link_url: { type: "string", id: 33 },
        msg_count: { type: "int32", id: 34 },
        msg_time: { type: "int64", id: 35 },
        forward_msg_id: { type: "string", id: 36 },
      },
    },
  },
};

let forwardMsgDataType: protobuf.Type | undefined;

function getForwardMsgDataType(): protobuf.Type {
  if (!forwardMsgDataType) {
    forwardMsgDataType = protobuf.Root.fromJSON(FORWARD_PROTO_DESCRIPTOR).lookupType("ForwardMsgData");
  }
  return forwardMsgDataType;
}

export function decodeForwardMsgDataBase64(value: string): ForwardMsgData | undefined {
  try {
    const bytes = Buffer.from(value, "base64");
    if (bytes.length === 0) {
      return undefined;
    }
    const type = getForwardMsgDataType();
    const decoded = type.decode(bytes);
    const object = type.toObject(decoded, {
      longs: String,
      enums: Number,
      bytes: String,
      arrays: true,
      objects: true,
    });
    return object && typeof object === "object" ? (object as ForwardMsgData) : undefined;
  } catch {
    return undefined;
  }
}
