/** Message type handler registry. */

import type { Member } from "../../../infra/cache/member.js";
import { createLog } from "../../../logger.js";
import { mdTable, mdMath } from "../../utils/markdown.js";
import { customHandler } from "./custom.js";
import { faceHandler } from "./face.js";
import { fileHandler } from "./file.js";
import { imageHandler } from "./image.js";
import { soundHandler } from "./sound.js";
import { textHandler } from "./text.js";
import type { MessageElemHandler, MsgBodyItemType, OutboundContentItem } from "./types.js";
import { videoHandler } from "./video.js";

const log = createLog("outbound:at-mention");

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

const AT_USER_RE = /(?<=\s|^)@(\S+?)(?=\s|$)/g;

/**
 * Resolve ` @nickname ` tokens into elem_type=1002 custom mention elements.
 *
 * When a nickname misses the member cache in a group context, fetch the full
 * member list via `memberInst.getMembers(groupCode)` once (GroupMember.cache
 * hit → no WS; miss → getGroupMemberList) and retry. This lets @mentions
 * resolve even when the model skipped `query_session_members` — e.g. `@元宝`
 * where 元宝 is an AI member (userType=2) only present in the API-fetched list.
 */
async function resolveAtMentions(
  text: string,
  groupCode?: string,
  memberInst?: Member,
): Promise<OutboundContentItem[]> {
  const items: OutboundContentItem[] = [];
  let lastIndex = 0;
  let fallbackFetched = false;

  for (const match of text.matchAll(AT_USER_RE)) {
    const matchStart = match.index ?? 0;
    const nickName = match[1]!;
    let userRecord =
      groupCode && memberInst ? memberInst.lookupUserByNickName(groupCode, nickName) : undefined;

    // Cache miss in a group: pull the full member list once and retry the
    // lookup. Subsequent misses in the same call skip the fetch (flag) and
    // just warn below.
    if (!userRecord && groupCode && memberInst && !fallbackFetched) {
      await memberInst.group.getMembers(groupCode);
      fallbackFetched = true;
      userRecord = memberInst.lookupUserByNickName(groupCode, nickName);
    }

    // Only split when the @ resolves to a real group member; otherwise leave
    // @keyframes / @media / unknown @ tokens in place (avoid broken joins in client).
    if (!userRecord) {
      if (groupCode && memberInst) {
        log.warn("at-mention resolve failed, leaving as plain text", { groupCode, nickName });
      }
      continue;
    }

    if (matchStart > lastIndex) {
      const before = text.slice(lastIndex, matchStart);
      if (before.trim()) {
        items.push({ type: "text", text: before.trim() });
      }
    }

    items.push({
      type: "custom",
      data: JSON.stringify({
        elem_type: 1002,
        text: `@${userRecord.nickName}`,
        user_id: userRecord.userId,
      }),
    });

    lastIndex = matchStart + match[0].length;
  }

  // Remaining trailing text
  if (lastIndex < text.length) {
    const trailing = text.slice(lastIndex);
    if (trailing.trim()) {
      items.push({ type: "text", text: trailing.trim() });
    }
  }

  // No matches: return original text
  if (items.length === 0 && text.trim()) {
    items.push({ type: "text", text: text.trim() });
  }

  return items;
}

export async function prepareOutboundContent(
  text: string,
  groupCode?: string,
  memberInst?: Member,
): Promise<OutboundContentItem[]> {
  if (!text) {
    return [];
  }

  const sanitizedText = mdTable.sanitize(mdMath.normalize(text));

  const items: OutboundContentItem[] = [];

  // Process text with @user resolution
  if (sanitizedText.length) {
    const trailing = sanitizedText.trim();
    if (trailing) {
      items.push(...await resolveAtMentions(trailing, groupCode, memberInst));
    }
  }

  // If no matches, parse entire text for @user mentions
  if (items.length === 0 && sanitizedText.trim()) {
    items.push(...await resolveAtMentions(sanitizedText.trim(), groupCode, memberInst));
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
