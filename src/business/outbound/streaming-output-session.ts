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
 *     onReasoningEnd(1st) -> onPartialReply -> onReasoningEnd(2nd)
 *   The 2nd onReasoningEnd triggers repair via repairSandwichText().
 *   The repair records brokenFragment/repairedFragment so subsequent
 *   onPartialReply updates (which still carry the original broken text from
 *   the SDK) can be fixed via a simple string replace.
 */

import { createLog } from "../../logger.js";
import { mdFence, mdBlock, mdAtomic, mdTable } from "../utils/markdown.js";
import {
  repairAllThinkingBoundaryJoins,
  repairThinkingBoundaryJoin,
  repairSandwichText,
  type SandwichRepairResult,
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
  const safe = text.replace(/\n/g, "\u21b5").replace(/\r/g, "\u21a9");
  if (safe.length <= n * 2 + 5) return safe;
  return `${safe.slice(0, n)}\u2026${safe.slice(-n)}`;
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

  // Prefix-based repair: for thinking boundaries encountered mid-stream
  const reasoningBoundaryPrefixes: string[] = [];

  // Sandwich repair state:
  //   consecutiveReasoningEndCount — how many onReasoningEnd have fired
  //   since the last onPartialReply (reset after 2nd fires)
  let consecutiveReasoningEndCount = 0;
  let textAtFirstReasoningEnd = "";
  // Records brokenFragment -> repairedFragment from the last sandwich repair.
  // Used to replay the fix on subsequent onPartialReply calls (which the SDK
  // continues to send with the original broken text).
  let sandwichRepair: SandwichRepairResult | null = null;

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

  /**
   * Compute the code-fence state at a given offset in the full text.
   * Used to determine whether the next chunk-to-send starts inside a fence.
   */
  function computeFenceStateAt(text: string): { inFence: boolean; fenceLang: string } {
    let inFence = false;
    let fenceLang = "";
    for (const line of text.split("\n")) {
      if (line.startsWith("```")) {
        if (inFence) { inFence = false; fenceLang = ""; }
        else { inFence = true; fenceLang = line.slice(3).trim(); }
      }
    }
    return { inFence, fenceLang };
  }

  /**
   * When a code block is split across multiple chunks, each chunk that starts
   * inside a fence must have the appropriate opening fence prepended, and each
   * chunk that ends inside a fence (but is not the last chunk) must have a
   * closing fence appended so the recipient sees well-formed code blocks.
   *
   * @param initialFenceState  fence state at the start of the first chunk
   *                           (from previously sent text, if any)
   */
  function repairChunkFences(
    rawChunks: string[],
    initialFenceState: { inFence: boolean; fenceLang: string } = { inFence: false, fenceLang: "" },
  ): string[] {
    if (rawChunks.length === 0) return rawChunks;

    const result: string[] = [];
    let fenceOpen = initialFenceState.inFence;
    let fenceLang = initialFenceState.fenceLang;

    for (let i = 0; i < rawChunks.length; i++) {
      const chunk = rawChunks[i]!;

      // Compute exit fence state by scanning the original chunk content
      let exitFence = fenceOpen;
      let exitLang = fenceLang;
      for (const line of chunk.split("\n")) {
        if (line.startsWith("```")) {
          if (exitFence) { exitFence = false; exitLang = ""; }
          else { exitFence = true; exitLang = line.slice(3).trim(); }
        }
      }

      let out = chunk;

      // Prepend opening fence if this chunk starts inside a fence
      if (fenceOpen) {
        out = (fenceLang ? `\`\`\`${fenceLang}\n` : "```\n") + out;
      }

      // Append closing fence if this chunk ends inside a fence (not the last chunk)
      if (exitFence && i < rawChunks.length - 1) {
        out = out + "\n```";
      }

      result.push(out);
      fenceOpen = exitFence;
      fenceLang = exitLang;
    }

    return result;
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
      // Check only the UNSENT portion — already-sent text may have closed fences/tables.
      if (!isSplitSafe(unsent)) {
        log.debug(`[DEBUG][${sessionKey}] 文本分割不安全（代码块/表格未闭合），等待更多内容`);
        return;
      }
    }

    // Chunk the ORIGINAL (unsanitized) unsent text so that sentIndex offsets stay
    // accurate — mdTable.sanitize may change text length, which would break the index.
    const chunks = chunkText(unsent, maxChars);

    // Non-forced: only send when content overflows one message.
    // If it fits in a single message, wait for flushNow()/finalize() to avoid
    // sending mid-sentence content just because minChars chars accumulated.
    if (!force && chunks.length <= 1) {
      log.debug(`[DEBUG][${sessionKey}] 内容可单条发送（${unsent.length} 字），等待强制 flush 避免截断`);
      return;
    }

    log.debug(`[DEBUG][${sessionKey}] 开始排出缓冲，force=${force}，分片数=${chunks.length}，未发字数=${unsent.length}`);

    // Determine fence state at the current send position (start of unsent text)
    const fenceState = computeFenceStateAt(fullText.slice(0, sentIndex));

    if (force) {
      sentIndex = fullText.length;
      // Sanitize and re-chunk the full unsent text for actual delivery
      const sanitized = mdFence.stripOuter(mdTable.sanitize(unsent));
      const finalChunks = repairChunkFences(chunkText(sanitized, maxChars), fenceState);
      for (const chunk of finalChunks) {
        if (aborted) return;
        await sendChunk(chunk);
      }
    } else {
      // chunks.length > 1: send all but last, keep last in buffer.
      // Use lengths from the ORIGINAL chunks to advance sentIndex correctly.
      const toSend = chunks.slice(0, -1);
      const sentLength = toSend.join("").length;
      sentIndex += sentLength;
      log.debug(`[DEBUG][${sessionKey}] 发送前 ${toSend.length} 个分片，保留末尾片（长度 ${chunks.at(-1)?.length ?? 0}）`);
      // Sanitize and repair fences on the chunks actually sent.
      // We operate on all original chunks (including the last kept-in-buffer chunk)
      // so that repairChunkFences can correctly track fence state across the boundary.
      const sanitizedChunks = repairChunkFences(chunks.map(c => mdTable.sanitize(c)), fenceState);
      for (let ci = 0; ci < toSend.length; ci++) {
        if (aborted) return;
        await sendChunk(sanitizedChunks[ci]!);
      }
    }
  }

  return {
    async update(text: string): Promise<void> {
      if (aborted) return;
      receivedPartial = true;

      // Step 1: prefix-based repair (for mid-stream thinking boundaries)
      let repaired = repairAllThinkingBoundaryJoins(reasoningBoundaryPrefixes, text);

      // Step 2: replay the sandwich repair using brokenFragment -> repairedFragment
      // (SDK keeps sending cumulative text with original spurious \n)
      if (sandwichRepair?.brokenFragment) {
        const before = repaired;
        repaired = repaired.replace(sandwichRepair.brokenFragment, sandwichRepair.repairedFragment);
        if (repaired !== before) {
          log.debug(`[DEBUG][${sessionKey}] [三明治重放修复] 修复前末尾="${debugSnippet(before, 40)}"，修复后="${debugSnippet(repaired, 40)}"`);
        }
      }

      if (repaired !== text) {
        log.debug(`[DEBUG][${sessionKey}] [修复完成] 修复前末尾="${debugSnippet(text, 40)}"，修复后="${debugSnippet(repaired, 40)}"`);
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
        textAtFirstReasoningEnd = cumulativeText;
        if (cumulativeText) {
          reasoningBoundaryPrefixes.push(cumulativeText);
          log.debug(`[DEBUG][${sessionKey}] [reasoning边界-第1次] 记录快照（长度=${cumulativeText.length}），末尾="${debugSnippet(cumulativeText, 30)}"`);
        } else {
          log.debug(`[DEBUG][${sessionKey}] [reasoning边界-第1次] 无累积文本，快照为空`);
        }
      } else if (consecutiveReasoningEndCount === 2) {
        // Sandwich confirmed — repair the cumulativeText
        log.debug(`[DEBUG][${sessionKey}] [reasoning边界-第2次] 检测到三明治结构，执行修复`);

        if (!cumulativeText) {
          log.debug(`[DEBUG][${sessionKey}] [reasoning边界-第2次] cumulativeText 为空，跳过`);
        } else {
          log.debug(`[DEBUG][${sessionKey}] [三明治修复] 快照="${debugSnippet(textAtFirstReasoningEnd, 30)}"（长度=${textAtFirstReasoningEnd.length}），当前="${debugSnippet(cumulativeText, 50)}"`);

          const result = repairSandwichText(textAtFirstReasoningEnd, cumulativeText);

          if (result.brokenFragment) {
            cumulativeText = result.repaired;
            sandwichRepair = result;
            log.debug(`[DEBUG][${sessionKey}] [三明治修复-成功] 修复后="${debugSnippet(result.repaired, 50)}"，broken="${debugSnippet(result.brokenFragment, 30)}"→repaired="${debugSnippet(result.repairedFragment, 30)}"`);
          } else {
            log.debug(`[DEBUG][${sessionKey}] [三明治修复-无变化] 未发现可修复的单换行`);
          }

          // Push the (possibly repaired) cumulativeText as a boundary prefix.
          // This handles the JOIN POINT between text1 and text2: the next
          // onPartialReply will have delta = text2.slice(text1.length), and if
          // that delta starts with \n, repairAllThinkingBoundaryJoins will strip it.
          if (cumulativeText && !cumulativeText.endsWith("\n")) {
            reasoningBoundaryPrefixes.push(cumulativeText);
            log.debug(`[DEBUG][${sessionKey}] [三明治修复] 已将文本记为边界前缀（长度=${cumulativeText.length}），用于修复后续 partial 的拼接点`);
          }
        }

        // Reset for potential future sandwiches
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
        const fenceState = computeFenceStateAt(fullText.slice(0, sentIndex));
        const sanitized = mdFence.stripOuter(mdTable.sanitize(remaining));
        const chunks = repairChunkFences(chunkText(sanitized, maxChars), fenceState);
        log.debug(`[DEBUG][${sessionKey}] [finalize] 分片数=${chunks.length}，起始fence=${fenceState.inFence ? fenceState.fenceLang || "yes" : "no"}`);
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
