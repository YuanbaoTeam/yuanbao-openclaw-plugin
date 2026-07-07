/**
 * Unit tests for prompt-builder.ts: buildJudgePrompt and extractAutoReplyBlock.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildJudgePrompt,
  extractAutoReplyBlock,
  extractFullPersona,
  extractMutedFlag,
  extractPersona,
  extractPersonaBlock,
} from "./prompt-builder.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const soulWithAutoReply = `# 清风Bot

我是一个活泼的群聊助手，喜欢讨论技术和生活话题。

## Reply Rules
- keyword: 帮我

## Auto Reply
当话题涉及以下领域时主动参与：
- 编程/技术讨论
- 有人提问但无人回答
- 对话陷入僵局时活跃气氛

不要参与：
- 纯闲聊灌水
- 私密/敏感话题

## Other Section
This should not be included.
`;

const soulWithoutAutoReply = `# 清风Bot

我是一个安静的机器人。

## Reply Rules
- keyword: 帮我
`;

const soulEmpty = "";

// ─── extractAutoReplyBlock ──────────────────────────────────────────────────

void test("extractAutoReplyBlock: 提取 Auto Reply 区块", () => {
  const block = extractAutoReplyBlock(soulWithAutoReply);
  assert.ok(block.includes("编程/技术讨论"));
  assert.ok(block.includes("不要参与"));
  assert.ok(!block.includes("This should not be included"));
});

void test("extractAutoReplyBlock: 无 Auto Reply 区块返回空字符串", () => {
  const block = extractAutoReplyBlock(soulWithoutAutoReply);
  assert.equal(block, "");
});

void test("extractAutoReplyBlock: 空 soul 返回空字符串", () => {
  const block = extractAutoReplyBlock(soulEmpty);
  assert.equal(block, "");
});

// ─── buildJudgePrompt: hasAutoReplyConfig ───────────────────────────────────

void test("buildJudgePrompt: 有 Auto Reply → hasAutoReplyConfig=true", () => {
  const result = buildJudgePrompt({
    soul: soulWithAutoReply,
    rawBody: "你们觉得 TypeScript 怎么样？",
    senderNickname: "张三",
  });
  assert.equal(result.hasAutoReplyConfig, true);
  assert.ok(result.prompt.length > 0);
});

void test("buildJudgePrompt: 无 Auto Reply → hasAutoReplyConfig=false", () => {
  const result = buildJudgePrompt({
    soul: soulWithoutAutoReply,
    rawBody: "hello",
  });
  assert.equal(result.hasAutoReplyConfig, false);
  assert.equal(result.prompt, "");
});

void test("buildJudgePrompt: 空 soul → hasAutoReplyConfig=false", () => {
  const result = buildJudgePrompt({
    soul: "",
    rawBody: "hello",
  });
  assert.equal(result.hasAutoReplyConfig, false);
});

// ─── buildJudgePrompt: content assembly ─────────────────────────────────────

void test("buildJudgePrompt: prompt 包含人设、策略、输出协议四段", () => {
  const result = buildJudgePrompt({
    soul: soulWithAutoReply,
    rawBody: "test",
  });
  // Persona
  assert.ok(result.prompt.includes("机器人人设"));
  assert.ok(result.prompt.includes("活泼的群聊助手"));
  // Strategy
  assert.ok(result.prompt.includes("自动参与策略"));
  assert.ok(result.prompt.includes("编程/技术讨论"));
  // Output protocol
  assert.ok(result.prompt.includes("shouldReply"));
  assert.ok(result.prompt.includes("JSON"));
});

void test("buildJudgePrompt: prompt 包含当前消息", () => {
  const result = buildJudgePrompt({
    soul: soulWithAutoReply,
    rawBody: "有人用过 Rust 吗？",
    senderNickname: "李四",
  });
  assert.ok(result.prompt.includes("李四: 有人用过 Rust 吗？"));
  assert.ok(result.prompt.includes("当前消息"));
});

void test("buildJudgePrompt: prompt 包含历史", () => {
  const result = buildJudgePrompt({
    soul: soulWithAutoReply,
    rawBody: "我也想学",
    senderNickname: "王五",
    historyTail: [
      "张三: 最近在学 Rust",
      "李四: Rust 难吗？",
      "张三: 还好，主要是所有权概念",
    ],
  });
  assert.ok(result.prompt.includes("近期对话历史"));
  assert.ok(result.prompt.includes("张三: 最近在学 Rust"));
  assert.ok(result.prompt.includes("张三: 还好，主要是所有权概念"));
});

void test("buildJudgePrompt: 无历史时不输出历史 section", () => {
  const result = buildJudgePrompt({
    soul: soulWithAutoReply,
    rawBody: "hello",
  });
  assert.ok(!result.prompt.includes("近期对话历史"));
});

// ─── buildJudgePrompt: history trimming ─────────────────────────────────────

void test("buildJudgePrompt: 历史条目数超限时裁剪", () => {
  const longHistory = Array.from({ length: 20 }, (_, i) => `用户${i}: 消息${i}`);
  const result = buildJudgePrompt({
    soul: soulWithAutoReply,
    rawBody: "test",
    historyTail: longHistory,
    maxHistoryEntries: 5,
  });
  // Should contain only the last 5 entries
  assert.ok(result.prompt.includes("用户15: 消息15"));
  assert.ok(result.prompt.includes("用户19: 消息19"));
  assert.ok(!result.prompt.includes("用户0: 消息0"));
});

void test("buildJudgePrompt: 历史字符数超限时裁剪", () => {
  // Each entry is ~200 chars, 10 entries = ~2000 chars > MAX_HISTORY_CHARS(1200)
  const longEntries = Array.from(
    { length: 10 },
    (_, i) => `用户${i}: ${"这是一段很长的消息内容用于测试字符数限制".repeat(5)} [${i}]`,
  );
  const result = buildJudgePrompt({
    soul: soulWithAutoReply,
    rawBody: "test",
    historyTail: longEntries,
  });
  // The oldest entries should be trimmed to fit char budget
  // Just verify the newest entry is always present
  assert.ok(result.prompt.includes("[9]"));
});

// ─── buildJudgePrompt: sender fallback ──────────────────────────────────────

void test("buildJudgePrompt: 无 senderNickname 时使用默认", () => {
  const result = buildJudgePrompt({
    soul: soulWithAutoReply,
    rawBody: "测试消息",
  });
  assert.ok(result.prompt.includes("用户: 测试消息"));
});

// ─── extractPersonaBlock ────────────────────────────────────────────────────

void test("extractPersonaBlock: 提取显式 ## Persona 区块", () => {
  const soul = `# 清风Bot

## Persona
你是一位温柔的图书管理员，语气舒缓，喜欢引用文学经典。

## Auto Reply
foo
`;
  const block = extractPersonaBlock(soul);
  assert.ok(block.includes("温柔的图书管理员"));
  assert.ok(!block.includes("Auto Reply"));
  assert.ok(!block.includes("foo"));
});

void test("extractPersonaBlock: 无 Persona 段返回空字符串", () => {
  const block = extractPersonaBlock(soulWithAutoReply);
  assert.equal(block, "");
});

// ─── extractPersona (judge, 400 char cap) ───────────────────────────────────

void test("extractPersona: 无显式 Persona 段时回退到标题后 preamble", () => {
  const persona = extractPersona(soulWithAutoReply);
  assert.ok(persona.includes("活泼的群聊助手"));
});

void test("extractPersona: 显式 ## Persona 优先于 preamble", () => {
  const soul = `# 清风Bot

我是备用描述，不应被选中。

## Persona
真正的人设：一位冷静的分析师。

## Auto Reply
foo
`;
  const persona = extractPersona(soul);
  assert.ok(persona.includes("冷静的分析师"));
  assert.ok(!persona.includes("备用描述"));
});

void test("extractPersona: 超长文本截断至 400 字符 + 省略号", () => {
  const long = "x".repeat(2000);
  const soul = `# T\n\n${long}\n\n## Other\n`;
  const persona = extractPersona(soul);
  assert.ok(persona.length <= 401, `persona length ${persona.length} should be <=401`);
  assert.ok(persona.endsWith("…"));
});

void test("extractPersona: 空 soul 返回空字符串", () => {
  assert.equal(extractPersona(""), "");
});

// ─── extractFullPersona (reply, 1500 char cap) ──────────────────────────────

void test("extractFullPersona: 使用更大的字符预算（1500）", () => {
  const body = "y".repeat(1200);
  const soul = `# T\n\n## Persona\n${body}\n\n## Auto Reply\nfoo\n`;
  const persona = extractFullPersona(soul);
  // 1200 chars fits under 1500 cap → no truncation
  assert.equal(persona, body);
});

void test("extractFullPersona: 仍会在超过 1500 时截断", () => {
  const body = "z".repeat(2000);
  const soul = `# T\n\n## Persona\n${body}\n\n## Auto Reply\nfoo\n`;
  const persona = extractFullPersona(soul);
  assert.ok(persona.length <= 1501);
  assert.ok(persona.endsWith("…"));
});

void test("extractFullPersona: 显式 Persona 段优先", () => {
  const soul = `# T\n\npreamble text\n\n## Persona\n真正的人设\n\n## Auto Reply\nfoo\n`;
  const persona = extractFullPersona(soul);
  assert.ok(persona.includes("真正的人设"));
  assert.ok(!persona.includes("preamble"));
});

// ─── extractMutedFlag ───────────────────────────────────────────────────────

void test("extractMutedFlag: `## Muted\\ntrue` → true", () => {
  const soul = `# T\n\n## Reply Rules\n- keyword: 帮我\n\n## Muted\ntrue\n`;
  assert.equal(extractMutedFlag(soul), true);
});

void test("extractMutedFlag: 大小写与前后空白容忍", () => {
  assert.equal(
    extractMutedFlag(`## Muted\n   TRUE   \n`),
    true,
  );
  assert.equal(
    extractMutedFlag(`## muted\nTrue\n`),
    true,
  );
});

void test("extractMutedFlag: 支持 1/yes/on 别名", () => {
  assert.equal(extractMutedFlag(`## Muted\n1\n`), true);
  assert.equal(extractMutedFlag(`## Muted\nyes\n`), true);
  assert.equal(extractMutedFlag(`## Muted\non\n`), true);
});

void test("extractMutedFlag: false / 0 / no / off → false", () => {
  assert.equal(extractMutedFlag(`## Muted\nfalse\n`), false);
  assert.equal(extractMutedFlag(`## Muted\n0\n`), false);
  assert.equal(extractMutedFlag(`## Muted\nno\n`), false);
  assert.equal(extractMutedFlag(`## Muted\noff\n`), false);
});

void test("extractMutedFlag: 无 Muted 段 → false", () => {
  assert.equal(extractMutedFlag(soulWithAutoReply), false);
  assert.equal(extractMutedFlag(soulWithoutAutoReply), false);
});

void test("extractMutedFlag: 空 soul → false", () => {
  assert.equal(extractMutedFlag(""), false);
});

void test("extractMutedFlag: 无法识别的值 → false（保守默认，不误静音）", () => {
  assert.equal(extractMutedFlag(`## Muted\nmaybe\n`), false);
  assert.equal(extractMutedFlag(`## Muted\n\n`), false);
});

void test("extractMutedFlag: 值前有空行时读第一个非空行", () => {
  const soul = `## Muted\n\n\n  true  \n`;
  assert.equal(extractMutedFlag(soul), true);
});

void test("extractMutedFlag: 遇到下一个 ## 前无有效值 → false", () => {
  const soul = `## Muted\n\n## Reply Rules\n- keyword: 帮我\n`;
  assert.equal(extractMutedFlag(soul), false);
});

void test("extractMutedFlag: Muted 段夹在其他段之间也能被找到", () => {
  const soul = `# T\n\n## Reply Rules\n- keyword: a\n\n## Muted\ntrue\n\n## Auto Reply\nfoo\n`;
  assert.equal(extractMutedFlag(soul), true);
});
