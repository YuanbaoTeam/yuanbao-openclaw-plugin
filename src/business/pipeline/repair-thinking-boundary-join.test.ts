import assert from "node:assert/strict";
import test from "node:test";
import {
  repairAllThinkingBoundaryJoins,
  repairThinkingBoundaryJoin,
} from "./repair-thinking-boundary-join.js";

void test("repairThinkingBoundaryJoin: removes mid-line newline after reasoning", () => {
  const prefix = "来一首新的，换个风格 🦞\n\n---\n\n**《秋江";
  const incoming = `${prefix}\n送别》**\n\n枫落吴江秋水寒，`;
  assert.equal(repairThinkingBoundaryJoin(prefix, incoming), `${prefix}送别》**\n\n枫落吴江秋水寒，`);
});

void test("repairThinkingBoundaryJoin: removes mid-word newline (又是/你)", () => {
  assert.equal(
    repairThinkingBoundaryJoin("Hi Shun！👋 又是", "Hi Shun！👋 又是\n你，有什么新鲜事？"),
    "Hi Shun！👋 又是你，有什么新鲜事？",
  );
});

void test("repairThinkingBoundaryJoin: removes newline after exclamation before emoji continuation", () => {
  assert.equal(
    repairThinkingBoundaryJoin("Hi Shun！", "Hi Shun！\n🦞 今天想写诗还是想聊点别的？"),
    "Hi Shun！🦞 今天想写诗还是想聊点别的？",
  );
});

void test("repairThinkingBoundaryJoin: keeps verse line break after Chinese clause end", () => {
  const prefix = "庭前花落春将暮，";
  const incoming = `${prefix}\n独倚栏杆望归路。`;
  assert.equal(repairThinkingBoundaryJoin(prefix, incoming), incoming);
});

void test("repairThinkingBoundaryJoin: keeps paragraph break after sentence end", () => {
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

void test("repairThinkingBoundaryJoin: repairs 庭前花/落春将暮 mid-line split", () => {
  const prefix = "来一首不一样的 🦞\n\n---\n\n**《闺怨》**\n\n庭前花";
  const incoming = `${prefix}\n落春将暮，\n独倚栏杆望归路。`;
  assert.equal(repairThinkingBoundaryJoin(prefix, incoming), `${prefix}落春将暮，\n独倚栏杆望归路。`);
});

void test("repairAllThinkingBoundaryJoins: re-applies boundary repair on later partial updates", () => {
  const prefix = "来一首不一样的 🦞\n\n---\n\n**《闺怨》**\n\n庭前花";
  const broken = `${prefix}\n落春将暮，\n独倚栏杆望归路。`;
  const fixed = `${prefix}落春将暮，\n独倚栏杆望归路。`;
  const laterBroken = `${broken}\n千里江山云缥缈，`;
  const laterFixed = `${fixed}\n千里江山云缥缈，`;

  assert.equal(repairAllThinkingBoundaryJoins([prefix], broken), fixed);
  assert.equal(repairAllThinkingBoundaryJoins([prefix], laterBroken), laterFixed);
});
