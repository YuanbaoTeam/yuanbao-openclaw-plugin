/**
 * Topic metadata parsed from cloud_custom_data.
 *
 * Messages produced inside a topic carry `{ topicId, botMuted? }` in their
 * `cloud_custom_data` JSON. These are used by resolve-mention (L0 mute,
 * L2 topic self-judge) and resolve-route (session isolation).
 */

import type { CloudCustomData } from "../../../types.js";

export interface TopicMeta {
  topicId?: string;
  botMuted?: boolean;
}

/**
 * Parse topic metadata from a cloud_custom_data JSON string.
 *
 * Tolerant of malformed input — returns `{}` when the string is empty,
 * malformed, or contains no topic fields. Never throws.
 */
export function parseTopicMeta(cloudCustomData: string | undefined): TopicMeta {
  if (!cloudCustomData) {
    return {};
  }
  try {
    const parsed: CloudCustomData = JSON.parse(cloudCustomData);
    const out: TopicMeta = {};
    if (typeof parsed.topicId === "string" && parsed.topicId.length > 0) {
      out.topicId = parsed.topicId;
    }
    if (typeof parsed.botMuted === "boolean") {
      out.botMuted = parsed.botMuted;
    }
    return out;
  } catch {
    return {};
  }
}
