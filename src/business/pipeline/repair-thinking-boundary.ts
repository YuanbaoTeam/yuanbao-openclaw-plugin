/**
 * Repair spurious newlines inserted by the SDK at thinking/reasoning block boundaries.
 *
 * When a <think> block ends and visible text resumes, the SDK inserts a '\n' at the
 * join point in onPartialReply's cumulative text. This module detects and removes
 * those spurious newlines while preserving intentional ones.
 */

const CLAUSE_COMMA_RE = /，$/;
const CLAUSE_OR_SENTENCE_END_RE = /[.!?。！？…，、；：]$/;

/**
 * Repair the join between `prefix` (cumulative text at the moment reasoning ended)
 * and `incoming` (a later cumulative partial reply that extends the prefix).
 *
 * Rules:
 * - verse line breaks after Chinese comma (，\n) are preserved
 * - paragraph breaks (\n\n) after any clause/sentence-end punctuation are preserved
 * - all other single \n inserted right after the prefix are removed
 */
export function repairThinkingBoundaryJoin(prefix: string, incoming: string): string {
  if (!prefix || !incoming.startsWith(prefix)) {
    return incoming;
  }
  if (prefix.endsWith("\n")) {
    return incoming;
  }

  const suffix = incoming.slice(prefix.length);
  if (!suffix.startsWith("\n")) {
    return incoming;
  }

  // Verse line break after Chinese comma: preserve
  if (CLAUSE_COMMA_RE.test(prefix) && suffix.startsWith("\n") && !suffix.startsWith("\n\n")) {
    return incoming;
  }

  // Paragraph break after clause/sentence ending: preserve
  if (suffix.startsWith("\n\n") && CLAUSE_OR_SENTENCE_END_RE.test(prefix)) {
    return incoming;
  }

  if (suffix.startsWith("\n\n")) {
    return prefix + suffix.replace(/^\n+/, "");
  }

  return prefix + suffix.replace(/^\n(?!\n)/, "");
}

/**
 * Apply all recorded thinking-boundary repairs in order (oldest prefix first).
 * Called on every onPartialReply update so later partial text doesn't re-introduce
 * a spurious newline after it was already repaired.
 */
export function repairAllThinkingBoundaryJoins(prefixes: readonly string[], incoming: string): string {
  let text = incoming;
  for (const prefix of prefixes) {
    if (text.startsWith(prefix) && text.length > prefix.length) {
      text = repairThinkingBoundaryJoin(prefix, text);
    }
  }
  return text;
}

/**
 * Aggressive newline repair for sandwich scenarios where no prefix snapshot exists.
 *
 * Since we KNOW the text was produced during a thinking-interleaved generation,
 * any single \n (not \n\n) is likely a </think> boundary artifact UNLESS it is
 * one of these intentional patterns:
 *   - Paragraph break: \n\n (preserved by the negative lookahead)
 *   - Markdown block start: the line after \n starts with -, *, #, |, >, digit+.
 *   - Verse line after Chinese comma: ，\n
 */
export function repairThinkingBoundaryNewlines(text: string): string {
  const MD_NON_TABLE_RE = /^[\s]*[-*#>]/;
  const MD_ORDERED_RE = /^[\s]*\d+[.)]/;

  function isCompleteTableRow(line: string): boolean {
    const trimmed = line.trim();
    return trimmed.startsWith("|") && trimmed.endsWith("|");
  }

  function isMarkdownLine(line: string): boolean {
    if (line.trim().startsWith("|")) return isCompleteTableRow(line);
    return MD_NON_TABLE_RE.test(line) || MD_ORDERED_RE.test(line);
  }

  return text.replace(/\n/g, (match, offset) => {
    if (text[offset + 1] === "\n") return match;
    if (text[offset - 1] === "\n") return match;

    if (text[offset - 1] === "，") return match;

    const lineAfter = text.slice(offset + 1).split("\n")[0] ?? "";
    if (isMarkdownLine(lineAfter)) return match;

    const lineBeforeStart = text.lastIndexOf("\n", offset - 1) + 1;
    const lineBefore = text.slice(lineBeforeStart, offset);
    if (isMarkdownLine(lineBefore)) return match;

    return "";
  });
}
