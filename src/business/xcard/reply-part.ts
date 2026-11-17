/**
 * Bridge OpenClaw parsed A2UI reply parts to the existing generated xCard lifecycle.
 *
 * Accept structured parts or an explicit `<a2ui>...</a2ui>` block in text.
 * Surrounding text stays outside the card in the same IM message.
 */

import type { YuanbaoWsClient } from "../../access/ws/client.js";
import { createLog } from "../../logger.js";
import type { ResolvedYuanbaoAccount } from "../../types.js";
import { compileExpressMessages } from "./express.js";
import { getSurface, withSurfaceLock, type SurfaceAudience, type SurfaceMode } from "./registry.js";
import { createGeneratedCard, updateGeneratedCard, XCardSendError } from "./service.js";

type Obj = Record<string, unknown>;
const A2UI_BLOCK_RE = /<a2ui\b[^>]*>([\s\S]*?)<\/a2ui>/i;
const OUTER_FENCE_RE = /^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/;
const OPEN_TAG = "<a2ui";
const FENCE = "```";

const log = createLog("xcard.reply-part");

export interface A2uiReplyPart {
  content: string;
  title?: string;
  fallbackText?: string;
  mode?: SurfaceMode;
  audience?: SurfaceAudience;
  surfaceId?: string;
  textBefore?: string;
  textAfter?: string;
}

export interface SendA2uiReplyPartParams {
  part: A2uiReplyPart;
  account: ResolvedYuanbaoAccount;
  wsClient: YuanbaoWsClient;
  isGroup: boolean;
  targetId: string;
  sessionKey: string;
  ownerUserId: string;
}

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0)?.trim();
}

function isA2uiKind(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase().replace(/[_-]/g, "");
  return normalized === "a2ui" || normalized === "a2uiexpress";
}

function unwrapOuterFence(value: string): string {
  const trimmed = value.trim();
  return (OUTER_FENCE_RE.exec(trimmed)?.[1] ?? trimmed).trim();
}

function splitTextAroundA2uiBlock(body: string, match: RegExpExecArray): { textBefore: string; textAfter: string } {
  let textBefore = body.slice(0, match.index);
  let textAfter = body.slice(match.index + match[0].length);
  const fenceOpener = /(?:^|\r?\n)```[^\r\n]*\r?\n\s*$/.exec(textBefore);
  if (fenceOpener) {
    textBefore = textBefore.slice(0, fenceOpener.index);
    textAfter = textAfter.replace(/^\s*```[ \t]*(?:\r?\n|$)/, "");
  }
  return { textBefore: textBefore.trim(), textAfter: textAfter.trim() };
}

function partFromObject(value: Obj): A2uiReplyPart | undefined {
  const nested = isObj(value.a2ui) ? value.a2ui : undefined;
  const metadata = isObj(value.metadata) ? value.metadata : isObj(nested?.metadata) ? nested.metadata : undefined;
  const content = stringValue(
    value.a2ui,
    value.a2uiContent,
    value.content,
    nested?.content,
    nested?.text,
    nested?.express,
    value.express,
  );
  const kind = isA2uiKind(value.type) || isA2uiKind(value.kind) || isA2uiKind(value.messageType);
  if (!content || (!kind && !nested && typeof value.a2ui !== "string" && typeof value.a2uiContent !== "string")) {
    return undefined;
  }
  const title = stringValue(value.title, metadata?.title, nested?.title);
  const fallbackText = stringValue(value.fallbackText, metadata?.fallbackText, nested?.fallbackText);
  const surfaceId = stringValue(value.surfaceId, metadata?.surfaceId, nested?.surfaceId);
  return {
    content,
    ...(title ? { title } : {}),
    ...(fallbackText ? { fallbackText } : {}),
    ...(surfaceId ? { surfaceId } : {}),
    mode: value.mode === "perRevision" || metadata?.mode === "perRevision" || nested?.mode === "perRevision" ? "perRevision" : "once",
    audience: value.audience === "anyone" || metadata?.audience === "anyone" || nested?.audience === "anyone" ? "anyone" : "requester",
  };
}

function partFromText(value: string): A2uiReplyPart | undefined {
  const body = unwrapOuterFence(value);
  const match = A2UI_BLOCK_RE.exec(body);
  if (!match) return undefined;
  const content = unwrapOuterFence(match[1] ?? "");
  if (!content) return undefined;
  const { textBefore, textAfter } = splitTextAroundA2uiBlock(body, match);
  return {
    content,
    mode: "once",
    audience: "requester",
    ...(textBefore ? { textBefore } : {}),
    ...(textAfter ? { textAfter } : {}),
  };
}

/**
 * Whether cumulative streaming text could still turn into a whole-reply `<a2ui>` block.
 * Holding such partials is lossless: the next cumulative partial or the final deliver carries
 * the full text.
 */
export function mayBecomeA2uiReply(text: string): boolean {
  let rest = text.trimStart();
  if (!rest) return false;
  if (rest.startsWith(FENCE)) {
    const newline = rest.indexOf("\n");
    if (newline < 0) return true;
    rest = rest.slice(newline + 1).trimStart();
  } else if (FENCE.startsWith(rest)) {
    return true;
  }
  const head = rest.slice(0, OPEN_TAG.length).toLowerCase();
  return OPEN_TAG.startsWith(head);
}

export function extractA2uiReplyPart(payload: unknown): A2uiReplyPart | undefined {
  if (!isObj(payload)) return undefined;
  const direct = partFromObject(payload);
  if (direct) return direct;
  if (typeof payload.text === "string") {
    const fromText = partFromText(payload.text);
    if (fromText) return fromText;
  }

  for (const key of ["parts", "content", "messages", "items"]) {
    const list = payload[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (typeof item === "string") {
        const fromText = partFromText(item);
        if (fromText) return fromText;
        continue;
      }
      if (!isObj(item)) continue;
      const found = partFromObject(item);
      if (found) return found;
      if (typeof item.text === "string") {
        const fromText = partFromText(item.text);
        if (fromText) return fromText;
      }
    }
  }
  return undefined;
}

export async function sendA2uiReplyPart(p: SendA2uiReplyPartParams): Promise<{ ok: true; updated: boolean } | { ok: false; error: string }> {
  const compiled = compileExpressMessages(p.part.content);
  if ("error" in compiled) {
    log.warn("compile failed", { error: compiled.error, contentLength: p.part.content.length });
    return { ok: false, error: compiled.error };
  }

  const title = p.part.title?.trim() || "交互卡片";
  const fallbackText = p.part.fallbackText?.trim() || title;
  const audience: SurfaceAudience = p.isGroup && p.part.audience === "anyone" ? "anyone" : "requester";
  const mode: SurfaceMode = p.part.mode === "perRevision" ? "perRevision" : "once";

  try {
    if (p.part.surfaceId) {
      const surfaceId = p.part.surfaceId;
      return await withSurfaceLock(surfaceId, async () => {
        const rec = getSurface(surfaceId);
        if (
          !rec
          || rec.kind !== "generated"
          || rec.accountId !== p.account.accountId
          || rec.isGroup !== p.isGroup
          || rec.groupCode !== p.targetId
          || rec.sessionKey !== p.sessionKey
          || rec.state !== "active"
        ) {
          return { ok: false as const, error: "a2ui reply part 指定的 surfaceId 不存在或不可更新" };
        }
        await updateGeneratedCard(rec, compiled.messages, title, fallbackText, p.account, p.wsClient, {
          textBefore: p.part.textBefore,
          textAfter: p.part.textAfter,
        });
        log.debug("generated card updated", { surfaceId: rec.surfaceId, revision: rec.revision });
        return { ok: true as const, updated: true };
      });
    }

    await createGeneratedCard({
      account: p.account,
      wsClient: p.wsClient,
      groupCode: p.targetId,
      isGroup: p.isGroup,
      sessionKey: p.sessionKey,
      ownerUserId: p.ownerUserId,
      audience,
      mode,
      title,
      fallbackText,
      messages: compiled.messages,
      textBefore: p.part.textBefore,
      textAfter: p.part.textAfter,
    });
    log.debug("generated card created", { mode, audience, isGroup: p.isGroup, messageCount: compiled.messages.length });
    return { ok: true, updated: false };
  } catch (err) {
    // The plain-text fallback already reached the user; treat it as delivered.
    if (err instanceof XCardSendError && err.fallbackSent) return { ok: true, updated: false };
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
