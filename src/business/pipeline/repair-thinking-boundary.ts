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

  // For a single \n: preserve if the next line starts with a markdown block element.
  // Removing it would produce invalid/malformed markdown (e.g. "---## Heading").
  if (!suffix.startsWith("\n\n")) {
    const afterNewline = suffix.slice(1);
    if (/^#{1,6}\s|^\||^```|^>\s|^\*\s|^- |^\d+[.)]\s/.test(afterNewline)) {
      return incoming;
    }
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

// ── Sandwich repair ─────────────────────────────────────────────────────────

export interface SandwichRepairResult {
  /** Full repaired text */
  repaired: string;
  /** The broken fragment inside the delta (may be empty if nothing changed) */
  brokenFragment: string;
  /** The repaired replacement for brokenFragment */
  repairedFragment: string;
}

/**
 * Count single newlines in `text` — newlines that are NOT part of a \n\n pair.
 */
function findSingleNewlines(text: string): number[] {
  const positions: number[] = [];
  for (let i = 0; i < text.length; i++) {
    if (
      text[i] === "\n"
      && text[i + 1] !== "\n"
      && (i === 0 || text[i - 1] !== "\n")
    ) {
      positions.push(i);
    }
  }
  return positions;
}

/**
 * Detect whether `text` looks like a (possibly broken) markdown table.
 * We consider it a table if it contains `|` AND has a separator pattern (---)
 * OR more than one `|`-prefixed line.
 */
function looksLikeTable(text: string): boolean {
  if (!text.includes("|")) return false;
  if (/---/.test(text)) return true;
  const pipeLines = text.split("\n").filter(l => l.trim().startsWith("|"));
  return pipeLines.length >= 2;
}

/**
 * Merge broken table rows back into complete rows.
 *
 * A row is "broken" when a thinking-boundary \n was inserted mid-row.
 * Two conditions identify a merge target:
 *   1. Previous line starts with | but does NOT end with | (incomplete row)
 *   2. Current line does not start with | but ends with |, AND prev line is also incomplete
 */
function repairBrokenTableRows(text: string): string {
  const lines = text.split("\n");
  const merged: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const prevRaw = merged.at(-1) ?? "";
    const prevTrimmed = prevRaw.trim();

    const prevStartsPipe = prevTrimmed.startsWith("|");
    const prevEndsPipe = prevTrimmed.endsWith("|");
    const curStartsPipe = trimmed.startsWith("|");
    const curEndsPipe = trimmed.endsWith("|");

    if (merged.length > 0 && prevStartsPipe && !prevEndsPipe) {
      // Previous line is an incomplete table row — append current line to it
      merged[merged.length - 1] = prevRaw + line;
    } else if (merged.length > 0 && !curStartsPipe && curEndsPipe && prevStartsPipe) {
      // Current line is a table row fragment (ends with | but doesn't start with |).
      // This handles broken separators: "|------|------|" + "\n" + "------|"
      // The prev.endsWith("|") check is intentionally removed: "|------|------|"
      // looks complete but may be a truncated multi-column separator.
      merged[merged.length - 1] = prevRaw + line;
    } else {
      merged.push(line);
    }
  }

  return merged.join("\n");
}

/**
 * Sandwich repair: called when we confirm the pattern
 *   onReasoningEnd(1st) → onPartialReply(text) → onReasoningEnd(2nd)
 *
 * @param snapshot - cumulativeText at the time of the 1st onReasoningEnd (may be empty)
 * @param text     - cumulativeText after the onPartialReply (may contain spurious \n)
 * @returns SandwichRepairResult with full repaired text and before/after fragment pair
 */
export function repairSandwichText(snapshot: string, text: string): SandwichRepairResult {
  const noChange: SandwichRepairResult = { repaired: text, brokenFragment: "", repairedFragment: "" };

  // Determine the delta — the portion of text that is new since the snapshot
  let prefix: string;
  let delta: string;
  if (snapshot && text.startsWith(snapshot)) {
    prefix = snapshot;
    delta = text.slice(snapshot.length);
  } else {
    prefix = "";
    delta = text;
  }

  if (!delta) return noChange;

  const singleNLPositions = findSingleNewlines(delta);

  if (singleNLPositions.length === 0) {
    return noChange;
  }

  let repairedDelta: string;

  if (singleNLPositions.length === 1) {
    // Simple case: one spurious \n — remove it, UNLESS it separates two complete
    // table rows (| ... | \n | ... |), which is intentional table formatting.
    const pos = singleNLPositions[0]!;
    const lineBeforeStart = delta.lastIndexOf("\n", pos - 1) + 1;
    const lineBefore = delta.slice(lineBeforeStart, pos).trim();
    const lineAfter = (delta.slice(pos + 1).split("\n")[0] ?? "").trim();
    const isCompleteTableRow = (line: string) => line.startsWith("|") && line.endsWith("|");
    if (isCompleteTableRow(lineBefore) && isCompleteTableRow(lineAfter)) {
      return noChange;
    }
    repairedDelta = delta.slice(0, pos) + delta.slice(pos + 1);
  } else {
    // Multiple single newlines: try content-type-aware repair
    if (looksLikeTable(delta)) {
      repairedDelta = repairBrokenTableRows(delta);
    } else {
      // No handler yet for this content type — leave unchanged
      return noChange;
    }
  }

  if (repairedDelta === delta) return noChange;

  return {
    repaired: prefix + repairedDelta,
    brokenFragment: delta,
    repairedFragment: repairedDelta,
  };
}
