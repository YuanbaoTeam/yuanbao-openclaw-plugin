/**
 * Unit tests for business/utils/markdown.ts — fence/math/table detection,
 * block-separator inference, atomic-block extraction, and atomic-aware chunking
 * (POLICY-011). All pure functions.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mdAtomic, mdBlock, mdFence, mdMath, mdTable } from "./markdown.js";

// ── mdFence ──────────────────────────────────────────────────────────────────
void test("mdFence.stripOuter unwraps a fenced block that contains a table", () => {
  const wrapped = "```markdown\n| a | b |\n| - | - |\n| 1 | 2 |\n```";
  assert.equal(mdFence.stripOuter(wrapped), "| a | b |\n| - | - |\n| 1 | 2 |");
});

void test("mdFence.stripOuter keeps a fenced block without a table", () => {
  const wrapped = "```\ncode line\n```";
  assert.equal(mdFence.stripOuter(wrapped), wrapped);
});

void test("mdFence.hasUnclosed detects open vs closed fences", () => {
  assert.equal(mdFence.hasUnclosed("```js\ncode"), true);
  assert.equal(mdFence.hasUnclosed("```js\ncode\n```"), false);
  assert.equal(mdFence.hasUnclosed("no fence here"), false);
});

void test("mdFence.hasUnclosedMath detects open $$ blocks (ignoring fenced code)", () => {
  assert.equal(mdFence.hasUnclosedMath("text $$ a = b"), true);
  assert.equal(mdFence.hasUnclosedMath("text $$ a = b $$ done"), false);
  assert.equal(mdFence.hasUnclosedMath("```\n$$ inside fence\n```"), false);
});

void test("mdFence.mergeBlockStreaming rejoins split-then-reopened fences", () => {
  const merged = mdFence.mergeBlockStreaming("```js\ncode\n```", "```js\nmore\n```");
  assert.equal(mdFence.hasUnclosed(merged), false);
  assert.match(merged, /code/);
  assert.match(merged, /more/);
});

void test("mdFence.mergeBlockStreaming strips re-open marker when buffer fence still open", () => {
  const merged = mdFence.mergeBlockStreaming("```js\ncode", "```js\nmore\n```");
  assert.match(merged, /more/);
});

void test("mdFence.mergeBlockStreaming strips a re-open marker when buffer fence is unclosed (case 3)", () => {
  const merged = mdFence.mergeBlockStreaming("prefix\n```js\nlet a=1;", "```js\nlet b=2;\n```");
  assert.match(merged, /let a=1;/);
  assert.match(merged, /let b=2;/);
});

// ── mdBlock ──────────────────────────────────────────────────────────────────
void test("mdBlock.startsWithBlockElement recognizes block starts", () => {
  for (const s of ["# heading", "- item", "1. item", "> quote", "```js", "| a |", "$$x$$", "--- "]) {
    assert.equal(mdBlock.startsWithBlockElement(s), true, s);
  }
  assert.equal(mdBlock.startsWithBlockElement("plain paragraph"), false);
});

void test("mdBlock.endsWithTableRow / isTableInProgress", () => {
  assert.equal(mdBlock.endsWithTableRow("text\n| a | b |"), true);
  assert.equal(mdBlock.endsWithTableRow("text\n| a | b"), false); // not closed
  assert.equal(mdBlock.isTableInProgress("text\n| a | b"), true); // starts with | counts
  assert.equal(mdBlock.isTableInProgress("plain"), false);
  assert.equal(mdBlock.endsWithTableRow(""), false);
});

void test("mdBlock.inferSeparator: blank-line buffer → no separator", () => {
  assert.equal(mdBlock.inferSeparator("para\n\n", "next"), "");
});

void test("mdBlock.inferSeparator: two table rows → newline", () => {
  assert.equal(mdBlock.inferSeparator("| a | b |", "| c | d |"), "\n");
});

void test("mdBlock.inferSeparator: block element follows paragraph → blank line", () => {
  assert.equal(mdBlock.inferSeparator("a paragraph", "# heading"), "\n\n");
});

void test("mdBlock.inferSeparator: mid-cell table split → direct concat", () => {
  assert.equal(mdBlock.inferSeparator("| GPT | 88", "% | 90% |"), "");
});

void test("mdBlock.inferSeparator: unclosed fence/math in buffer → no separator", () => {
  assert.equal(mdBlock.inferSeparator("```js\ncode", "more"), "");
  assert.equal(mdBlock.inferSeparator("text $$ a=b", "more"), "");
});

void test("mdBlock.inferSeparator: table-row split across blocks → single space", () => {
  // buffer ends with a complete table row; incoming first line ends with | but
  // doesn't start with | → mid-row split, join with a space.
  assert.equal(mdBlock.inferSeparator("| a | b |", "c |\n| d |"), " ");
});

void test("mdBlock.inferSeparator: plain paragraph continuation → no separator", () => {
  assert.equal(mdBlock.inferSeparator("a sentence", "continues here"), "");
});

// ── mdAtomic ─────────────────────────────────────────────────────────────────
void test("mdAtomic.extract finds a table block", () => {
  const text = "intro\n| a | b |\n| - | - |\n| 1 | 2 |\nafter";
  const blocks = mdAtomic.extract(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "table");
});

void test("mdAtomic.extract finds a diagram fence but not a plain fence", () => {
  const diagram = "```mermaid\ngraph TD\nA-->B\n```";
  assert.equal(mdAtomic.extract(diagram).some(b => b.kind === "diagram-fence"), true);
  const plain = "```js\nconst x = 1;\n```";
  assert.deepEqual(mdAtomic.extract(plain), []);
});

void test("mdAtomic.chunkAware keeps a table intact across the split boundary (POLICY-011)", () => {
  // Build text where a naive splitter would cut through the table.
  const head = "x".repeat(20);
  const table = "| col1 | col2 |\n| ---- | ---- |\n| aaaa | bbbb |";
  const text = `${head}\n${table}\n${"y".repeat(20)}`;
  const chunks = mdAtomic.chunkAware(text, 30, (t, max) => {
    const out: string[] = [];
    for (let i = 0; i < t.length; i += max) { out.push(t.slice(i, i + max)); }
    return out;
  });
  // No chunk should contain a partial table (a table line without its siblings):
  // the whole table must live in exactly one chunk.
  const tableChunks = chunks.filter(c => c.includes("| col1 |"));
  assert.equal(tableChunks.length, 1);
  assert.match(tableChunks[0], /\| aaaa \| bbbb \|/);
});

void test("mdAtomic.chunkAware returns single chunk unchanged when within limit", () => {
  assert.deepEqual(mdAtomic.chunkAware("short", 100, t => [t]), ["short"]);
});

// ── mdTable ──────────────────────────────────────────────────────────────────
void test("mdTable.sanitize fast-paths text without pipes or newlines", () => {
  assert.equal(mdTable.sanitize("no pipes"), "no pipes");
  assert.equal(mdTable.sanitize("a | b"), "a | b"); // no newline
  assert.equal(mdTable.sanitize(""), "");
});

void test("mdTable.sanitize rejoins a table fragmented by blank lines", () => {
  const fragmented = "| a | b |\n\n| --- | --- |\n\n| 1 | 2 |";
  const out = mdTable.sanitize(fragmented);
  // blank lines between table rows are removed so the table is contiguous
  assert.equal(/\n\s*\n/.test(out), false);
  assert.match(out, /\| 1 \| 2 \|/);
});

// ── mdMath ───────────────────────────────────────────────────────────────────
void test("mdMath.normalize collapses blank lines inside a math block", () => {
  const text = "$$\na = b\n\n\nc = d\n$$";
  const out = mdMath.normalize(text);
  assert.equal(/\n\n/.test(out), false);
  assert.match(out, /a = b/);
});

void test("mdMath.normalize is a no-op without $$", () => {
  assert.equal(mdMath.normalize("plain text"), "plain text");
});
