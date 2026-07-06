/**
 * Unit tests for llm-judge.ts:
 *   - parseJudgeResponse: response text parsing tolerance
 *   - createOpenclawJudgeInvoker: contract with the SDK dispatcher (mocked)
 *
 * The SDK is mocked at its surface — we don't spin up an actual agent.
 * We verify:
 *   1) The invoker captures text from `deliver` and/or `onPartialReply`
 *   2) Timeout aborts the dispatcher and returns a safe fallback
 *   3) Dispatcher throwing → safe fallback (never propagates)
 *   4) Malformed / unparseable text → safe fallback
 *   5) Isolated session parameters (peer id has `:judge` suffix)
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  createOpenclawJudgeInvoker,
  __parseJudgeResponseForTests as parseJudgeResponse,
} from "./llm-judge.js";
import type { CreateOpenclawJudgeInvokerOptions } from "./llm-judge.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

interface CapturedDispatch {
  ctx: Record<string, unknown>;
  dispatcherOptions: {
    deliver: (
      payload: Record<string, unknown>,
      info: { kind: string },
    ) => Promise<void>;
    onError?: (err: unknown, info: { kind: string }) => void;
  };
  replyOptions?: {
    abortSignal?: AbortSignal;
    disableBlockStreaming?: boolean;
    onPartialReply?: (payload: { text?: string }) => Promise<void>;
  };
}

/**
 * Build a fake PluginRuntime that captures dispatch calls. `dispatchImpl`
 * receives the captured call and drives deliver/onPartialReply as needed.
 */
function makeFakeCore(dispatchImpl: (call: CapturedDispatch) => Promise<void>) {
  return {
    channel: {
      routing: {
        resolveAgentRoute: (params: { peer: { id: string } }) => ({
          agentId: "judge-agent",
          sessionKey: `sk:${params.peer.id}`,
          accountId: "acct-1",
        }),
      },
      reply: {
        finalizeInboundContext: (ctx: Record<string, unknown>) => ({ ...ctx }),
        dispatchReplyWithBufferedBlockDispatcher: async (params: CapturedDispatch) => {
          await dispatchImpl(params);
          return {} as Record<string, unknown>;
        },
      },
    },
  } as unknown as CreateOpenclawJudgeInvokerOptions["core"];
}

function makeOpts(overrides: Partial<CreateOpenclawJudgeInvokerOptions> = {}): CreateOpenclawJudgeInvokerOptions {
  return {
    core: makeFakeCore(async () => {}),
    config: {} as CreateOpenclawJudgeInvokerOptions["config"],
    groupCode: "grp-1",
    topicId: "topic-1",
    fromAccount: "alice",
    senderNickname: "Alice",
    accountId: "acct-1",
    timeoutMs: 3000,
    ...overrides,
  };
}

// ─── parseJudgeResponse ─────────────────────────────────────────────────────

describe("parseJudgeResponse", () => {
  test("正常 JSON: shouldReply=true", () => {
    const r = parseJudgeResponse('{"shouldReply": true, "reason": "涉及技术"}');
    assert.deepEqual(r, { shouldReply: true, reason: "涉及技术" });
  });

  test("正常 JSON: shouldReply=false", () => {
    const r = parseJudgeResponse('{"shouldReply": false, "reason": "纯闲聊"}');
    assert.deepEqual(r, { shouldReply: false, reason: "纯闲聊" });
  });

  test("旧字段名 reply 仍兼容", () => {
    const r = parseJudgeResponse('{"reply": true, "reason": "兼容"}');
    assert.deepEqual(r, { shouldReply: true, reason: "兼容" });
  });

  test("带 markdown code fence", () => {
    const r = parseJudgeResponse('```json\n{"shouldReply": true, "reason": "有问题"}\n```');
    assert.deepEqual(r, { shouldReply: true, reason: "有问题" });
  });

  test("周围带前后废话时抓取内部 JSON", () => {
    const r = parseJudgeResponse('Sure! {"shouldReply": false, "reason": "闲聊"} — done.');
    assert.deepEqual(r, { shouldReply: false, reason: "闲聊" });
  });

  test("字符串 'true'", () => {
    const r = parseJudgeResponse('{"shouldReply": "true", "reason": "test"}');
    assert.deepEqual(r, { shouldReply: true, reason: "test" });
  });

  test("字符串 'false'", () => {
    const r = parseJudgeResponse('{"shouldReply": "false", "reason": "不相关"}');
    assert.deepEqual(r, { shouldReply: false, reason: "不相关" });
  });

  test("should_reply 别名", () => {
    const r = parseJudgeResponse('{"should_reply": true, "reason": "别名"}');
    assert.deepEqual(r, { shouldReply: true, reason: "别名" });
  });

  test("无 reason 时使用默认", () => {
    const r = parseJudgeResponse('{"shouldReply": true}');
    assert.deepEqual(r, { shouldReply: true, reason: "llm-yes" });
  });

  test("非 JSON 返回 null", () => {
    const r = parseJudgeResponse("I think the bot should reply.");
    assert.equal(r, null);
  });

  test("空字符串返回 null", () => {
    assert.equal(parseJudgeResponse(""), null);
  });

  test("缺少 shouldReply 字段返回 null", () => {
    const r = parseJudgeResponse('{"reason": "没有shouldReply字段"}');
    assert.equal(r, null);
  });
});

// ─── createOpenclawJudgeInvoker ─────────────────────────────────────────────

describe("createOpenclawJudgeInvoker", () => {
  test("通过 deliver 累积文本 → 解析成功", async () => {
    const core = makeFakeCore(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "{\"shouldReply\": true, " }, { kind: "text" });
      await dispatcherOptions.deliver({ text: "\"reason\": \"技术讨论\"}" }, { kind: "text" });
    });

    const invoke = createOpenclawJudgeInvoker(makeOpts({ core }));
    const result = await invoke({ prompt: "test prompt" });

    assert.equal(result.shouldReply, true);
    assert.equal(result.reason, "技术讨论");
  });

  test("通过 onPartialReply 累积（覆盖式全文）→ 解析成功", async () => {
    const core = makeFakeCore(async ({ replyOptions }) => {
      // partial reply is cumulative — send progressively longer texts
      await replyOptions?.onPartialReply?.({ text: "{\"shouldReply\": false," });
      await replyOptions?.onPartialReply?.({ text: '{"shouldReply": false, "reason": "闲聊"}' });
    });

    const invoke = createOpenclawJudgeInvoker(makeOpts({ core }));
    const result = await invoke({ prompt: "test" });

    assert.equal(result.shouldReply, false);
    assert.equal(result.reason, "闲聊");
  });

  test("忽略 reasoning / tool 类型的 deliver payload", async () => {
    const core = makeFakeCore(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "思考中...", isReasoning: true }, { kind: "text" });
      await dispatcherOptions.deliver({ text: "tool output" }, { kind: "tool" });
      await dispatcherOptions.deliver({ text: '{"shouldReply": true, "reason": "ok"}' }, { kind: "text" });
    });

    const invoke = createOpenclawJudgeInvoker(makeOpts({ core }));
    const result = await invoke({ prompt: "test" });

    assert.equal(result.shouldReply, true);
    assert.equal(result.reason, "ok");
  });

  test("dispatcher 抛错 → 安全降级为 agent-failed", async () => {
    const core = makeFakeCore(async () => {
      throw new Error("agent boom");
    });

    const invoke = createOpenclawJudgeInvoker(makeOpts({ core }));
    const result = await invoke({ prompt: "test" });

    assert.equal(result.shouldReply, false);
    assert.ok(result.reason.includes("agent-failed"));
  });

  test("超时（AbortController abort）→ 安全降级", async () => {
    const core = makeFakeCore(async ({ replyOptions }) => {
      // Pretend the dispatcher waits and honors abortSignal
      await new Promise<void>((_resolve, reject) => {
        replyOptions?.abortSignal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const invoke = createOpenclawJudgeInvoker(makeOpts({ core, timeoutMs: 30 }));
    const result = await invoke({ prompt: "test" });

    assert.equal(result.shouldReply, false);
    assert.ok(result.reason.includes("timeout"));
  });

  test("agent 返回非 JSON 文本 → parse-failed 降级", async () => {
    const core = makeFakeCore(async ({ dispatcherOptions }) => {
      await dispatcherOptions.deliver({ text: "yes I think the bot should reply" }, { kind: "text" });
    });

    const invoke = createOpenclawJudgeInvoker(makeOpts({ core }));
    const result = await invoke({ prompt: "test" });

    assert.equal(result.shouldReply, false);
    assert.ok(result.reason.includes("parse-failed"));
  });

  test("agent 无输出 → parse-failed 降级", async () => {
    const core = makeFakeCore(async () => {
      // no deliver, no partial — captured text is empty
    });

    const invoke = createOpenclawJudgeInvoker(makeOpts({ core }));
    const result = await invoke({ prompt: "test" });

    assert.equal(result.shouldReply, false);
    assert.ok(result.reason.includes("parse-failed"));
  });

  test("session 隔离：peer id 带 :judge 后缀，且 ChatType=direct", async () => {
    let capturedCtx: Record<string, unknown> | undefined;
    let capturedPeerId: string | undefined;

    const core = {
      channel: {
        routing: {
          resolveAgentRoute: (params: { peer: { id: string } }) => {
            capturedPeerId = params.peer.id;
            return {
              agentId: "judge-agent",
              sessionKey: `sk:${params.peer.id}`,
              accountId: "acct-1",
            };
          },
        },
        reply: {
          finalizeInboundContext: (ctx: Record<string, unknown>) => {
            capturedCtx = ctx;
            return ctx;
          },
          dispatchReplyWithBufferedBlockDispatcher: async ({
            dispatcherOptions,
          }: CapturedDispatch) => {
            await dispatcherOptions.deliver({ text: '{"shouldReply": true, "reason": "ok"}' }, { kind: "text" });
            return {} as Record<string, unknown>;
          },
        },
      },
    } as unknown as CreateOpenclawJudgeInvokerOptions["core"];

    const invoke = createOpenclawJudgeInvoker(
      makeOpts({ core, groupCode: "g-42", topicId: "t-99" }),
    );
    await invoke({ prompt: "test" });

    assert.ok(capturedPeerId?.endsWith(":judge"), `peerId should end with :judge, got ${capturedPeerId}`);
    assert.ok(capturedPeerId?.includes("g-42") && capturedPeerId?.includes("t-99"));
    assert.equal(capturedCtx?.ChatType, "direct");
    // Body should equal the prompt passed in
    assert.equal(capturedCtx?.Body, "test");
    // No InboundHistory injected
    assert.equal(capturedCtx?.InboundHistory, undefined);
  });

  test("disableBlockStreaming=true 被传给 dispatcher", async () => {
    let capturedReplyOpts: CapturedDispatch["replyOptions"] | undefined;
    const core = makeFakeCore(async ({ dispatcherOptions, replyOptions }) => {
      capturedReplyOpts = replyOptions;
      await dispatcherOptions.deliver({ text: '{"shouldReply": true, "reason": "ok"}' }, { kind: "text" });
    });

    const invoke = createOpenclawJudgeInvoker(makeOpts({ core }));
    await invoke({ prompt: "test" });

    assert.equal(capturedReplyOpts?.disableBlockStreaming, true);
    assert.ok(capturedReplyOpts?.abortSignal instanceof AbortSignal);
  });
});
