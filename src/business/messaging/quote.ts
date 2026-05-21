/**
 * Quote message business logic: parsing, media desc resolution, and formatting.
 */

import type { QuoteInfo, CloudCustomData } from "../../types.js";
import { chatMediaHistories } from "./chat-history.js";

/** IM client message_type enum (matches Tencent IM protocol definitions). */
enum ImClientMessageType {
  MT_UNKNOWN = 0,
  MT_TEXT = 1,
  MT_PIC = 2,
  MT_FILE = 3,
  MT_VIDEO = 4,
  MT_AUDIO = 5,
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Map from IM message_type code to display label. */
const TYPE_LABEL: Record<number, string> = {
  [ImClientMessageType.MT_PIC]: "image",
  [ImClientMessageType.MT_FILE]: "file",
  [ImClientMessageType.MT_VIDEO]: "video",
  [ImClientMessageType.MT_AUDIO]: "voice",
};

function isMediaQuoteType(type: number): boolean {
  return type in TYPE_LABEL;
}

/**
 * Parse quote info from cloud_custom_data JSON string and resolve its desc.
 *
 * For media-type quotes (image/file/video/voice) whose desc is empty,
 * resolves actual filenames from the media history LRU. Falls back to a
 * generic label (e.g. "[image]") when LRU data is unavailable.
 *
 * @param chatKey — used for LRU lookup; pass deriveChatKey() result.
 * @returns undefined if no quote exists, parsing fails, or the quote carries
 *          no useful information (empty desc AND not a recognized media type).
 */
export function parseQuoteFromCloudCustomData(
  cloudCustomData: string | undefined,
  chatKey?: string,
): QuoteInfo | undefined {
  if (!cloudCustomData) {
    return undefined;
  }
  try {
    const parsed: CloudCustomData = JSON.parse(cloudCustomData);
    if (!parsed.quote || typeof parsed.quote !== "object") {
      return undefined;
    }
    const { quote } = parsed;

    if (quote.desc?.trim()) {
      return quote;
    }

    const type = Number(quote.type);
    if (!isMediaQuoteType(type)) {
      return undefined;
    }
    quote.desc = resolveMediaQuoteDesc(type, quote.id, chatKey);
    return quote;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Media desc resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a descriptive desc for a media-type quote.
 * Looks up actual filenames from the media history LRU; falls back to
 * a generic label (e.g. "[image]") when LRU data is unavailable.
 */
export function resolveMediaQuoteDesc(
  type: number,
  quoteId: string | undefined,
  chatKey: string | undefined,
): string {
  const label = TYPE_LABEL[type] ?? "media";

  if (quoteId && chatKey) {
    const entry = (chatMediaHistories.get(chatKey) ?? [])
      .findLast(e => e.messageId === quoteId);
    const tags = (entry?.medias ?? [])
      .filter(m => m.url)
      .map(m => `[${label}:${m.mediaName || label}]`);
    if (tags.length > 0) {
      return tags.join("");
    }
  }

  return `[${label}]`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const QUOTE_DESC_MAX_LENGTH = 500;

/**
 * Format quoted message into context text for AI consumption.
 *
 * ```
 * > [Quoted message from <sender_nickname>]:
 * ><desc>
 * ```
 */
export function formatQuoteContext(quote: QuoteInfo): string {
  let senderPart = "";
  if (quote.sender_nickname) {
    senderPart = ` from ${quote.sender_nickname}`;
  } else if (quote.sender_id) {
    senderPart = ` from ${quote.sender_id}`;
  }

  let desc = quote.desc?.trim() || "";
  if (desc.length > QUOTE_DESC_MAX_LENGTH) {
    desc = `${desc.slice(0, QUOTE_DESC_MAX_LENGTH)}...(truncated)`;
  }

  return `> [Quoted message${senderPart}]:\n>${desc}\n`;
}
