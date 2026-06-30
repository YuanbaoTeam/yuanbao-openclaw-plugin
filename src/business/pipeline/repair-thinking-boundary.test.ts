import assert from "node:assert/strict";
import test from "node:test";
import {
  repairAllThinkingBoundaryJoins,
  repairThinkingBoundaryJoin,
  repairThinkingBoundaryNewlines,
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

// ── repairThinkingBoundaryNewlines (sandwich fallback) ──────────────────────

void test("repairThinkingBoundaryNewlines: removes \\n after CJK punctuation (、)", () => {
  assert.equal(
    repairThinkingBoundaryNewlines("写代码、查文档、\ndebug、聊聊技术"),
    "写代码、查文档、debug、聊聊技术",
  );
});

void test("repairThinkingBoundaryNewlines: removes \\n after CJK char", () => {
  assert.equal(
    repairThinkingBoundaryNewlines("来了\n！🦞"),
    "来了！🦞",
  );
});

void test("repairThinkingBoundaryNewlines: removes \\n after emoji", () => {
  assert.equal(
    repairThinkingBoundaryNewlines("🦞\n你好"),
    "🦞你好",
  );
});

void test("repairThinkingBoundaryNewlines: preserves \\n\\n paragraph breaks", () => {
  assert.equal(
    repairThinkingBoundaryNewlines("你好～ 🦞\n\n有什么可以帮你的？"),
    "你好～ 🦞\n\n有什么可以帮你的？",
  );
});

void test("repairThinkingBoundaryNewlines: preserves ，\\n verse line break", () => {
  assert.equal(
    repairThinkingBoundaryNewlines("枫落吴江秋水寒，\n孤帆远影入云端。"),
    "枫落吴江秋水寒，\n孤帆远影入云端。",
  );
});

void test("repairThinkingBoundaryNewlines: preserves markdown list items", () => {
  assert.equal(
    repairThinkingBoundaryNewlines("功能：\n- 写代码\n- 查文档\n- Debug"),
    "功能：\n- 写代码\n- 查文档\n- Debug",
  );
});

void test("repairThinkingBoundaryNewlines: preserves markdown heading after \\n", () => {
  assert.equal(
    repairThinkingBoundaryNewlines("介绍\n## 功能\n内容"),
    "介绍\n## 功能\n内容",
  );
});

void test("repairThinkingBoundaryNewlines: preserves ordered list", () => {
  assert.equal(
    repairThinkingBoundaryNewlines("步骤：\n1. 第一步\n2. 第二步"),
    "步骤：\n1. 第一步\n2. 第二步",
  );
});

void test("repairThinkingBoundaryNewlines: preserves unordered list with *", () => {
  assert.equal(
    repairThinkingBoundaryNewlines("功能：\n* 写代码\n* 查文档"),
    "功能：\n* 写代码\n* 查文档",
  );
});

void test("repairThinkingBoundaryNewlines: preserves blockquote", () => {
  assert.equal(
    repairThinkingBoundaryNewlines("引用：\n> 这是引用内容"),
    "引用：\n> 这是引用内容",
  );
});

void test("repairThinkingBoundaryNewlines: preserves complete table rows", () => {
  assert.equal(
    repairThinkingBoundaryNewlines("表格：\n| 列1 | 列2 |\n| --- | --- |"),
    "表格：\n| 列1 | 列2 |\n| --- | --- |",
  );
});

void test("repairThinkingBoundaryNewlines: removes mid-cell break in table", () => {
  const input = "| 🐍\nPython | 简洁 | AI |";
  const expected = "| 🐍Python | 简洁 | AI |";
  assert.equal(repairThinkingBoundaryNewlines(input), expected);
});

void test("repairThinkingBoundaryNewlines: mixed real scenario", () => {
  const input = "你好 Jes！🦞\n\n有什么我可以帮你的吗？写代码、查文档、\ndebug、或者聊聊技术问题都行。";
  const expected = "你好 Jes！🦞\n\n有什么我可以帮你的吗？写代码、查文档、debug、或者聊聊技术问题都行。";
  assert.equal(repairThinkingBoundaryNewlines(input), expected);
});

void test("repairThinkingBoundaryNewlines: mixed with markdown list", () => {
  const input = "嘿，Dev开发🦞来了\n！🦞\n\n功能：\n- 写代码\n- Debug\n随时问我";
  const expected = "嘿，Dev开发🦞来了！🦞\n\n功能：\n- 写代码\n- Debug\n随时问我";
  assert.equal(repairThinkingBoundaryNewlines(input), expected);
});
