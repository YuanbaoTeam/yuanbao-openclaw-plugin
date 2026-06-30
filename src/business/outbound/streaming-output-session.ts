/**
 * Streaming output session: receives cumulative onPartialReply text and decides
 * when to send. Streaming flushes when chunkText yields >1 chunk (all but last);
 * finalize / flushNow send the remainder.
 */

import { createLog } from "../../logger.js";
import { mdFence, mdSplit, type FenceState } from "../utils/markdown.js";
import { createRepairThinkingBoundary } from "./repair/thinking-boundary.js";
import type { MessageSender } from "./types.js";

const log = createLog("streaming-output-session");

const DEFAULT_MIN_SEND_INTERVAL_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface StreamingOutputSessionOptions {
  sender: MessageSender;
  sessionKey?: string;
  /** When true, buffer all text until finalize(); default false */
  disableBlockStreaming?: boolean;
  /** Minimum unsent chars before streaming a chunk; default 800 */
  minChars?: number;
  /** Maximum chars per outbound message; default 1200 */
  maxChars?: number;
  /** Markdown-aware chunker, e.g. core.channel.text.chunkMarkdownText */
  chunkText?: (text: string, maxChars: number) => string[];
  /** Minimum interval between consecutive sendText calls; default 1000ms */
  minSendIntervalMs?: number;
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
  /** Whether any onPartialReply updates have been received */
  hasReceivedPartial(): boolean;
}

/** Fallback chunker: prefer breaking at newline boundaries; hard-split only for overlong lines. */
export function defaultChunkText(text: string, max: number): string[] {
  if (!text) return [];
  if (max <= 0 || text.length <= max) return [text];

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const remaining = text.length - start;
    if (remaining <= max) {
      chunks.push(text.slice(start));
      break;
    }

    const window = text.slice(start, start + max);
    const lastNewline = window.lastIndexOf("\n");

    const breakIdx =
      lastNewline > 0
        ? start + lastNewline + 1
        : lastNewline === 0
          ? start + 1
          : start + max;

    chunks.push(text.slice(start, breakIdx));
    start = breakIdx;
  }

  return chunks;
}

/**
 * Cross-message fence repair when a prior send ended inside an open fence.
 */
function repairDeliveryChunks(
  rawChunks: string[],
  initialFenceState: FenceState,
): string[] {
  if (rawChunks.length === 0 || !initialFenceState.inFence) {
    return rawChunks;
  }
  return applyCrossMessageFenceRepair(rawChunks, initialFenceState);
}

function applyCrossMessageFenceRepair(
  rawChunks: string[],
  initialFenceState: FenceState,
): string[] {
  if (rawChunks.length === 0) return rawChunks;

  const result: string[] = [];
  let inFence = initialFenceState.inFence;
  let fenceLang = initialFenceState.fenceLang;

  for (let i = 0; i < rawChunks.length; i++) {
    let out = rawChunks[i]!;
    const endBeforeRepair = mdFence.computeState(out, { inFence, fenceLang });

    if (inFence && !out.trimStart().startsWith("```")) {
      const openFence = fenceLang ? `\`\`\`${fenceLang}\n` : "```\n";
      out = openFence + out;
    }

    if (endBeforeRepair.inFence && i < rawChunks.length - 1) {
      out = out.endsWith("\n") ? out + "```" : out + "\n```";
      inFence = true;
      fenceLang = fenceLang || initialFenceState.fenceLang;
    } else {
      inFence = endBeforeRepair.inFence;
      fenceLang = endBeforeRepair.fenceLang;
    }

    result.push(out);
  }

  return result;
}

function stripChunkDecorations(chunk: string): string {
  let body = chunk;
  const openMatch = body.match(/^(`{3,}|~{3,})([^\n]*)\n/);
  if (openMatch) {
    body = body.slice(openMatch[0].length);
  }
  body = body.replace(/\n(`{3,}|~{3,})\s*$/, "");
  return body;
}

/** Map raw chunk suffix back to an offset in the original unsent string. */
function originalOffsetForKeepingLastChunk(unsent: string, chunks: string[]): number {
  if (chunks.length <= 1) return 0;
  const body = stripChunkDecorations(chunks[chunks.length - 1]!);
  if (!body) return 0;
  const idx = unsent.length - body.length;
  if (idx >= 0 && unsent.slice(idx) === body) return idx;
  const found = unsent.lastIndexOf(body);
  return found >= 0 ? found : 0;
}

export function createStreamingOutputSession(opts: StreamingOutputSessionOptions): StreamingOutputSession {
  const {
    sender,
    sessionKey = "",
    disableBlockStreaming = false,
    minChars = 3000,
    maxChars = 4000,
    minSendIntervalMs = DEFAULT_MIN_SEND_INTERVAL_MS,
    onComplete,
  } = opts;

  const chunkText = opts.chunkText ?? defaultChunkText;

  function chunkForDelivery(
    text: string,
    max: number,
    fenceState: FenceState,
  ): { raw: string[]; delivery: string[] } {
    const raw = chunkText(text, max);
    const delivery = repairDeliveryChunks(raw, fenceState);
    return { raw, delivery };
  }

  async function sendUnsent(
    unsent: string,
    fullText: string,
    baseSentIndex: number,
    mode: "stream" | "force" | "finalize",
  ): Promise<void> {
    const fenceState = mdFence.computeState(fullText.slice(0, baseSentIndex));

    if (mode === "stream") {
      const { raw, delivery } = chunkForDelivery(unsent, maxChars, fenceState);
      if (delivery.length <= 1) return;
      const toSend = delivery.slice(0, -1);
      sentIndex = baseSentIndex + originalOffsetForKeepingLastChunk(unsent, raw);
      await sendChunks(toSend);
      return;
    }

    const { delivery } = chunkForDelivery(unsent, maxChars, fenceState);

    if (mode === "force") {
      sentIndex = fullText.length;
      await sendChunks(delivery);
      return;
    }

    await sendChunks(delivery);
    sentIndex = fullText.length;
  }

  async function sendChunks(chunks: string[]): Promise<void> {
    for (let i = 0; i < chunks.length; i++) {
      if (aborted) return;
      await sendChunk(chunks[i]!);
    }
  }

  let aborted = false;
  let cumulativeText = "";
  let sentIndex = 0;
  let hasSentContent = false;
  let receivedPartial = false;
  let lastSendCompletedAt = 0;

  const thinkingRepair = createRepairThinkingBoundary();

  /** Serializes every sendText across sendChunks / drain / finalize with min interval. */
  let sendTextChain: Promise<void> = Promise.resolve();

  let sendChain: Promise<void> = Promise.resolve();

  function enqueueTextSend(text: string): Promise<void> {
    sendTextChain = sendTextChain.then(async () => {
      if (aborted) return;
      if (!text.trim()) return;

      if (minSendIntervalMs > 0 && lastSendCompletedAt > 0) {
        const waitMs = minSendIntervalMs - (Date.now() - lastSendCompletedAt);
        if (waitMs > 0) await sleep(waitMs);
      }
      if (aborted) return;

      const result = await sender.sendText(text);
      lastSendCompletedAt = Date.now();
      if (!result.ok) {
        log.error(`[${sessionKey}] sendText 失败: ${result.error}`);
      } else {
        hasSentContent = true;
      }
    });
    return sendTextChain;
  }

  function enqueue(fn: () => Promise<void>): Promise<void> {
    sendChain = sendChain.then(async () => {
      if (aborted) return;
      await fn();
    });
    return sendChain;
  }

  async function sendChunk(text: string): Promise<void> {
    await enqueueTextSend(text);
  }

  async function drainUnsent(force: boolean): Promise<void> {
    const unsent = cumulativeText.slice(sentIndex);

    if (!unsent.trim()) return;

    if (!force) {
      if (unsent.length < minChars) return;
      if (!mdSplit.isSafe(unsent, maxChars)) return;
    }

    await sendUnsent(unsent, cumulativeText, sentIndex, force ? "force" : "stream");
  }

  return {
    async update(text: string): Promise<void> {
      if (aborted) return;
      receivedPartial = true;

      cumulativeText = thinkingRepair.applyPartialReply(text);

      if (disableBlockStreaming) return;

      return enqueue(() => drainUnsent(false));
    },

    markReasoningBoundary(): void {
      const { cumulativeText: repaired, repairedBySandwich } =
        thinkingRepair.markReasoningEnd(cumulativeText);
      cumulativeText = repaired;

      if (repairedBySandwich && !disableBlockStreaming) {
        void enqueue(() => drainUnsent(false));
      }
    },

    flushNow(): Promise<void> {
      if (disableBlockStreaming || aborted) return Promise.resolve();
      return enqueue(() => drainUnsent(true));
    },

    async finalize(): Promise<boolean> {
      if (aborted) return hasSentContent;
      await sendChain;
      if (aborted) return hasSentContent;

      const remaining = cumulativeText.slice(sentIndex);
      if (remaining.trim()) {
        await sendUnsent(remaining, cumulativeText, sentIndex, "finalize");
      }

      await sendTextChain;
      onComplete?.();
      return hasSentContent;
    },

    abort(): void {
      aborted = true;
      cumulativeText = "";
      onComplete?.();
    },

    hasReceivedPartial(): boolean {
      return receivedPartial;
    },
  };
}
