/** Message type handler registry. */

import type { Member } from "../../../infra/cache/member.js";
import { mdTable, mdMath } from "../../utils/markdown.js";
import { customHandler } from "./custom.js";
import { faceHandler } from "./face.js";
import { fileHandler } from "./file.js";
import { imageHandler } from "./image.js";
import { soundHandler } from "./sound.js";
import { textHandler } from "./text.js";
import type { MessageElemHandler, MsgBodyItemType, OutboundContentItem } from "./types.js";
import { videoHandler } from "./video.js";

const handlerList: MessageElemHandler[] = [
  textHandler,
  customHandler,
  imageHandler,
  soundHandler,
  fileHandler,
  videoHandler,
  faceHandler,
];

const handlerMap = new Map<string, MessageElemHandler>(handlerList.map(h => [h.msgType, h]));

const outboundTypeToMsgType: Record<string, string> = {
  text: "TIMTextElem",
  image: "TIMImageElem",
  file: "TIMFileElem",
  video: "TIMVideoFileElem",
  custom: "TIMCustomElem",
};

export function getHandler(msgType: string): MessageElemHandler | undefined {
  return handlerMap.get(msgType);
}

export function getAllHandlers(): readonly MessageElemHandler[] {
  return handlerList;
}

export function buildMsgBody(
  msgType: string,
  data: Record<string, unknown>,
): MsgBodyItemType[] | undefined {
  const handler = handlerMap.get(msgType);
  return handler?.buildMsgBody?.(data);
}

/**
 * Resolve @mentions in outbound text using cached group members' nicknames.
 *
 * Member-nickname driven (replaces the old whitespace-bounded regex): iterates cached
 * members sorted by nickName length descending, locating `@<nickName>` substrings so that
 * Chinese no-space forms like `提醒@元宝喝水` match (the old regex required whitespace on
 * both sides of `@昵称` and missed adjacent CJK). Matching is case-insensitive (toLowerCase),
 * aligned with `Member.lookupUserByNickName`. Longest-nickName-first avoids a short name
 * hijacking a longer one (e.g. "Al" vs "Alice"). Non-member @ tokens (`@keyframes`,
 * `@media`, emails) match no member and stay as plain text.
 */
function resolveAtMentions(
  text: string,
  groupCode?: string,
  memberInst?: Member,
): OutboundContentItem[] {
  // No group context, no member instance, or empty member cache → whole text as one item
  // (preserves prior behavior, keeps @keyframes/@media intact).
  if (!groupCode || !memberInst) {
    return text.trim() ? [{ type: "text", text: text.trim() }] : [];
  }

  const members = memberInst.lookupUsers(groupCode);
  if (members.length === 0) {
    return text.trim() ? [{ type: "text", text: text.trim() }] : [];
  }

  // Longest nickName first so shorter names cannot shadow longer ones.
  const sortedMembers = [...members]
    .filter(m => m.nickName && m.nickName.length > 0)
    .sort((a, b) => b.nickName.length - a.nickName.length);

  type MatchRange = { start: number; end: number; userId: string; nickName: string };
  const matches: MatchRange[] = [];
  const occupied = new Set<number>();
  const lowerText = text.toLowerCase();

  for (const m of sortedMembers) {
    const needle = `@${m.nickName}`.toLowerCase();
    let from = 0;
    while (from <= lowerText.length - needle.length) {
      const idx = lowerText.indexOf(needle, from);
      if (idx === -1) {
        break;
      }
      // Reject overlaps with already-claimed (longer-nickName) regions.
      let overlaps = false;
      for (let i = idx; i < idx + needle.length; i++) {
        if (occupied.has(i)) {
          overlaps = true;
          break;
        }
      }
      if (!overlaps) {
        matches.push({ start: idx, end: idx + needle.length, userId: m.userId, nickName: m.nickName });
        for (let i = idx; i < idx + needle.length; i++) {
          occupied.add(i);
        }
      }
      from = idx + needle.length;
    }
  }

  // No member @ matched → whole text as one item (keeps non-member @ tokens intact).
  if (matches.length === 0) {
    return text.trim() ? [{ type: "text", text: text.trim() }] : [];
  }

  matches.sort((a, b) => a.start - b.start);

  const items: OutboundContentItem[] = [];
  let lastIndex = 0;
  for (const match of matches) {
    if (match.start > lastIndex) {
      const before = text.slice(lastIndex, match.start);
      if (before.trim()) {
        items.push({ type: "text", text: before.trim() });
      }
    }
    items.push({
      type: "custom",
      data: JSON.stringify({
        elem_type: 1002,
        text: `@${match.nickName}`,
        user_id: match.userId,
      }),
    });
    lastIndex = match.end;
  }

  if (lastIndex < text.length) {
    const trailing = text.slice(lastIndex);
    if (trailing.trim()) {
      items.push({ type: "text", text: trailing.trim() });
    }
  }

  return items;
}

export function prepareOutboundContent(
  text: string,
  groupCode?: string,
  memberInst?: Member,
): OutboundContentItem[] {
  if (!text) {
    return [];
  }

  const sanitizedText = mdTable.sanitize(mdMath.normalize(text));

  const items: OutboundContentItem[] = [];

  // Process text with @user resolution
  if (sanitizedText.length) {
    const trailing = sanitizedText.trim();
    if (trailing) {
      items.push(...resolveAtMentions(trailing, groupCode, memberInst));
    }
  }

  // If no matches, parse entire text for @user mentions
  if (items.length === 0 && sanitizedText.trim()) {
    items.push(...resolveAtMentions(sanitizedText.trim(), groupCode, memberInst));
  }

  return items;
}

export function buildOutboundMsgBody(items: OutboundContentItem[]): MsgBodyItemType[] {
  const msgBody: MsgBodyItemType[] = [];

  for (const item of items) {
    const msgType = outboundTypeToMsgType[item.type];
    if (!msgType) {
      continue;
    }

    const handler = handlerMap.get(msgType);
    if (!handler?.buildMsgBody) {
      continue;
    }

    // Convert OutboundContentItem to handler's data parameter
    const { type: _type, ...data } = item;
    const elems = handler.buildMsgBody(data as Record<string, unknown>);
    if (elems) {
      msgBody.push(...elems);
    }
  }

  return msgBody;
}

export type {
  MessageElemHandler,
  MsgBodyItemType,
  MediaItem,
  ExtractTextFromMsgBodyResult,
  OutboundContentItem,
} from "./types.js";

export { textHandler } from "./text.js";
export { customHandler, buildAtUserMsgBodyItem } from "./custom.js";
export { imageHandler } from "./image.js";
export { soundHandler } from "./sound.js";
export { fileHandler } from "./file.js";
export { videoHandler } from "./video.js";
export { faceHandler } from "./face.js";
