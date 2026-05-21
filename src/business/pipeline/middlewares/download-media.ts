/**
 * Middleware: download images and files to agent-accessible directory.
 *
 * Auxiliary (non-current-message) media injection strategy:
 *
 *   • Has quoteInfo                     → inject the explicitly quoted message's media.
 *   • No quoteInfo, current msg has no media
 *                                       → inject the most recent media the same sender
 *                                         posted within RECENT_MEDIA_WINDOW_MS, so the AI
 *                                         can answer questions like "what's in the image
 *                                         I just sent?" without an explicit quote.
 *   • No quoteInfo, current msg has media
 *                                       → no auxiliary injection (the user is providing
 *                                         fresh media in the current message; falling back
 *                                         to history would be ambiguous).
 *
 * Current message media is always included and URL-deduplicated against auxiliaries.
 */

import type { QuoteInfo } from "../../../types.js";
import {
  chatMediaHistories,
  deriveChatKey,
  recordMediaHistory,
} from "../../messaging/chat-history.js";
import type { MediaItem } from "../../messaging/handlers/types.js";
import { downloadMediasToLocalFiles } from "../../utils/media.js";
import type { MiddlewareDescriptor } from "../types.js";

/** Time window for recent-history fallback (no explicit quote). */
const RECENT_MEDIA_WINDOW_MS = 10 * 60 * 1000;

/**
 * Look up media resources attached to the explicitly quoted message.
 * Returns [] when quoteInfo is absent or the message is no longer in the LRU.
 */
function getQuotedMedias(chatKey: string, quoteInfo?: QuoteInfo): MediaItem[] {
  if (!quoteInfo?.id) {
    return [];
  }
  const mediaList = chatMediaHistories.get(chatKey) ?? [];
  const entry = mediaList.findLast(e => e.messageId === quoteInfo.id);
  if (!entry) {
    return [];
  }
  return entry.medias
    .filter(m => m.url)
    .map(m => ({ mediaType: "image" as const, url: m.url, mediaName: m.mediaName }));
}

/**
 * Look up the most recent media posted by the same sender within the time window.
 * Used as a fallback when there is no explicit quote, so the AI can still access
 * an image the user recently sent.
 */
function getRecentHistoryMedias(
  chatKey: string,
  fromAccount: string,
  windowMs = RECENT_MEDIA_WINDOW_MS,
): MediaItem[] {
  const mediaList = chatMediaHistories.get(chatKey) ?? [];
  const now = Date.now();
  const entry = mediaList.findLast(
    e => e.sender === fromAccount && now - e.timestamp <= windowMs,
  );
  if (!entry) {
    return [];
  }
  return entry.medias
    .filter(m => m.url)
    .map(m => ({ mediaType: "image" as const, url: m.url, mediaName: m.mediaName }));
}

export const downloadMedia: MiddlewareDescriptor = {
  name: "download-media",
  when: ctx => !!ctx.medias,
  handler: async (ctx, next) => {
    const { medias, isGroup, groupCode, fromAccount, quoteInfo, account } = ctx;

    const chatKey = deriveChatKey(isGroup, groupCode, fromAccount);

    // Record current message media to LRU (both group and C2C)
    if (medias.length > 0) {
      recordMediaHistory(chatKey, {
        sender: fromAccount,
        messageId: ctx.raw.msg_id ?? String(ctx.raw.msg_seq ?? ""),
        timestamp: Date.now(),
        medias,
      });
    }

    // Auxiliary media:
    //   - quote present              → quoted message's media
    //   - no quote + no current media → recent media within window (fallback)
    //   - no quote + has current media → none (avoid ambiguous history injection)
    const auxiliaryMedias = quoteInfo
      ? getQuotedMedias(chatKey, quoteInfo)
      : medias.length === 0
        ? getRecentHistoryMedias(chatKey, fromAccount)
        : [];

    // De-duplicate: auxiliary first (higher priority), then current message media
    const currentUrls = new Set(medias.map(m => m.url));
    const uniqueAuxiliaryMedias = auxiliaryMedias.filter(m => !currentUrls.has(m.url));

    const allMedias = [...uniqueAuxiliaryMedias, ...medias];

    // Download media to local
    const { mediaPaths, mediaTypes } = await downloadMediasToLocalFiles(allMedias, account);

    ctx.mediaPaths = mediaPaths;
    ctx.mediaTypes = mediaTypes;

    await next();
  },
};
