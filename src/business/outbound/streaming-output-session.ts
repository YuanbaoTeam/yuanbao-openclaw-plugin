/**
 * StreamingOutputSession — receives onPartialReply cumulative text and manages
 * when to send it to the user.
 *
 * Unlike the old push-based QueueSession, this session holds a single
 * `cumulativeText` snapshot (the full text generated so far) and a `sentIndex`
 * pointer, so it only ever sends the unsent delta.
 *
 * Two modes controlled by `disableBlockStreaming`:
 *   false (default) — send when enough unsent chars have accumulated (>= minChars)
 *                     and the text is safe to split (fence closed, table complete).
 *   true            — buffer everything until finalize().
 *
 * Thinking boundary repair:
 *   SDK fires onReasoningEnd twice in succession when a <think> block ends.
 *   The onPartialReply text between these two calls contains spurious \n injected
 *   at the thinking boundary. Detection uses a "sandwich" pattern:
 *     onReasoningEnd(1st) → onPartialReply → onReasoningEnd(2nd)
 *   The 2nd onReasoningEnd triggers the repair by comparing cumulativeText
 *   with the snapshot taken at the 1st onReasoningEnd.
 */

import { createLog } from "../../logger.js";
import { mdFence, mdBlock, mdAtomic, mdTable } from "../utils/markdown.js";
import {
  repairAllThinkingBoundaryJoins,
  repairThinkingBoundaryJoin,
  repairThinkingBoundaryNewlines,
} from "../pipeline/repair-thinking-boundary.js";
import type { MessageSender } from "./types.js";

const log = createLog("streaming-output-session");

export interface StreamingOutputSessionOptions {
  sender: MessageSender;
  sessionKey?: string;
  /** When true, buffer all text until finalize(); default false */
  disableBlockStreaming?: boolean;
  /** Minimum unsent chars before streaming a chunk; default 2800 */
  minChars?: number;
  /** Maximum chars per outbound message; default 3000 */
  maxChars?: number;
  chunkText?: (text: string, maxChars: number) => string[];
  onComplete?: () => void;
}

export interface StreamingOutputSession {
  /** Receive the latest cumulative partial reply text */
  update(cumulativeText: string): Promise<void>;
  /** Record a thinking/reasoning boundary for newline-repair */
  markReasoningBoundary(): void;
  /** Force-send all unsent text immediately (e.g. before a tool call) */
  flushNow(): Promise<void>;
  /** End session: send remaining unsent text, return true if anything was sent */
  finalize(): Promise<boolean>;
  /** Abort: discard all buffered content */
  abort(): void;
  /** Append extra text not from onPartialReply (e.g. /status suffix) */
  appendText(text: string): void;
  /** Whether any onPartialReply updates have been received */
  hasReceivedPartial(): boolean;
}

function defaultChunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += max) {
    chunks.push(text.slice(i, i + max));
  }
  return chunks;
}

function debugSnippet(text: string, n = 30): string {
  const safe = text.replace(/\n/g, "↵").replace(/\r/g, "↩");
  if (safe.length <= n * 2 + 5) return safe;
  return `${safe.slice(0, n)}…${safe.slice(-n)}`;
}

export function createStreamingOutputSession(opts: StreamingOutputSessionOptions): StreamingOutputSession {
  const {
    sender,
    sessionKey = "",
    disableBlockStreaming = false,
    minChars = 2800,
    maxChars = 3000,
    onComplete,
  } = opts;

  const baseChunkText = opts.chunkText ?? defaultChunkText;
  const chunkText = (text: string, max: number) => mdAtomic.chunkAware(text, max, baseChunkText);

  let aborted = false;
  let cumulativeText = "";
  let sentIndex = 0;
  let appendedSuffix = "";
  let hasSentContent = false;
  let receivedPartial = false;

  // Thinking boundary repair state (prefix-based, for mid-stream boundaries)
  const reasoningBoundaryPrefixes: string[] = [];

  // Sandwich detection state:
  //   consecutiveReasoningEndCount tracks how many onReasoningEnd fired since
  //   the last onPartialReply. When it reaches 2, we know a sandwich occurred
  //   and the cumulativeText contains spurious \n.
  let consecutiveReasoningEndCount = 0;
  let textAtFirstReasoningEnd = "";
  // Once a sandwich has been detected and repaired, ALL subsequent onPartialReply
  // updates must also be repaired (SDK keeps sending cumulative text with the
  // original spurious \n).
  let sandwichRepairActive = false;

  let sendChain: Promise<void> = Promise.resolve();

  function enqueue(fn: () => Promise<void>): Promise<void> {
    sendChain = sendChain.then(async () => {
      if (aborted) return;
      await fn();
    });
    return sendChain;
  }

  function isSplitSafe(text: string): boolean {
    if (mdFence.hasUnclosed(text)) return false;
    if (mdBlock.isTableInProgress(text)) return false;
    return true;
  }

  async function sendChunk(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    log.debug(`[DEBUG][${sessionKey}] 发送消息分片，长度=${trimmed.length}`);
    const result = await sender.sendText(trimmed);
    if (!result.ok) {
      log.error(`[${sessionKey}] sendText 失败: ${result.error}`);
    } else {
      hasSentContent = true;
    }
  }

  async function drainUnsent(force: boolean): Promise<void> {
    const fullText = cumulativeText + appendedSuffix;
    const unsent = fullText.slice(sentIndex);

    if (!unsent.trim()) return;

    if (!force) {
      if (unsent.length < minChars) {
        log.debug(`[DEBUG][${sessionKey}] 未发送字数不足（${unsent.length} < ${minChars}），继续等待`);
        return;
      }
      if (!isSplitSafe(fullText)) {
        log.debug(`[DEBUG][${sessionKey}] 文本分割不安全（代码块/表格未闭合），等待更多内容`);
        return;
      }
    }

    const sanitized = mdTable.sanitize(unsent);
    const chunks = chunkText(sanitized, maxChars);

    if (!force && chunks.length <= 1 && unsent.length < minChars) return;

    log.debug(`[DEBUG][${sessionKey}] 开始排出缓冲，force=${force}，分片数=${chunks.length}，未发字数=${unsent.length}`);

    if (force || chunks.length <= 1) {
      sentIndex = fullText.length;
      for (const chunk of chunks) {
        if (aborted) return;
        await sendChunk(chunk);
      }
    } else {
      const toSend = chunks.slice(0, -1);
      const sent = toSend.join("").length;
      sentIndex += sent;
      log.debug(`[DEBUG][${sessionKey}] 发送前 ${toSend.length} 个分片，保留末尾片（长度 ${chunks.at(-1)?.length ?? 0}）`);
      for (const chunk of toSend) {
        if (aborted) return;
        await sendChunk(chunk);
      }
    }
  }

  /** 执行三明治修复：在第 2 个 onReasoningEnd 时修复 cumulativeText 中的错误换行 */
  function repairSandwich(): void {
    const before = cumulativeText;
    if (!before) {
      log.debug(`[DEBUG][${sessionKey}] [三明治修复] cumulativeText 为空，跳过`);
      return;
    }

    log.debug(`[DEBUG][${sessionKey}] [三明治修复] 快照="${debugSnippet(textAtFirstReasoningEnd, 30)}"（长度=${textAtFirstReasoningEnd.length}），当前="${debugSnippet(before, 50)}"`);

    if (textAtFirstReasoningEnd) {
      const repaired = repairThinkingBoundaryJoin(textAtFirstReasoningEnd, before);
      if (repaired !== before) {
        cumulativeText = repaired;
        log.debug(`[DEBUG][${sessionKey}] [三明治修复-前缀匹配] 修复后="${debugSnippet(repaired, 50)}"`);
      } else {
        log.debug(`[DEBUG][${sessionKey}] [三明治修复-前缀匹配] 无变化`);
      }
    } else {
      const repaired = repairThinkingBoundaryNewlines(before);
      if (repaired !== before) {
        cumulativeText = repaired;
        log.debug(`[DEBUG][${sessionKey}] [三明治修复-CJK兜底] 修复后="${debugSnippet(repaired, 50)}"`);
      } else {
        log.debug(`[DEBUG][${sessionKey}] [三明治修复-CJK兜底] 无变化（正则未匹配）`);
      }
    }
  }

  return {
    async update(text: string): Promise<void> {
      if (aborted) return;
      receivedPartial = true;

      // Step 1: 对已有的边界前缀做精确修复（针对流中间的 thinking 边界）
      let repaired = repairAllThinkingBoundaryJoins(reasoningBoundaryPrefixes, text);

      // Step 2: 如果三明治修复已激活，持续对后续 partial 做 newline 清理
      // （SDK 后续 partial 仍携带原始错误 \n，需要每次都修复）
      if (sandwichRepairActive) {
        const before = repaired;
        repaired = repairThinkingBoundaryNewlines(repaired);
        if (repaired !== before) {
          log.debug(`[DEBUG][${sessionKey}] [三明治持续修复] 修复前="${debugSnippet(before, 40)}"，修复后="${debugSnippet(repaired, 40)}"`);
        }
      }

      if (repaired !== text) {
        log.debug(`[DEBUG][${sessionKey}] [修复完成] 修复前="${debugSnippet(text, 40)}"，修复后="${debugSnippet(repaired, 40)}"`);
      } else {
        log.debug(`[DEBUG][${sessionKey}] [partial更新] 长度=${text.length}，边界前缀数=${reasoningBoundaryPrefixes.length}，末尾="${debugSnippet(text, 40)}"`);
      }

      cumulativeText = repaired;

      if (disableBlockStreaming) return;

      return enqueue(() => drainUnsent(false));
    },

    markReasoningBoundary(): void {
      consecutiveReasoningEndCount++;

      if (consecutiveReasoningEndCount === 1) {
        // 第 1 次：保存快照
        textAtFirstReasoningEnd = cumulativeText;
        if (cumulativeText) {
          reasoningBoundaryPrefixes.push(cumulativeText);
          log.debug(`[DEBUG][${sessionKey}] [reasoning边界-第1次] 记录快照（长度=${cumulativeText.length}），末尾="${debugSnippet(cumulativeText, 30)}"`);
        } else {
          log.debug(`[DEBUG][${sessionKey}] [reasoning边界-第1次] 无累积文本，快照为空`);
        }
      } else if (consecutiveReasoningEndCount === 2) {
        // 第 2 次（三明治确认）：修复 cumulativeText 中被 thinking 边界插入的错误 \n
        log.debug(`[DEBUG][${sessionKey}] [reasoning边界-第2次] 检测到三明治结构，执行修复`);
        repairSandwich();
        sandwichRepairActive = true;
        log.debug(`[DEBUG][${sessionKey}] [reasoning边界-第2次] 三明治修复已激活，后续 partial 将持续修复`);
        // 重置计数，后续可能还有新的三明治
        consecutiveReasoningEndCount = 0;
        textAtFirstReasoningEnd = "";
      }
    },

    flushNow(): Promise<void> {
      if (disableBlockStreaming) {
        log.debug(`[DEBUG][${sessionKey}] [flushNow] disableBlockStreaming=true，跳过`);
        return Promise.resolve();
      }
      if (aborted) return Promise.resolve();
      log.debug(`[DEBUG][${sessionKey}] [flushNow] 强制排出缓冲（tool call 前）`);
      return enqueue(() => drainUnsent(true));
    },

    async finalize(): Promise<boolean> {
      if (aborted) return hasSentContent;
      await sendChain;
      if (aborted) return hasSentContent;

      const fullText = cumulativeText + appendedSuffix;
      const remaining = fullText.slice(sentIndex).trim();
      log.debug(`[DEBUG][${sessionKey}] [finalize] 剩余未发字数=${remaining.length}，已发送=${hasSentContent}`);
      if (remaining) {
        const sanitized = mdFence.stripOuter(mdTable.sanitize(remaining));
        const chunks = chunkText(sanitized, maxChars);
        log.debug(`[DEBUG][${sessionKey}] [finalize] 分片数=${chunks.length}`);
        for (const chunk of chunks) {
          if (aborted) break;
          await sendChunk(chunk);
          sentIndex += chunk.length;
        }
      }

      onComplete?.();
      return hasSentContent;
    },

    abort(): void {
      log.debug(`[DEBUG][${sessionKey}] [abort] 丢弃缓冲，长度=${cumulativeText.length}`);
      aborted = true;
      cumulativeText = "";
      appendedSuffix = "";
      onComplete?.();
    },

    appendText(text: string): void {
      if (aborted) return;
      log.debug(`[DEBUG][${sessionKey}] [appendText] 追加后缀，长度=${text.length}`);
      appendedSuffix += text;
    },

    hasReceivedPartial(): boolean {
      return receivedPartial;
    },
  };
}
