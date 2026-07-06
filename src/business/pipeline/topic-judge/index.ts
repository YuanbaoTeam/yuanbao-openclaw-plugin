/**
 * Topic-scoped self-judge (L2 in the reply-decision pipeline).
 *
 * Given a message and a topic's soul.md, decide whether the bot should reply
 * even though it wasn't explicitly @-mentioned.
 *
 * **MVP: rule-based only** — parses a `## Reply Rules` markdown section and
 * matches against `keyword` / `prefix` / `regex` lines. A future phase may
 * swap in a lightweight LLM judge; the async signature is preserved to keep
 * that swap non-breaking.
 *
 * Safe default: when no rules are configured, return `shouldReply=false` to
 * avoid the bot spamming every topic message.
 */

import type { ModuleLog } from "../../../logger.js";

export interface TopicJudgeInput {
  topicId: string;
  rawBody: string;
  senderNickname?: string;
  /** Full soul.md content. Empty string = no soul configured. */
  soul: string;
  /** Recent topic-scoped history tail — reserved for phase 2 (LLM judge). */
  historyTail?: string[];
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
 * Phase 1 (MVP): pure rule matching against a `## Reply Rules` block.
 * Phase 2 (TODO): fall back to a lightweight LLM judge when no rule hits
 * but the soul has other guidance — kept as an async signature for that.
 */
export async function shouldBotReplyInTopic(
  input: TopicJudgeInput,
): Promise<TopicJudgeResult> {
  const { soul, rawBody, log } = input;

  if (!soul || !soul.trim()) {
    return { shouldReply: false, reason: "no soul rules" };
  }

  const block = extractRulesBlock(soul);
  if (!block.trim()) {
    return { shouldReply: false, reason: "no soul rules" };
  }

  const rules = parseRules(block, log);
  if (!hasAnyRule(rules)) {
    return { shouldReply: false, reason: "no soul rules" };
  }

  const hit = matchRules(rawBody, rules);
  if (hit) {
    return { shouldReply: true, reason: `matched rule: ${hit}` };
  }

  return { shouldReply: false, reason: "no rule matched" };
}
