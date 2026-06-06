/**
 * WeChat forwarded chat-record (elem_type 1009) parsing.
 *
 * A forwarded chat record carries a truncated summary in `msg_content.data.text`
 * and the full structured detail in `msg_content.ext_map` (protobuf field 999).
 * The ext_map value is a base64-encoded protobuf `ForwardMsgData`.
 *
 * This module turns that detail into readable chat-record lines and appends
 * contained images/files to the shared `medias` list so the existing download
 * pipeline fetches them — matching how imageHandler / fileHandler already behave.
 */

import { sanitizeMediaFilename } from "../../../utils/media.js";
import type { ExtractTextFromMsgBodyResult } from "../types.js";
import { decodeForwardMsgDataBase64 } from "./forward-records-proto.js";

/** EnumMsgContentType inside a forwarded record. */
const enum ForwardContentType {
  Text = 1,
  Multimedia = 2,
  ForwardMsg = 3,
}

/** Multimedia entry inside a forwarded message content. */
export interface ForwardMultimedia {
  type?: string; // "image" / "url" / "file" / "video"
  url?: string;
  origin_url?: string;
  parse_file_url?: string;
  link_url?: string;
  file_name?: string;
  media_id?: string;
  doc_type?: string; // "image" / "url" / "file"
  title?: string;
  [key: string]: unknown;
}

/** One content fragment of a forwarded message. */
export interface ForwardMsgContent {
  type?: number; // ForwardContentType
  text?: string;
  multimedia?: ForwardMultimedia[];
}

/** One message inside a forwarded chat record. */
export interface ForwardMsg {
  sender?: string;
  time?: number | string;
  plainText?: string;
  msgContent?: ForwardMsgContent[];
}

/** Parsed `ForwardMsgData` (ext_map value). */
export interface ForwardMsgData {
  sub_type?: number; // 1 = WeChat chat record
  msg_begin_time?: number | string;
  msg_end_time?: number | string;
  nick_name?: string; // forwarder's WeChat nickname
  msg?: ForwardMsg[];
}

/** ext_map key prefix for WeChat forwarded chat records. */
const FORWARD_KEY_PREFIX = "wexin_forward_msg_";

/** Cap the number of records folded into a prompt to keep it bounded. */
const MAX_RECORDS = 100;

const HEADER_RECORDS = "以下为用户的聊天记录";

/**
 * Extract the `ForwardMsgData` from a `msg_content.ext_map`.
 *
 * Matching strategy (per spec): prefer a `wexin_forward_msg_*` key that ends
 * with `_{userId}`; otherwise fall back to the first entry that parses into a
 * WeChat chat record (`sub_type === 1`). Returns undefined when none matches.
 */
export function parseForwardMsgData(
  extMap: Record<string, unknown> | undefined,
  userId?: string,
): ForwardMsgData | undefined {
  if (!extMap || typeof extMap !== "object") {
    return undefined;
  }

  const entries = Object.entries(extMap).filter(([key]) => key.startsWith(FORWARD_KEY_PREFIX));
  if (entries.length === 0) {
    return undefined;
  }

  // Prefer a key whose suffix matches the current user; otherwise keep order.
  const ordered = userId
    ? [...entries].sort(([a], [b]) => {
      const am = a.endsWith(`_${userId}`) ? 0 : 1;
      const bm = b.endsWith(`_${userId}`) ? 0 : 1;
      return am - bm;
    })
    : entries;

  for (const [, value] of ordered) {
    const data = coerceForwardData(value);
    if (data && Number(data.sub_type) === 1) {
      return data;
    }
  }
  return undefined;
}

function coerceForwardData(value: unknown): ForwardMsgData | undefined {
  if (typeof value === "string") {
    return decodeForwardMsgDataBase64(value);
  }
  return undefined;
}

/**
 * Build a structured text block from a forwarded chat record and append any
 * contained images/files to `resData.medias` (and link URLs to
 * `resData.linkUrls`) for the downstream download / link-understanding steps.
 *
 * @param senderNickname display name of the user who forwarded the record.
 * @returns the structured text, or undefined when the record has no messages.
 */
export function buildForwardRecordsText(
  data: ForwardMsgData,
  resData: ExtractTextFromMsgBodyResult,
  senderNickname?: string,
): string | undefined {
  const msgList = Array.isArray(data.msg) ? data.msg.slice(0, MAX_RECORDS) : [];
  if (msgList.length === 0) {
    return undefined;
  }

  const lines: string[] = [];
  if (senderNickname) {
    lines.push(`当前用户的昵称为${senderNickname}`);
  }
  lines.push(HEADER_RECORDS);

  for (const msg of msgList) {
    const sender = msg.sender ?? "";
    const parts = buildMessageParts(msg, resData);
    const body = parts.length > 0 ? parts.join("  ") : (msg.plainText ?? "");
    lines.push(`${sender}：${body}`);
  }

  return lines.join("\n");
}

function buildMessageParts(msg: ForwardMsg, resData: ExtractTextFromMsgBodyResult): string[] {
  const contents = Array.isArray(msg.msgContent) ? msg.msgContent : [];
  if (contents.length === 0) {
    return [];
  }

  const parts: string[] = [];
  for (const content of contents) {
    switch (content.type) {
      case ForwardContentType.Text:
        if (content.text) {
          parts.push(content.text);
        }
        break;
      case ForwardContentType.Multimedia:
        for (const media of content.multimedia ?? []) {
          const part = appendMedia(media, resData);
          if (part) {
            parts.push(part);
          }
        }
        break;
      case ForwardContentType.ForwardMsg:
        parts.push("[嵌套聊天记录]");
        break;
      default:
        if (msg.plainText) {
          parts.push(msg.plainText);
        }
        break;
    }
  }
  return parts;
}

/**
 * Resolve a single multimedia item to a text placeholder and, for downloadable
 * media (image/file/code/video-as-file), push it to `resData.medias`. Link
 * shares are recorded in `resData.linkUrls` for link understanding.
 */
function appendMedia(media: ForwardMultimedia, resData: ExtractTextFromMsgBodyResult): string {
  const mediaType = (media.type || media.doc_type || "").toLowerCase();
  const url = media.url || media.origin_url || media.parse_file_url || media.link_url || "";

  switch (mediaType) {
    case "image": {
      if (!url) {
        return `[image:${media.file_name || "image"}]`;
      }
      const count = resData.medias.filter(m => m.mediaType === "image").length + 1;
      const mediaName = sanitizeMediaFilename(media.file_name || media.media_id, `image${count}`);
      resData.medias.push({ mediaType: "image", url, mediaName });
      return `[image:${mediaName}]`;
    }
    case "file":
    case "code":
    case "document": {
      if (!url) {
        return `[file:${media.file_name || "file"}]`;
      }
      const count = resData.medias.filter(m => m.mediaType === "file").length + 1;
      const mediaName = sanitizeMediaFilename(media.file_name || media.media_id, `file${count}`);
      resData.medias.push({ mediaType: "file", url, mediaName });
      return `[file:${mediaName}]`;
    }
    case "url": {
      if (url) {
        resData.linkUrls.push(url);
      }
      return `[link] ${[media.title || media.file_name, url].filter(Boolean).join(" ")}`.trimEnd();
    }
    case "video": {
      if (!url) {
        return `[video] ${media.file_name || "video"}`;
      }
      const count = resData.medias.filter(m => m.mediaType === "file").length + 1;
      const mediaName = sanitizeMediaFilename(media.file_name || media.media_id, `video${count}`);
      resData.medias.push({ mediaType: "file", url, mediaName });
      return `[video:${mediaName}]`;
    }
    default:
      return `[${mediaType || "media"}] ${url || media.file_name || ""}`.trimEnd();
  }
}
