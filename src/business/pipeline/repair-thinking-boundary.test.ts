import assert from "node:assert/strict";
import test from "node:test";
import {
  repairAllThinkingBoundaryJoins,
  repairSandwichText,
  repairThinkingBoundaryJoin,
} from "./repair-thinking-boundary.js";

// ── repairThinkingBoundaryJoin ──────────────────────────────────────────────

void test("repairThinkingBoundaryJoin: removes mid-word newline (又是/你)", () => {
  assert.equal(
    repairThinkingBoundaryJoin("Hi Shun！👋 又是", "Hi Shun！👋 又是\n你，有什么新鲜事？"),
    "Hi Shun！👋 又是你，有什么新鲜事？",
  );
});

void test("repairThinkingBoundaryJoin: removes newline after exclamation before emoji", () => {
  assert.equal(
    repairThinkingBoundaryJoin("Hi Shun！", "Hi Shun！\n🦞 今天想写诗还是想聊点别的？"),
    "Hi Shun！🦞 今天想写诗还是想聊点别的？",
  );
});

void test("repairThinkingBoundaryJoin: removes mid-line title split (秋江/送别)", () => {
  const prefix = "来一首新的，换个风格 🦞\n\n---\n\n**《秋江";
  const incoming = `${prefix}\n送别》**\n\n枫落吴江秋水寒，`;
  assert.equal(repairThinkingBoundaryJoin(prefix, incoming), `${prefix}送别》**\n\n枫落吴江秋水寒，`);
});

void test("repairThinkingBoundaryJoin: removes mid-line split (庭前花/落春将暮)", () => {
  const prefix = "来一首不一样的 🦞\n\n---\n\n**《闺怨》**\n\n庭前花";
  const incoming = `${prefix}\n落春将暮，\n独倚栏杆望归路。`;
  assert.equal(repairThinkingBoundaryJoin(prefix, incoming), `${prefix}落春将暮，\n独倚栏杆望归路。`);
});

void test("repairThinkingBoundaryJoin: removes double-newline mid-word split", () => {
  const prefix = "**《秋江";
  const incoming = `${prefix}\n\n送别》**`;
  assert.equal(repairThinkingBoundaryJoin(prefix, incoming), `${prefix}送别》**`);
});

void test("repairThinkingBoundaryJoin: keeps verse line break after Chinese comma", () => {
  const prefix = "枫落吴江秋水寒，";
  const incoming = `${prefix}\n孤帆远影入云端。`;
  assert.equal(repairThinkingBoundaryJoin(prefix, incoming), incoming);
});

void test("repairThinkingBoundaryJoin: keeps paragraph break after sentence-end punctuation", () => {
  const prefix = "第一段。";
  const incoming = "第一段。\n\n第二段";
  assert.equal(repairThinkingBoundaryJoin(prefix, incoming), incoming);
});

void test("repairThinkingBoundaryJoin: no-op when prefix already ends with newline", () => {
  const prefix = "第一段\n";
  const incoming = "第一段\n第二段";
  assert.equal(repairThinkingBoundaryJoin(prefix, incoming), incoming);
});

void test("repairThinkingBoundaryJoin: preserves \\n before markdown heading", () => {
  const prefix = "# 🎬 场景 Markdown 文档演示\n\n---";
  const incoming = `${prefix}\n## 📚 场景一：用户引导流程`;
  assert.equal(repairThinkingBoundaryJoin(prefix, incoming), incoming);
});

void test("repairThinkingBoundaryJoin: preserves \\n before table row", () => {
  const prefix = "一些文本内容";
  const incoming = `${prefix}\n| 列1 | 列2 |`;
  assert.equal(repairThinkingBoundaryJoin(prefix, incoming), incoming);
});

void test("repairThinkingBoundaryJoin: preserves \\n before list item", () => {
  const prefix = "功能列表：";
  const incoming = `${prefix}\n- 第一项`;
  assert.equal(repairThinkingBoundaryJoin(prefix, incoming), incoming);
});

void test("repairThinkingBoundaryJoin: still removes \\n before plain text", () => {
  assert.equal(
    repairThinkingBoundaryJoin("Hi Shun！", "Hi Shun！\n🦞 有啥需要帮忙的？"),
    "Hi Shun！🦞 有啥需要帮忙的？",
  );
});

void test("repairThinkingBoundaryJoin: no-op when incoming does not extend prefix", () => {
  assert.equal(repairThinkingBoundaryJoin("hello", "world"), "world");
});

// ── repairAllThinkingBoundaryJoins ──────────────────────────────────────────

void test("repairAllThinkingBoundaryJoins: re-applies repair on every subsequent partial update", () => {
  const prefix = "来一首不一样的 🦞\n\n---\n\n**《闺怨》**\n\n庭前花";
  const firstBroken = `${prefix}\n落春将暮，\n独倚栏杆望归路。`;
  const firstFixed = `${prefix}落春将暮，\n独倚栏杆望归路。`;
  const laterBroken = `${firstBroken}\n千里江山云缥缈，`;
  const laterFixed = `${firstFixed}\n千里江山云缥缈，`;

  assert.equal(repairAllThinkingBoundaryJoins([prefix], firstBroken), firstFixed);
  assert.equal(repairAllThinkingBoundaryJoins([prefix], laterBroken), laterFixed);
});

void test("repairAllThinkingBoundaryJoins: handles multiple boundary prefixes", () => {
  const prefix1 = "第一段";
  const prefix2 = "第一段第二段";
  const incoming = "第一段第二段\n第三段";
  assert.equal(repairAllThinkingBoundaryJoins([prefix1, prefix2], incoming), "第一段第二段第三段");
});

void test("repairAllThinkingBoundaryJoins: no-op with empty prefixes", () => {
  assert.equal(repairAllThinkingBoundaryJoins([], "any text\n更多"), "any text\n更多");
});

// ── repairSandwichText ──────────────────────────────────────────────────────

void test("repairSandwichText: no-op when no single newlines in delta", () => {
  const result = repairSandwichText("prefix", "prefix suffix no newline");
  assert.equal(result.repaired, "prefix suffix no newline");
  assert.equal(result.brokenFragment, "");
});

void test("repairSandwichText: no-op when delta has only paragraph breaks", () => {
  const result = repairSandwichText("prefix", "prefix\n\nnext paragraph");
  assert.equal(result.repaired, "prefix\n\nnext paragraph");
  assert.equal(result.brokenFragment, "");
});

void test("repairSandwichText: removes single spurious newline (empty snapshot)", () => {
  const result = repairSandwichText("", "Hi Shun！\n🦞 有啥需要帮忙的？");
  assert.equal(result.repaired, "Hi Shun！🦞 有啥需要帮忙的？");
  assert.equal(result.brokenFragment, "Hi Shun！\n🦞 有啥需要帮忙的？");
  assert.equal(result.repairedFragment, "Hi Shun！🦞 有啥需要帮忙的？");
});

void test("repairSandwichText: removes single spurious newline (non-empty snapshot)", () => {
  const snapshot = "前文内容";
  const text = "前文内容后续\n文字";
  const result = repairSandwichText(snapshot, text);
  assert.equal(result.repaired, "前文内容后续文字");
  assert.equal(result.brokenFragment, "后续\n文字");
  assert.equal(result.repairedFragment, "后续文字");
});

void test("repairSandwichText: no-op when single \\n is between two complete table rows", () => {
  // | 名称 | 类型 |\n|------|------| — the \n is intentional table formatting
  const input = "| 名称 | 类型 | 说明 |\n|------|------|";
  const result = repairSandwichText("", input);
  assert.equal(result.repaired, input);
  assert.equal(result.brokenFragment, "");
});

void test("repairSandwichText: removes single \\n inside an incomplete table cell", () => {
  // | 🐍\nPython | ... — the \n is mid-cell (lineBefore = "| 🐍" doesn't end with |)
  const input = "| 🐍\nPython | 简洁 | AI |\n|---|---|---|\n| ⚡ JS | 全栈 | Web |";
  const result = repairSandwichText("", input);
  assert.ok(!result.repaired.includes("🐍\nPython"), "mid-cell break should be removed");
  assert.ok(result.repaired.includes("🐍Python"), "emoji and name joined");
});

void test("repairSandwichText: table — merges broken separator even when prev row looks complete", () => {
  // "|------|------|" looks complete (ends with |) but is actually missing one column cell.
  // "------|\n" is the continuation. This is the harder case.
  const input = "| 名称 | 类型 | 说明 |\n|------|------|\n------|\n| Dev🦞 | AI | 助手 |\n| Jes | 人类 | 起名 |";
  const result = repairSandwichText("", input);
  assert.ok(result.brokenFragment !== "", "should have detected a repairable fragment");
  assert.ok(!result.repaired.includes("|------|\n------|\n"), "broken separator row should be merged");
  assert.ok(result.repaired.includes("|------|------|"), "separator row joined");
});

void test("repairSandwichText: table — merges broken separator row (|---\\n-|---|)", () => {
  const input = "| Git 命令 | 作用 |\n|------------\n-|------|\n| `git status` | 查看状态 |";
  const result = repairSandwichText("", input);
  assert.ok(
    !result.repaired.includes("------------\n-|"),
    "broken separator should be merged",
  );
  assert.ok(result.repaired.includes("------------|------"), "separator row merged");
  assert.ok(result.repaired.includes("git status"), "data rows preserved");
});

void test("repairSandwichText: table — preserves paragraph breaks", () => {
  const input = "| A | B |\n|---|---|\n| x | y |\n\n段落分隔后的内容";
  const result = repairSandwichText("", input);
  assert.ok(result.repaired.includes("\n\n段落"), "paragraph break preserved");
});

void test("repairSandwichText: multiple non-table single newlines — no-op (fallback)", () => {
  // Multiple spurious newlines in non-table content: not handled yet, leave unchanged
  const input = "行一\n行二\n行三";
  const result = repairSandwichText("", input);
  assert.equal(result.repaired, input);
  assert.equal(result.brokenFragment, "");
});

void test("repairSandwichText: no-op when snapshot does not match text", () => {
  const result = repairSandwichText("completely different", "unrelated text\n here");
  // Falls back to delta = entire text, single \n -> removes it
  assert.equal(result.repaired, "unrelated text here");
});

void test("repairSandwichText: brokenFragment/repairedFragment enable replay", () => {
  const input = "Hi Shun！\n🦞 有啥需要帮忙的？";
  const first = repairSandwichText("", input);
  assert.equal(first.repaired, "Hi Shun！🦞 有啥需要帮忙的？");

  // Later partial extends the text (SDK sends cumulative, still broken)
  const laterBroken = "Hi Shun！\n🦞 有啥需要帮忙的？更多内容";
  const replayed = laterBroken.replace(first.brokenFragment, first.repairedFragment);
  assert.equal(replayed, "Hi Shun！🦞 有啥需要帮忙的？更多内容");
});
