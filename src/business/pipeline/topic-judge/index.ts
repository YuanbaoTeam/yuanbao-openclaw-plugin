/**
 * Topic-scoped self-judge (L2 in the reply-decision pipeline).
 *
 * Given a message and a topic's soul.md, decide whether the bot should reply
 * even though it wasn't explicitly @-mentioned.
 *
 * Two-phase decision:
 *   Phase 1 — Rule matching: fast-path keyword/prefix/regex rules from the
 *             `## Reply Rules` section. If any rule hits → reply immediately.
 *   Phase 2 — LLM judge: when rules miss but `## Auto Reply` is configured,
 *             invoke a caller-supplied `judgeInvoker` (which runs the prompt
 *             through OpenClaw's own agent pipeline in an isolated session)
 *             to judge relevance based on persona, strategy, and recent
 *             conversation history.
 *
 * Safe default: when no rules are configured AND `judgeInvoker` is not
 * provided, return `shouldReply=false` to avoid the bot spamming every message.
 *
 * Dependency inversion: this module accepts a plain `JudgeInvoker` function —
 * it deliberately does NOT depend on the OpenClaw SDK, so tests can inject a
 * stub without mocking `fetch` or the SDK surface.
 */

import type { ModuleLog } from "../../../logger.js";
import { buildJudgePrompt } from "./prompt-builder.js";
import type { JudgeInvoker } from "./llm-judge.js";

export interface TopicJudgeInput {
  topicId: string;
  rawBody: string;
  senderNickname?: string;
  /** Full soul.md content. Empty string = no soul configured. */
  soul: string;
  /** Recent topic-scoped history tail for judge context. */
  historyTail?: string[];
  /**
   * Optional judge invoker. When provided (and `## Auto Reply` exists in
   * soul), Phase 2 is enabled. Callers assemble this via
   * `createOpenclawJudgeInvoker` in llm-judge.ts.
   */
  judgeInvoker?: JudgeInvoker;
  log?: ModuleLog;
}

export interface TopicJudgeResult {
  shouldReply: boolean;
  reason: string;
}

interface ReplyRules {
  keywords: string[];
  prefixes: string[];
  regexes: RegExp[];
}

const RULES_HEADING = /^##\s+reply\s+rules\s*$/i;
/** Any other level-2 heading terminates the rules block. */
const OTHER_HEADING = /^##\s+/;

/**
 * Extract the raw text of the `## Reply Rules` section from a soul.md.
 *
 * Returns everything after the heading up to (but not including) the next
 * `## …` heading or EOF. Empty string if no such section exists.
 */
function extractRulesBlock(soul: string): string {
  if (!soul) return "";
  const lines = soul.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (RULES_HEADING.test(lines[i])) {
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
  return lines.slice(start, end).join("\n");
}

/**
 * Parse a `- kind: a, b, c` line into a list of trimmed non-empty items.
 * Handles both English and Chinese commas.
 */
function parseListLine(line: string, kind: string): string[] | null {
  const re = new RegExp(`^\\s*[-*]\\s*${kind}\\s*:\\s*(.+)$`, "i");
  const m = re.exec(line);
  if (!m) return null;
  return m[1]
    .split(/[,，]/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** Parse `- regex: /pattern/flags` or `- regex: pattern` (raw). */
function parseRegexLine(line: string, log?: ModuleLog): RegExp[] {
  const items = parseListLine(line, "regex");
  if (!items) return [];
  const out: RegExp[] = [];
  for (const raw of items) {
    try {
      // Support `/pattern/flags` form.
      const slashMatch = /^\/(.+)\/([gimsuy]*)$/.exec(raw);
      if (slashMatch) {
        out.push(new RegExp(slashMatch[1], slashMatch[2]));
      } else {
        out.push(new RegExp(raw));
      }
    } catch (err) {
      log?.warn?.("[topic-judge] invalid regex in soul.md, skipping", {
        pattern: raw,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

/** Parse a rules block into a normalized {keywords, prefixes, regexes} bag. */
function parseRules(block: string, log?: ModuleLog): ReplyRules {
  const rules: ReplyRules = { keywords: [], prefixes: [], regexes: [] };
  if (!block) return rules;
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const kw = parseListLine(line, "keyword");
    if (kw) {
      rules.keywords.push(...kw);
      continue;
    }
    const px = parseListLine(line, "prefix");
    if (px) {
      rules.prefixes.push(...px);
      continue;
    }
    if (/^\s*[-*]\s*regex\s*:/i.test(line)) {
      rules.regexes.push(...parseRegexLine(line, log));
    }
  }
  return rules;
}

function hasAnyRule(r: ReplyRules): boolean {
  return r.keywords.length > 0 || r.prefixes.length > 0 || r.regexes.length > 0;
}

/**
 * Match `rawBody` against the rules bag. Returns the first hit's description,
 * or `null` when nothing matches. Case-insensitive for keyword/prefix.
 */
function matchRules(rawBody: string, r: ReplyRules): string | null {
  const body = rawBody ?? "";
  const bodyLower = body.toLowerCase();
  const bodyTrimmedLower = body.trimStart().toLowerCase();

  for (const kw of r.keywords) {
    if (kw && bodyLower.includes(kw.toLowerCase())) {
      return `keyword:${kw}`;
    }
  }
  for (const px of r.prefixes) {
    if (px && bodyTrimmedLower.startsWith(px.toLowerCase())) {
      return `prefix:${px}`;
    }
  }
  for (const re of r.regexes) {
    if (re.test(body)) {
      return `regex:${re.source}`;
    }
  }
  return null;
}

/**
 * Decide whether the bot should reply in a topic based on its soul.md.
 *
 * Phase 1: pure rule matching against a `## Reply Rules` block (fast path).
 * Phase 2: when rules miss, delegate to the caller-provided `judgeInvoker` if
 *          `## Auto Reply` is configured.
 */
export async function shouldBotReplyInTopic(
  input: TopicJudgeInput,
): Promise<TopicJudgeResult> {
  const { soul, rawBody, senderNickname, historyTail, judgeInvoker, log } = input;

  if (!soul || !soul.trim()) {
    return { shouldReply: false, reason: "no soul configured" };
  }

  // ─── Phase 1: Rule matching (fast path) ───────────────────────────────
  const block = extractRulesBlock(soul);
  if (block.trim()) {
    const rules = parseRules(block, log);
    if (hasAnyRule(rules)) {
      const hit = matchRules(rawBody, rules);
      if (hit) {
        return { shouldReply: true, reason: `matched rule: ${hit}` };
      }
    }
  }

  // ─── Phase 2: LLM judge (fallback) ────────────────────────────────────
  if (!judgeInvoker) {
    return { shouldReply: false, reason: "no rule matched" };
  }

  const prompt = buildJudgePrompt({
    soul,
    rawBody,
    senderNickname,
    historyTail,
  });

  if (!prompt.hasAutoReplyConfig) {
    return { shouldReply: false, reason: "no auto-reply config" };
  }

  log?.info?.("[topic-judge] invoking LLM judge", {
    topicId: input.topicId,
    historyLen: historyTail?.length ?? 0,
  });

  const result = await judgeInvoker({ prompt: prompt.prompt, log });

  return {
    shouldReply: result.shouldReply,
    reason: result.shouldReply
      ? `llm-judge: ${result.reason}`
      : `llm-judge-skip: ${result.reason}`,
  };
}
