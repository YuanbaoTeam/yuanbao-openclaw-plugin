/**
 * Group chat message history state.
 *
 * Manages two types of group chat history caches:
 *   - chatHistories      — text history for AI context assembly and recall detection
 *   - chatMediaHistories — media history LRU, lifecycle decoupled from chatHistories
 *                          to prevent media loss when history is cleared after @bot
 */

import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";

/** Extended history entry, additionally stores media resources carried by the message (for batch download on @bot) */
export type GroupHistoryEntry = HistoryEntry & {
  medias?: Array<{ url: string; mediaName?: string }>;
};

/** Standalone media history entry */
export type MediaHistoryEntry = {
  sender: string;
  messageId?: string;
  timestamp: number;
  medias: Array<{ url: string; mediaName?: string }>;
};

/** Group chat message history Map, keyed by groupCode */
export const chatHistories = new Map<string, GroupHistoryEntry[]>();

const MEDIA_HISTORY_MAX_PER_CHAT = 50;

/** Media history LRU, keyed by chatKey. Not cleared by clearHistoryEntriesIfEnabled. */
export const chatMediaHistories = new Map<string, MediaHistoryEntry[]>();

/**
 * Derive a chat-level cache key for media history.
 * Format follows prepare-sender convention: `group:{groupCode}` / `direct:{fromAccount}`.
 */
export function deriveChatKey(isGroup: boolean, groupCode?: string, fromAccount?: string): string {
  if (isGroup && groupCode) {
    return `group:${groupCode}`;
  }
  return `direct:${fromAccount ?? "unknown"}`;
}

/**
 * Write media entry to standalone LRU, evicting oldest entries when exceeding limit.
 * Decoupled from text `chatHistories` to prevent media loss when text history is cleared after @bot.
 */
export function recordMediaHistory(chatKey: string, entry: MediaHistoryEntry): void {
  if (entry.medias.length === 0) {
    return;
  }
  let list = chatMediaHistories.get(chatKey);
  if (!list) {
    list = [];
    chatMediaHistories.set(chatKey, list);
  }
  list.push(entry);
  if (list.length > MEDIA_HISTORY_MAX_PER_CHAT) {
    list.splice(0, list.length - MEDIA_HISTORY_MAX_PER_CHAT);
  }
}
