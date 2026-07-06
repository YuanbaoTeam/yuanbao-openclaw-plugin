/**
 * Integration tests for the full L2 topic self-judge decision chain.
 *
 * Tests the complete flow through shouldBotReplyInTopic using a stub
 * `judgeInvoker` — mirrors what `resolve-mention.ts` does at runtime, but
 * without spinning up the real OpenClaw agent pipeline.
 *
 *   1. Rule fast path (keyword/prefix/regex hit → reply immediately, no LLM)
 *   2. LLM judge → reply (rules miss, judge says yes)
 *   3. LLM judge → skip (rules miss, judge says no)
 *   4. LLM judge → error → safe degradation (don't reply)
 *   5. No Auto Reply section → no LLM call
 *   6. No judgeInvoker → no LLM call
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { shouldBotReplyInTopic } from "./index.js";
import type { TopicJudgeInput } from "./index.js";
import type { JudgeInvoker, JudgeResult } from "./llm-judge.js";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const soulFull = `# TestBot

我是一个技术讨论助手，擅长编程和架构设计。

## Reply Rules
- keyword: 帮我, 求助
- prefix: /ask

## Auto Reply
当话题涉及以下领域时主动参与：
- 编程/技术讨论（代码、架构、设计模式）
- 有人提问但超过3分钟无人回答
- 对话提到了我擅长的领域

不要参与：
- 纯闲聊灌水（天气、吃饭等）
- 私密/敏感话题
- 已有足够回复的讨论
`;

const soulRulesOnly = `# TestBot

## Reply Rules
- keyword: 帮我
`;

const soulAutoReplyOnly = `# TestBot

我是一个技术讨论助手。

## Auto Reply
当有人讨论技术问题时主动参与。
`;

/** Build a stub invoker that returns a fixed verdict, recording every call. */
function makeStubInvoker(verdict: JudgeResult): {
  invoker: JudgeInvoker;
  callCount: () => number;
  lastPrompt: () => string | undefined;
} {
  const calls: string[] = [];
  const invoker: JudgeInvoker = async ({ prompt }) => {
    calls.push(prompt);
    return verdict;
  };
  return {
    invoker,
    callCount: () => calls.length,
    lastPrompt: () => calls[calls.length - 1],
  };
}

/** Stub invoker that always throws (should never happen — invoker must be
 * safe, but we still verify shouldBotReplyInTopic propagates gracefully in the
 * degenerate case). */
function makeExplodingInvoker(): { invoker: JudgeInvoker; callCount: () => number } {
  let count = 0;
  const invoker: JudgeInvoker = async () => {
    count++;
    // Safe invokers never throw — but here we return an error-like verdict
    // to model what `createOpenclawJudgeInvoker` does internally on failure.
    return { shouldReply: false, reason: "llm-judge-error: timeout" };
  };
  return { invoker, callCount: () => count };
}

function makeInput(overrides: Partial<TopicJudgeInput> = {}): TopicJudgeInput {
  return {
    topicId: "test-topic-001",
    rawBody: "这个问题怎么解决？",
    senderNickname: "张三",
    soul: soulFull,
    historyTail: [
      "李四: 我遇到一个 TypeScript 类型推断问题",
      "王五: 能贴一下代码吗？",
      "李四: 就是泛型约束那块",
    ],
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("L2 topic-judge integration", () => {
  test("1. 规则快速通道：keyword 命中 → 立即回复，不调 invoker", async () => {
    const stub = makeStubInvoker({ shouldReply: true, reason: "should not be called" });

    const result = await shouldBotReplyInTopic(makeInput({
      rawBody: "帮我看一下这段代码",
      judgeInvoker: stub.invoker,
    }));

    assert.equal(result.shouldReply, true);
    assert.ok(result.reason.includes("keyword:帮我"));
    assert.equal(stub.callCount(), 0);
  });

  test("2. 规则快速通道：prefix 命中 → 立即回复，不调 invoker", async () => {
    const stub = makeStubInvoker({ shouldReply: true, reason: "should not be called" });

    const result = await shouldBotReplyInTopic(makeInput({
      rawBody: "/ask 如何优化性能？",
      judgeInvoker: stub.invoker,
    }));

    assert.equal(result.shouldReply, true);
    assert.ok(result.reason.includes("prefix:/ask"));
    assert.equal(stub.callCount(), 0);
  });

  test("3. LLM judge → 回复（规则未命中，invoker 判定 YES）", async () => {
    const stub = makeStubInvoker({ shouldReply: true, reason: "涉及技术讨论" });

    const result = await shouldBotReplyInTopic(makeInput({
      rawBody: "有人知道 Rust 的生命周期怎么理解吗？",
      judgeInvoker: stub.invoker,
    }));

    assert.equal(result.shouldReply, true);
    assert.ok(result.reason.includes("llm-judge"));
    assert.ok(result.reason.includes("涉及技术讨论"));
    assert.equal(stub.callCount(), 1);
  });

  test("4. LLM judge → 跳过（规则未命中，invoker 判定 NO）", async () => {
    const stub = makeStubInvoker({ shouldReply: false, reason: "纯闲聊内容" });

    const result = await shouldBotReplyInTopic(makeInput({
      rawBody: "今天天气真好啊",
      judgeInvoker: stub.invoker,
    }));

    assert.equal(result.shouldReply, false);
    assert.ok(result.reason.includes("llm-judge-skip"));
    assert.ok(result.reason.includes("纯闲聊内容"));
  });

  test("5. LLM judge → 错误降级（invoker 返回 llm-judge-error）", async () => {
    const stub = makeExplodingInvoker();

    const result = await shouldBotReplyInTopic(makeInput({
      rawBody: "TypeScript 怎么用？",
      judgeInvoker: stub.invoker,
    }));

    assert.equal(result.shouldReply, false);
    assert.ok(result.reason.includes("llm-judge-skip"));
    assert.ok(result.reason.includes("timeout"));
    assert.equal(stub.callCount(), 1);
  });

  test("6. 无 Auto Reply 区块 → 不调 invoker，返回 no auto-reply config", async () => {
    const stub = makeStubInvoker({ shouldReply: true, reason: "should not be called" });

    const result = await shouldBotReplyInTopic(makeInput({
      rawBody: "这是一个技术问题",
      soul: soulRulesOnly,
      judgeInvoker: stub.invoker,
    }));

    assert.equal(result.shouldReply, false);
    assert.equal(result.reason, "no auto-reply config");
    assert.equal(stub.callCount(), 0);
  });

  test("7. 无 judgeInvoker → 不调 invoker，返回 no rule matched", async () => {
    const result = await shouldBotReplyInTopic(makeInput({
      rawBody: "这是一个技术问题",
      judgeInvoker: undefined,
    }));

    assert.equal(result.shouldReply, false);
    assert.equal(result.reason, "no rule matched");
  });

  test("8. 仅有 Auto Reply 无 Reply Rules → 直接走 invoker", async () => {
    const stub = makeStubInvoker({ shouldReply: true, reason: "技术问题" });

    const result = await shouldBotReplyInTopic(makeInput({
      rawBody: "React hooks 怎么用？",
      soul: soulAutoReplyOnly,
      judgeInvoker: stub.invoker,
    }));

    assert.equal(result.shouldReply, true);
    assert.ok(result.reason.includes("llm-judge"));
    assert.equal(stub.callCount(), 1);
  });

  test("9. 空 soul → 不调 invoker，直接返回", async () => {
    const stub = makeStubInvoker({ shouldReply: true, reason: "should not be called" });

    const result = await shouldBotReplyInTopic(makeInput({
      rawBody: "hello",
      soul: "",
      judgeInvoker: stub.invoker,
    }));

    assert.equal(result.shouldReply, false);
    assert.equal(result.reason, "no soul configured");
    assert.equal(stub.callCount(), 0);
  });

  test("10. historyTail 传入 invoker prompt 中", async () => {
    const stub = makeStubInvoker({ shouldReply: true, reason: "有上下文" });

    await shouldBotReplyInTopic(makeInput({
      rawBody: "我也遇到了",
      historyTail: ["Alice: TypeScript 泛型怎么用", "Bob: 看文档"],
      judgeInvoker: stub.invoker,
    }));

    const prompt = stub.lastPrompt() ?? "";
    assert.ok(prompt.includes("Alice: TypeScript 泛型怎么用"));
    assert.ok(prompt.includes("Bob: 看文档"));
    assert.ok(prompt.includes("我也遇到了"));
  });
});
