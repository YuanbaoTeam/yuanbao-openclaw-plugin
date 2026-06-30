/**
 * Outbound text sanitization and contract-tested atomic chunk helpers.
 *
 * Production: mdTable.sanitize + mdMath.normalize (prepareOutboundContent).
 * Streaming: mdSplit.isSafe (fence / math / table gates).
 * Contract: mdAtomic.chunkAware (POLICY-011).
 */

// ── Code fences ───────────────────────────────────────────────────────────────

export type FenceState = { inFence: boolean; fenceLang: string };

function computeFenceStateAt(
  text: string,
  initial: FenceState = { inFence: false, fenceLang: "" },
): FenceState {
  let inFence = initial.inFence;
  let fenceLang = initial.fenceLang;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      if (inFence) {
        inFence = false;
        fenceLang = "";
      } else {
        inFence = true;
        fenceLang = line.slice(3).trim();
      }
    }
  }
  return { inFence, fenceLang };
}

function hasUnclosedFence(text: string): boolean {
  return computeFenceStateAt(text).inFence;
}

// ── Math blocks ─────────────────────────────────────────────────────────────

/** True when a $$ display-math block is still open (ignores $$ inside ``` fences). */
function hasUnclosedMathBlock(text: string): boolean {
  let inFence = false;
  let mathOpen = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    let idx = 0;
    while (idx < line.length - 1) {
      if (line[idx] === "$" && line[idx + 1] === "$") {
        mathOpen = !mathOpen;
        idx += 2;
      } else {
        idx++;
      }
    }
  }
  return mathOpen;
}

function normalizeMathBlocks(text: string): string {
  if (!text.includes("$$")) return text;

  const parts: string[] = [];
  let inFence = false;
  let mathOpen = false;
  let segStart = 0;

  for (let i = 0; i < text.length; i++) {
    if ((i === 0 || text[i - 1] === "\n") && text.startsWith("```", i)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (text[i] === "$" && i + 1 < text.length && text[i + 1] === "$") {
      if (!mathOpen) {
        mathOpen = true;
        parts.push(text.slice(segStart, i + 2));
        segStart = i + 2;
        i++;
      } else {
        const mathContent = text.slice(segStart, i);
        parts.push(mathContent.replace(/\n\n+/g, "\n"));
        parts.push("$$");
        segStart = i + 2;
        mathOpen = false;
        i++;
      }
    }
  }

  if (segStart < text.length) {
    const remaining = text.slice(segStart);
    parts.push(mathOpen ? remaining.replace(/\n\n+/g, "\n") : remaining);
  }

  return parts.join("");
}

// ── Pipe tables ─────────────────────────────────────────────────────────────

interface PipeTableRegion {
  startLine: number;
  endLine: number;
}

function findPipeTableRegions(lines: string[]): PipeTableRegion[] {
  const regions: PipeTableRegion[] = [];
  let groupStart = -1;
  let lastPipeLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hasPipe = line.includes("|");
    const isBlank = line.trim() === "";

    if (hasPipe) {
      if (groupStart < 0) groupStart = i;
      lastPipeLine = i;
    } else if (!isBlank && groupStart >= 0) {
      regions.push({ startLine: groupStart, endLine: lastPipeLine });
      groupStart = -1;
      lastPipeLine = -1;
    }
  }

  if (groupStart >= 0) {
    regions.push({ startLine: groupStart, endLine: lastPipeLine });
  }

  return regions;
}

const PIPE_TABLE_SEPARATOR_RE = /\|[\s]*:?-{2,}:?[\s]*(?:\|[\s]*:?-{2,}:?[\s]*)+\|/;

function healPipeTableRegion(regionLines: string[]): string | null {
  if (!regionLines.some(l => l.trim() === "")) return null;

  const flat = regionLines.join("").replace(/\n/g, "");
  if (!PIPE_TABLE_SEPARATOR_RE.test(flat)) return null;

  const nonBlank = regionLines.filter(l => l.trim() !== "");
  const result: string[] = [];
  let acc = "";

  for (const line of nonBlank) {
    if (!acc) {
      acc = line;
    } else if (acc.trimEnd().endsWith("|") && line.trimStart().startsWith("|")) {
      result.push(acc);
      acc = line;
    } else {
      acc += line;
    }
  }

  if (acc) result.push(acc);
  return result.join("\n");
}

function sanitizePipeTables(text: string): string {
  if (!text || !text.includes("|") || !text.includes("\n")) return text;
  if ((text.match(/\|/g) || []).length < 3) return text;

  const lines = text.split("\n");
  const regions = findPipeTableRegions(lines);
  if (regions.length === 0) return text;

  for (let ri = regions.length - 1; ri >= 0; ri--) {
    const region = regions[ri];
    const regionLines = lines.slice(region.startLine, region.endLine + 1);
    const healed = healPipeTableRegion(regionLines);
    if (healed !== null) {
      const healedLines = healed.split("\n");
      lines.splice(region.startLine, region.endLine - region.startLine + 1, ...healedLines);
    }
  }

  return lines.join("\n");
}

function isTableInProgress(text: string): boolean {
  const trimmed = text.trimEnd();
  if (!trimmed) return false;
  const lastLine = trimmed.split("\n").at(-1) ?? "";
  return lastLine.trimStart().startsWith("|");
}

// ── Streaming split safety ──────────────────────────────────────────────────

/** Whether unsent text is safe to chunk/stream (no open fence/math/table row). */
function isSplitSafe(text: string, maxChars: number): boolean {
  if (hasUnclosedFence(text) && text.length <= maxChars) return false;
  if (hasUnclosedMathBlock(text) && text.length <= maxChars) return false;
  if (isTableInProgress(text)) return false;
  return true;
}

// ── Atomic blocks (contract: POLICY-011) ────────────────────────────────────

export type AtomicBlock = { start: number; end: number; kind: "table" | "diagram-fence" };

const DIAGRAM_LANGUAGES = new Set([
  "mermaid",
  "plantuml",
  "sequence",
  "flowchart",
  "gantt",
  "classdiagram",
  "statediagram",
  "erdiagram",
  "journey",
  "gitgraph",
  "mindmap",
  "timeline",
]);

function extractAtomicBlocks(text: string): AtomicBlock[] {
  const blocks: AtomicBlock[] = [];
  const lines = text.split("\n");
  let offset = 0;

  let inPlainFence = false;
  let inDiagram = false;
  let diagramStart = 0;

  let tableStart = -1;
  let tableEnd = -1;
  let tableHasSep = false;
  let tableLineCount = 0;

  const isTableLine = (line: string) => line.trim().startsWith("|");
  const isTableSeparator = (line: string) => /^\|[\s|:-]+\|$/.test(line.trim());

  const flushTable = () => {
    if (tableStart !== -1 && tableEnd !== -1 && (tableHasSep || tableLineCount >= 2)) {
      blocks.push({ start: tableStart, end: tableEnd, kind: "table" });
    }
    tableStart = -1;
    tableEnd = -1;
    tableHasSep = false;
    tableLineCount = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineEnd = offset + line.length + (i < lines.length - 1 ? 1 : 0);

    if (inPlainFence || inDiagram) {
      if (line.startsWith("```")) {
        if (inDiagram) {
          blocks.push({ start: diagramStart, end: lineEnd, kind: "diagram-fence" });
          inDiagram = false;
        } else {
          inPlainFence = false;
        }
      }
      offset = lineEnd;
      continue;
    }

    if (line.startsWith("```")) {
      flushTable();
      const lang = line.slice(3).trim().toLowerCase();
      if (lang && DIAGRAM_LANGUAGES.has(lang)) {
        inDiagram = true;
        diagramStart = offset;
      } else {
        inPlainFence = true;
      }
      offset = lineEnd;
      continue;
    }

    if (isTableLine(line)) {
      if (tableStart === -1) {
        tableStart = offset;
        tableLineCount = 1;
        tableHasSep = false;
      } else {
        tableLineCount++;
        if (!tableHasSep && tableLineCount === 2 && isTableSeparator(line)) {
          tableHasSep = true;
        }
      }
      tableEnd = lineEnd;
    } else {
      flushTable();
    }

    offset = lineEnd;
  }

  flushTable();
  return blocks.toSorted((a, b) => a.start - b.start);
}

function chunkMarkdownTextAtomicAware(
  text: string,
  maxChars: number,
  chunkFn: (text: string, max: number) => string[],
): string[] {
  const rawChunks = chunkFn(text, maxChars);
  if (rawChunks.length <= 1) return rawChunks;

  const atomicBlocks = extractAtomicBlocks(text);
  if (atomicBlocks.length === 0) return rawChunks;

  const splitIndices: number[] = [];
  let cumLen = 0;
  for (let i = 0; i < rawChunks.length - 1; i++) {
    cumLen += rawChunks[i].length;
    splitIndices.push(cumLen);
  }

  const adjustedIndices: number[] = [];
  let chunkWindowStart = 0;

  for (const idx of splitIndices) {
    const hit = atomicBlocks.find(b => b.start < idx && idx < b.end);
    if (!hit) {
      adjustedIndices.push(idx);
      chunkWindowStart = idx;
      continue;
    }

    if (hit.start > chunkWindowStart) {
      adjustedIndices.push(hit.start);
      chunkWindowStart = hit.start;
    } else {
      adjustedIndices.push(hit.end);
      chunkWindowStart = hit.end;
    }
  }

  const result: string[] = [];
  let prev = 0;
  for (const idx of adjustedIndices) {
    if (idx > prev) result.push(text.slice(prev, idx));
    prev = idx;
  }
  if (prev < text.length) result.push(text.slice(prev));

  return result.filter(c => c.length > 0);
}

export const mdAtomic = {
  extract: extractAtomicBlocks,
  chunkAware: chunkMarkdownTextAtomicAware,
  DIAGRAM_LANGUAGES,
} as const;

export const mdFence = {
  computeState: computeFenceStateAt,
  hasUnclosed: hasUnclosedFence,
} as const;

export const mdTable = {
  sanitize: sanitizePipeTables,
  inProgress: isTableInProgress,
} as const;

export const mdMath = {
  hasUnclosed: hasUnclosedMathBlock,
  normalize: normalizeMathBlocks,
} as const;

export const mdSplit = {
  isSafe: isSplitSafe,
} as const;
