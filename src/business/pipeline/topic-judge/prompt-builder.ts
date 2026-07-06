/**
 * Prompt builder for topic self-judge (Phase 2).
 *
 * Responsibilities:
 * 1. Extract the `## Auto Reply` section from a topic's soul.md — this section
 *    describes the bot's participation strategy (when to chime in, what topics
 *    interest it, personality cues for judging relevance).
 * 2. Assemble a single combined prompt (persona + strategy + history + current
 *    message + output protocol) suitable for a single-turn agent call that
 *    returns a YES/NO JSON verdict.
 * 3. Enforce a max history window and approximate token budget so the judge
 *    prompt stays lightweight and fast.
 *
 * Note: the previous incarnation returned separate `systemPrompt` and
 * `userPrompt` for a raw Chat Completion HTTP call. The current design routes
 * judge calls through OpenClaw's agent pipeline, which takes a single message
 * body — hence one merged `prompt` field.
 */

// ─── Constants ──────────────────────────────────────────────────────────────

/** Maximum number of history entries to include in the prompt. */
const DEFAULT_MAX_HISTORY_ENTRIES = 10;

/**
 * Approximate character budget for the history portion of the prompt.
 * 1 CJK char ≈ 1.5 tokens; 1200 chars ≈ ~800 tokens — keeps the full prompt
 * well under 2k tokens even with a generous persona block.
 */
const MAX_HISTORY_CHARS = 1200;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BuildPromptInput {
  /** Full soul.md content. */
  soul: string;
  /** Current inbound message text. */
  rawBody: string;
  /** Display name of the message sender. */
  senderNickname?: string;
  /** Recent topic-scoped chat history entries (newest last). */
  historyTail?: string[];
  /** Override max history entries (default 10). */
  maxHistoryEntries?: number;
}

export interface BuiltPrompt {
  /** Single combined prompt body for the agent. */
  prompt: string;
  /** Whether an `## Auto Reply` section was found in soul.md. */
  hasAutoReplyConfig: boolean;
}

// ─── Internal helpers ───────────────────────────────────────────────────────

const AUTO_REPLY_HEADING = /^##\s+auto\s+reply\s*$/i;
/** Any other level-2 heading terminates the block. */
const OTHER_HEADING = /^##\s+/;

/**
 * Extract the raw text of the `## Auto Reply` section from a soul.md.
 *
 * Returns everything after the heading up to (but not including) the next
 * `## …` heading or EOF. Empty string if no such section exists.
 */
export function extractAutoReplyBlock(soul: string): string {
  if (!soul) return "";
  const lines = soul.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (AUTO_REPLY_HEADING.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start; i < lines.length; i++) {
    if (OTHER_HEADING.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n").trim();
}

/**
 * Extract a brief persona description from soul.md for the prompt.
 *
 * Heuristic: take everything before the first `## ` heading as the persona
 * preamble. If the soul starts with a `# Title` (level 1), skip that line.
 * Capped at 400 chars to keep the prompt lean.
 */
function extractPersona(soul: string): string {
  if (!soul) return "";
  const lines = soul.split(/\r?\n/);
  const result: string[] = [];
  let started = false;
  for (const line of lines) {
    // Skip the top-level title
    if (!started && /^#\s+/.test(line)) {
      started = true;
      continue;
    }
    started = true;
    // Stop at the first ## heading
    if (OTHER_HEADING.test(line)) break;
    result.push(line);
  }
  const text = result.join("\n").trim();
  return text.length > 400 ? text.slice(0, 400) + "…" : text;
}

/**
 * Trim history entries to fit within both the entry count and character budget.
 * Keeps the most recent entries (end of array = newest).
 */
function trimHistory(
  entries: string[],
  maxEntries: number,
  maxChars: number,
): string[] {
  // Take the tail (most recent)
  const tail = entries.slice(-maxEntries);
  // Now trim from the front to fit char budget
  let totalChars = 0;
  const result: string[] = [];
  for (let i = tail.length - 1; i >= 0; i--) {
    const entry = tail[i];
    if (totalChars + entry.length > maxChars && result.length > 0) break;
    totalChars += entry.length;
    result.unshift(entry);
  }
  return result;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the combined prompt for the topic-judge agent call.
 *
 * Returns `hasAutoReplyConfig: false` when no `## Auto Reply` section exists
 * in the soul — caller should skip the judge entirely in that case.
 */
export function buildJudgePrompt(input: BuildPromptInput): BuiltPrompt {
  const {
    soul,
    rawBody,
    senderNickname,
    historyTail,
    maxHistoryEntries = DEFAULT_MAX_HISTORY_ENTRIES,
  } = input;

  const autoReplyBlock = extractAutoReplyBlock(soul);

  if (!autoReplyBlock) {
    return { prompt: "", hasAutoReplyConfig: false };
  }

  // ── Assemble sections ──
  const persona = extractPersona(soul);

  const historyFormatted = historyTail && historyTail.length > 0
    ? trimHistory(historyTail, maxHistoryEntries, MAX_HISTORY_CHARS)
    : [];

  const historySection = historyFormatted.length > 0
    ? `## 近期对话历史\n${historyFormatted.join("\n")}`
    : "";

  const sender = senderNickname || "用户";

  // Single merged body — the agent side treats it as one user message.
  // Kept structurally similar to the old system/user split so operators reading
  // logs can still find the persona / strategy / history / current sections.
  const prompt = [
    "你是一个群聊机器人的回复决策模块。",
    "你的任务是判断机器人是否应该主动参与当前对话（即使没有被 @mention）。",
    "",
    persona ? `## 机器人人设\n${persona}` : "",
    "",
    `## 自动参与策略\n${autoReplyBlock}`,
    "",
    historySection,
    historySection ? "" : null,
    `## 当前消息`,
    `${sender}: ${rawBody}`,
    "",
    "## 输出格式",
    '仅输出一行 JSON：{"shouldReply": true 或 false, "reason": "简短理由（20字以内）"}',
    "不要输出任何其他内容。",
  ]
    .filter(line => line !== null && line !== undefined)
    .filter(Boolean)
    .join("\n");

  return { prompt, hasAutoReplyConfig: true };
}
