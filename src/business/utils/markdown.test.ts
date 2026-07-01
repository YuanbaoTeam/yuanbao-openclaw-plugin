/**
 * Unit tests for markdown.ts outbound sanitization and atomic chunking.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mdAtomic, mdFence, mdMath, mdSplit, mdTable } from "./markdown.js";
import { chunkMarkdownText } from "openclaw/plugin-sdk/reply-runtime";

void test("mdTable.sanitize fast-paths text without pipes or newlines", () => {
  assert.equal(mdTable.sanitize("no pipes"), "no pipes");
  assert.equal(mdTable.sanitize("a | b"), "a | b");
  assert.equal(mdTable.sanitize(""), "");
});

void test("mdTable.sanitize rejoins a table fragmented by blank lines", () => {
  const fragmented = "| a | b |\n\n| --- | --- |\n\n| 1 | 2 |";
  const out = mdTable.sanitize(fragmented);
  assert.ok(!out.includes("\n\n|"), "blank lines inside table should be removed");
  assert.ok(out.includes("| a | b |"));
  assert.ok(out.includes("| 1 | 2 |"));
});

void test("mdFence.hasUnclosed tracks open ``` blocks", () => {
  assert.equal(mdFence.hasUnclosed("```js\nx"), true);
  assert.equal(mdFence.hasUnclosed("```js\nx\n```"), false);
  assert.equal(mdFence.computeState("x\n```", { inFence: true, fenceLang: "js" }).inFence, false);
});

void test("mdTable.inProgress requires blank line (\\n\\n) to close table", () => {
  assert.equal(mdTable.inProgress("| a | b |"), true);
  assert.equal(mdTable.inProgress("| a |\n| b |"), true);
  assert.equal(mdTable.inProgress("| a |\n| b |\n"), true, "single trailing newline is not closed");
  assert.equal(mdTable.inProgress("| a |\n| b |\n\n"), false);
  assert.equal(mdTable.inProgress("| a | b |\n\ndone"), false);
  assert.equal(mdTable.inProgress("| a |\n| b |\n\nnext"), false);
  assert.equal(mdTable.inProgress("| a |\n| b |\nnext"), true, "single newline before next line is not closed");
});

void test("mdSplit.isSafe waits on unclosed fence/math/table under maxChars", () => {
  assert.equal(mdSplit.isSafe("```\nx", 1200), false);
  assert.equal(mdSplit.isSafe("$$ x", 1200), false);
  assert.equal(mdSplit.isSafe("| a |", 1200), false);
  assert.equal(mdSplit.isSafe("plain text", 1200), true);
});

void test("mdMath.hasUnclosed detects open $$ outside fences", () => {
  assert.equal(mdMath.hasUnclosed("$$ x = 1"), true);
  assert.equal(mdMath.hasUnclosed("$$ x = 1 $$"), false);
  assert.equal(mdMath.hasUnclosed("```\n$$\n```"), false, "$$ inside fence ignored");
  assert.equal(mdMath.hasUnclosed("before $$\n1\n```\n$$\n```"), true, "open $$ before fence");
});

void test("mdMath.normalize collapses blank lines inside a math block", () => {
  const text = "before $$\na\n\n\nb\n$$ after";
  const out = mdMath.normalize(text);
  assert.ok(!out.includes("\n\n\n"), "extra blank lines inside $$ should collapse");
  assert.ok(out.includes("$$"));
});

void test("mdMath.normalize is a no-op without $$", () => {
  assert.equal(mdMath.normalize("plain text"), "plain text");
});

void test("mdAtomic.extract finds a table block", () => {
  const text = "intro\n\n| h1 | h2 |\n| --- | --- |\n| a | b |";
  const blocks = mdAtomic.extract(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, "table");
});

void test("mdAtomic.extract finds a diagram fence but not a plain fence", () => {
  const diagram = "text\n```mermaid\ngraph TD\n  A-->B\n```\n";
  assert.equal(mdAtomic.extract(diagram).some(b => b.kind === "diagram-fence"), true);
  const plain = "text\n```js\ncode\n```\n";
  assert.deepEqual(mdAtomic.extract(plain), []);
});

void test("mdAtomic.chunkAware keeps a table intact across the split boundary (POLICY-011)", () => {
  const text = [
    "intro paragraph",
    "",
    "| Model | Score |",
    "| --- | --- |",
    "| GPT-4o | 88.7% |",
    "| Claude | 90.2% |",
  ].join("\n");
  const chunks = mdAtomic.chunkAware(text, 30, (t, max) => {
    if (t.length <= max) return [t];
    const idx = t.lastIndexOf("\n", max);
    const breakAt = idx > 0 ? idx + 1 : max;
    return [t.slice(0, breakAt), t.slice(breakAt)];
  });
  const joined = chunks.join("");
  assert.equal(joined, text);
  assert.ok(chunks.some(c => c.includes("| Model | Score |")), "table header stays in one chunk");
});

void test("mdAtomic.chunkAware prevents openclaw chunkMarkdownText from splitting mid-table", () => {
  const header = "| 城市 | 国家 | 人口(万) | 气温 |\n|:---:|:---:|---:|---:|\n";
  const rows = Array.from(
    { length: 20 },
    (_, i) => `| 城市${String(i).padStart(2, "0")} | 中国 | ${1000 + i} | ${10 + i} |`,
  ).join("\n");
  const text = `## 天气\n\n${header}${rows}\n\n## 下一节`;
  const limit = 300;
  const safe = mdAtomic.chunkAware(text, limit, chunkMarkdownText);
  assert.equal(safe.join(""), text);
  const tableHeader = "| 城市 | 国家 |";
  for (const chunk of safe) {
    if (!chunk.includes(tableHeader)) continue;
    assert.ok(
      chunk.includes("| 城市00 |") && chunk.includes("| 城市19 |"),
      "each chunk containing table header must include full table",
    );
  }
});

void test("mdAtomic.chunkAware returns single chunk unchanged when within limit", () => {
  assert.deepEqual(mdAtomic.chunkAware("short", 100, t => [t]), ["short"]);
});
