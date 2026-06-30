/**
 * Repair spurious newlines inserted by the SDK at thinking/reasoning block boundaries.
 *
 * When a thinking block ends and visible text resumes, the SDK may insert a spurious
 * `\n` at the join point in onPartialReply cumulative text. This module detects and
 * removes those newlines while preserving intentional ones.
 */

const CLAUSE_COMMA_RE = /，$/;
const CLAUSE_OR_SENTENCE_END_RE = /[.!?。！？…，、；：]$/;

/** join 后的单 `\n` 若紧接 `---` 分割线或 `- ` 列表项，应保留 */
function shouldPreserveJoinNewline(afterNewline: string): boolean {
  const line = afterNewline.trimStart();
  if (/^(?:-{3,}|-\s)/.test(line)) {
    return true;
  }
  return /^#{1,6}\s|^\||^```|^>\s|^\*\s|^\d+[.)]\s/.test(line);
}

export interface SandwichRepairResult {
  repaired: string;
  brokenFragment: string;
  repairedFragment: string;
}

export interface MarkReasoningEndResult {
  cumulativeText: string;
  repairedBySandwich: boolean;
}

export interface RepairThinkingBoundary {
  /** onPartialReply: prefix join repair + replay last sandwich fix */
  applyPartialReply(incoming: string): string;
  /** onReasoningEnd: record boundary prefix; 2nd call runs sandwich repair */
  markReasoningEnd(cumulativeText: string): MarkReasoningEndResult;
  /** Reset boundary state for a new assistant message segment (e.g. after tool call) */
  resetSegment(): void;
}

/**
 * Repair the join between `prefix` (cumulative text at reasoning end)
 * and `incoming` (a later cumulative partial that extends the prefix).
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

  if (CLAUSE_COMMA_RE.test(prefix) && suffix.startsWith("\n") && !suffix.startsWith("\n\n")) {
    return incoming;
  }

  if (suffix.startsWith("\n\n") && CLAUSE_OR_SENTENCE_END_RE.test(prefix)) {
    return incoming;
  }

  if (!suffix.startsWith("\n\n")) {
    if (shouldPreserveJoinNewline(suffix.slice(1))) {
      return incoming;
    }
  }

  if (suffix.startsWith("\n\n")) {
    return prefix + suffix.replace(/^\n+/, "");
  }

  return prefix + suffix.replace(/^\n(?!\n)/, "");
}

export function repairAllThinkingBoundaryJoins(prefixes: readonly string[], incoming: string): string {
  let text = incoming;
  for (const prefix of prefixes) {
    if (text.startsWith(prefix) && text.length > prefix.length) {
      text = repairThinkingBoundaryJoin(prefix, text);
    }
  }
  return text;
}

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

function looksLikeTable(text: string): boolean {
  if (!text.includes("|")) return false;
  if (/---/.test(text)) return true;
  const pipeLines = text.split("\n").filter(l => l.trim().startsWith("|"));
  return pipeLines.length >= 2;
}

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
      merged[merged.length - 1] = prevRaw + line;
    } else if (merged.length > 0 && !curStartsPipe && curEndsPipe && prevStartsPipe) {
      merged[merged.length - 1] = prevRaw + line;
    } else {
      merged.push(line);
    }
  }

  return merged.join("\n");
}

export function repairSandwichText(snapshot: string, text: string): SandwichRepairResult {
  const noChange: SandwichRepairResult = { repaired: text, brokenFragment: "", repairedFragment: "" };

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
    const pos = singleNLPositions[0]!;
    const lineBeforeStart = delta.lastIndexOf("\n", pos - 1) + 1;
    const lineBefore = delta.slice(lineBeforeStart, pos).trim();
    const lineAfter = (delta.slice(pos + 1).split("\n")[0] ?? "").trim();
    const isCompleteTableRow = (line: string) => line.startsWith("|") && line.endsWith("|");
    if (isCompleteTableRow(lineBefore) && isCompleteTableRow(lineAfter)) {
      return noChange;
    }
    if (shouldPreserveJoinNewline(delta.slice(pos + 1))) {
      return noChange;
    }
    repairedDelta = delta.slice(0, pos) + delta.slice(pos + 1);
  } else if (looksLikeTable(delta)) {
    repairedDelta = repairBrokenTableRows(delta);
  } else {
    return noChange;
  }

  if (repairedDelta === delta) return noChange;

  return {
    repaired: prefix + repairedDelta,
    brokenFragment: delta,
    repairedFragment: repairedDelta,
  };
}

export function createRepairThinkingBoundary(): RepairThinkingBoundary {
  const reasoningBoundaryPrefixes: string[] = [];
  let consecutiveReasoningEndCount = 0;
  let textAtFirstReasoningEnd = "";
  let sandwichRepair: SandwichRepairResult | null = null;

  return {
    applyPartialReply(incoming: string): string {
      let repaired = repairAllThinkingBoundaryJoins(reasoningBoundaryPrefixes, incoming);
      if (sandwichRepair?.brokenFragment) {
        repaired = repaired.replace(sandwichRepair.brokenFragment, sandwichRepair.repairedFragment);
      }
      return repaired;
    },

    markReasoningEnd(cumulativeText: string): MarkReasoningEndResult {
      consecutiveReasoningEndCount++;

      if (consecutiveReasoningEndCount === 1) {
        textAtFirstReasoningEnd = cumulativeText;
        if (cumulativeText) {
          reasoningBoundaryPrefixes.push(cumulativeText);
        }
        return { cumulativeText, repairedBySandwich: false };
      }

      if (consecutiveReasoningEndCount === 2) {
        let resultText = cumulativeText;
        let repairedBySandwich = false;

        if (cumulativeText) {
          const result = repairSandwichText(textAtFirstReasoningEnd, cumulativeText);

          if (result.brokenFragment) {
            resultText = result.repaired;
            sandwichRepair = result;
            repairedBySandwich = true;
          }

          if (resultText && !resultText.endsWith("\n")) {
            reasoningBoundaryPrefixes.push(resultText);
          }
        }

        consecutiveReasoningEndCount = 0;
        textAtFirstReasoningEnd = "";

        return { cumulativeText: resultText, repairedBySandwich };
      }

      return { cumulativeText, repairedBySandwich: false };
    },

    resetSegment(): void {
      reasoningBoundaryPrefixes.length = 0;
      consecutiveReasoningEndCount = 0;
      textAtFirstReasoningEnd = "";
      sandwichRepair = null;
    },
  };
}
