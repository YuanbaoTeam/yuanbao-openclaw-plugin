/**
 * Thread info parsing module.
 *
 * Extracts thread/topic info from cloud_custom_data.ext_map.thread_info
 * and formats it as context text for the AI model.
 */

import type { CloudCustomData, ThreadInfo } from "../../types.js";

/**
 * Parse thread info from cloud_custom_data JSON string.
 * ext_map.thread_info is itself a JSON string that encodes ThreadInfo.
 * Returns undefined if no thread info exists or parsing fails.
 */
export function parseThreadInfoFromCloudCustomData(cloudCustomData?: string): ThreadInfo | undefined {
  if (!cloudCustomData) {
    return undefined;
  }

  try {
    const parsed: CloudCustomData = JSON.parse(cloudCustomData);
    const threadInfoStr = parsed.ext_map?.thread_info;
    if (!threadInfoStr) {
      return undefined;
    }

    const info: ThreadInfo = JSON.parse(threadInfoStr);
    if (!info.thread_conv_id || !Array.isArray(info.threads) || info.threads.length === 0) {
      return undefined;
    }

    return info;
  } catch {
    return undefined;
  }
}

/**
 * Format thread info into context text that can be prepended to user messages.
 *
 * Generated format:
 * ```
 * > [Current topics in this conversation]:
 * > - 夸到拉大学测评
 * > - 校园生活讨论
 * ```
 */
export function formatThreadContext(info: ThreadInfo): string {
  const titles = info.threads
    .map(t => t.thread_title?.trim())
    .filter(Boolean)
    .map(title => `> - ${title}`)
    .join("\n");

  if (!titles) {
    return "";
  }

  return `> [Current topics in this conversation]:\n${titles}\n`;
}
