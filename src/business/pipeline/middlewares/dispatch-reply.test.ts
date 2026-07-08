/**
 * Unit tests for dispatch-reply middleware.
 *
 * dispatch-reply middleware tests (StreamingOutputSession + sender).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

let mockRegistered = false;

function setupMocks(t: any) {
  if (!mockRegistered) {
    t.mock.module("openclaw/plugin-sdk/channel-reply-pipeline", {
      namedExports: {
        createChannelReplyPipeline: () => ({
          onModelSelected: () => {},
        }),
      },
    });
    t.mock.module("openclaw/plugin-sdk/reply-payload", {
      namedExports: {
        resolveOutboundMediaUrls: (payload: any) => payload.mediaUrls ?? [],
        normalizeOutboundReplyPayload: (payload: any) => ({
          text: payload.text ?? "",
          mediaUrls: payload.mediaUrls ?? [],
        }),
      },
    });
    t.mock.module("../../../access/ws/index.js", {
      namedExports: {
        WS_HEARTBEAT: { RUNNING: "running", FINISH: "finish" },
      },
    });
    t.mock.module("../../outbound/heartbeat.js", {
      namedExports: {
        createReplyHeartbeatController: () => ({
          emit: () => {},
          finishIfNeeded: () => {},
          stop: () => {},
        }),
      },
    });
    mockRegistered = true;
  }
}

/** Minimal sender mock that records sent text and media */
function createMockSender() {
  const sentTexts: string[] = [];
  const sentMediaUrls: string[] = [];
  let fallbackCalled = false;
  const ok = { ok: true };
  const sender = {
    sendText: async (text: string) => { sentTexts.push(text); return ok; },
    sendMedia: async (url: string) => { sentMediaUrls.push(url); return ok; },
    sendSticker: async () => ok,
    sendRaw: async () => ok,
    send: async () => ok,
    deliver: async () => {},
    markFallback: () => { fallbackCalled = true; },
  };
  return { sender, sentTexts, sentMediaUrls, fallbackCalled: () => fallbackCalled };
}

/**
 * Build a mock dispatchReplyWithBufferedBlockDispatcher that simulates the SDK
 * calling various replyOptions callbacks.
 */
function makeDispatcher(
  handler: (args: { deliver: any; replyOptions: any }) => Promise<void>,
) {
  return async (args: any) => {
    await handler({
      deliver: args.dispatcherOptions?.deliver,
      replyOptions: args.replyOptions,
    });
  };
}

function createDispatchCtx(overrides: Record<string, any> = {}) {
  const { sender: defaultSender } = createMockSender();
  return createMockCtx({
    isGroup: false,
    fromAccount: "user-001",
    ctxPayload: { Body: "test", SessionKey: "session-001" } as any,
    route: { agentId: "agent-001", sessionKey: "session-001", accountId: "bot-001" } as any,
    storePath: "/tmp/store" as any,
    account: { accountId: "bot-001", botId: "bot-001", disableBlockStreaming: false } as any,
    config: {} as any,
    core: {
      channel: {
        text: {
          convertMarkdownTables: (t: string) => t,
          chunkMarkdownText: (t: string, _max: number) => [t],
        },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (_args: any) => {},
        },
      },
    } as any,
    sender: defaultSender,
    ...overrides,
  });
}

// ── prerequisite checks ──────────────────────────────────────────────────────

void test("dispatch-reply: missing prerequisites -> abort pipeline", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");

  const ctx = createMockCtx({
    ctxPayload: undefined,
    route: undefined,
    storePath: undefined,
    sender: undefined,
  });
  const { next, wasCalled } = createMockNext();

  await dispatchReply.handler(ctx, next);
  assert.equal(wasCalled(), false, "should abort when prerequisites not ready");
});

// ── onPartialReply as text source ────────────────────────────────────────────

void test("dispatch-reply: onPartialReply text is sent via sender.sendText", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");
  const { sender, sentTexts } = createMockSender();

  const ctx = createDispatchCtx({
    sender,
    core: {
      channel: {
        text: {
          convertMarkdownTables: (t: string) => t,
          chunkMarkdownText: (t: string, _max: number) => [t],
        },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: makeDispatcher(async ({ deliver, replyOptions }) => {
            await replyOptions?.onPartialReply?.({ text: "你好，我是 AI" });
            // deliver called with same text (coalesced) - should be ignored for text
            await deliver?.({ text: "你好，我是 AI" }, { kind: "block" });
          }),
        },
      },
    } as any,
  });
  const { next, wasCalled } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.equal(wasCalled(), true);
  assert.equal(sentTexts.length, 1, "should send exactly one text");
  assert.ok(sentTexts[0].includes("你好，我是 AI"));
});

void test("dispatch-reply: multiple deliver calls don't duplicate text", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");
  const { sender, sentTexts } = createMockSender();

  const fullText = "complete response content";

  const ctx = createDispatchCtx({
    sender,
    core: {
      channel: {
        text: {
          convertMarkdownTables: (t: string) => t,
          chunkMarkdownText: (t: string, _max: number) => [t],
        },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: makeDispatcher(async ({ deliver, replyOptions }) => {
            await replyOptions?.onPartialReply?.({ text: fullText });
            // SDK block-streaming may call deliver multiple times with chunks
            await deliver?.({ text: "complete response" }, { kind: "block" });
            await deliver?.({ text: " content" }, { kind: "block" });
          }),
        },
      },
    } as any,
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.equal(sentTexts.length, 1, "should send exactly once despite multiple delivers");
  assert.equal(sentTexts[0], fullText);
});

// ── thinking boundary repair ─────────────────────────────────────────────────

void test("dispatch-reply: repairs spurious newline at thinking boundary", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");
  const { sender, sentTexts } = createMockSender();

  const prefix = "来一首 🦞\n\n**《闺怨》**\n\n庭前花";
  const brokenPartial = `${prefix}\n落春将暮，\n独倚栏杆。`;

  const ctx = createDispatchCtx({
    sender,
    core: {
      channel: {
        text: {
          convertMarkdownTables: (t: string) => t,
          chunkMarkdownText: (t: string, _max: number) => [t],
        },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: makeDispatcher(async ({ deliver, replyOptions }) => {
            await replyOptions?.onPartialReply?.({ text: prefix });
            await replyOptions?.onReasoningEnd?.();
            await replyOptions?.onPartialReply?.({ text: brokenPartial });
            // Later updates still contain the spurious newline from SDK
            await replyOptions?.onPartialReply?.({
              text: `${brokenPartial}\n千里江山，`,
            });
            await deliver?.({ text: brokenPartial }, { kind: "block" });
          }),
        },
      },
    } as any,
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.equal(sentTexts.length, 1);
  assert.ok(!sentTexts[0].includes("庭前花\n落春"), "mid-word newline should be removed");
  assert.ok(sentTexts[0].includes("庭前花落春"), "words should be joined");
});

// ── onToolStart flush ────────────────────────────────────────────────────────

void test("dispatch-reply: onToolStart flushes buffered text before tool call", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");
  const { sender, sentTexts } = createMockSender();

  const sentDuringTool: string[] = [];

  const ctx = createDispatchCtx({
    sender,
    core: {
      channel: {
        text: {
          convertMarkdownTables: (t: string) => t,
          chunkMarkdownText: (t: string, _max: number) => [t],
        },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: makeDispatcher(async ({ deliver, replyOptions }) => {
            await replyOptions?.onPartialReply?.({ text: "AI pre-tool text" });
            // Capture what's been sent before tool starts
            sentDuringTool.push(...sentTexts);
            await replyOptions?.onToolStart?.({ name: "search" });
            // After onToolStart, text should have been flushed
            await replyOptions?.onPartialReply?.({ text: "AI pre-tool textpost-tool text" });
            await deliver?.({ text: "post-tool text" }, { kind: "block" });
          }),
        },
      },
    } as any,
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.ok(sentTexts.length >= 1, "should have sent text");
  // After flushNow during onToolStart, text was sent; then the remainder is sent at finalize
  assert.ok(sentTexts.some(t => t.includes("AI pre-tool text")), "pre-tool text should be sent");
});

void test("dispatch-reply: tool loop sends short post-tool partials after beginNewSegment", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");
  const { sender, sentTexts } = createMockSender();

  const ctx = createDispatchCtx({
    sender,
    core: {
      channel: {
        text: {
          convertMarkdownTables: (t: string) => t,
          chunkMarkdownText: (t: string, _max: number) => [t],
        },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: makeDispatcher(async ({ replyOptions }) => {
            replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPartialReply?.({ text: "pre-tool long text" });
            await replyOptions?.onToolStart?.({ name: "sleep" });

            replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPartialReply?.({ text: "1️⃣" });
            await replyOptions?.onToolStart?.({ name: "sleep" });

            replyOptions?.onAssistantMessageStart?.();
            await replyOptions?.onPartialReply?.({ text: "2️⃣" });
            await replyOptions?.onToolStart?.({ name: "sleep" });
          }),
        },
      },
    } as any,
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.ok(sentTexts.some(t => t.includes("pre-tool long text")), "pre-tool text should be sent");
  assert.ok(sentTexts.some(t => t.includes("1️⃣")), "first post-tool partial should be sent");
  assert.ok(sentTexts.some(t => t.includes("2️⃣")), "second post-tool partial should be sent");
});

// ── deliver text fallback (no onPartialReply) ───────────────────────────────

void test("dispatch-reply: uses deliver text when no onPartialReply (SDK fallback)", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");
  const { sender, sentTexts } = createMockSender();

  const ctx = createDispatchCtx({
    sender,
    core: {
      channel: {
        text: {
          convertMarkdownTables: (t: string) => t,
          chunkMarkdownText: (t: string, _max: number) => [t],
        },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: makeDispatcher(async ({ deliver }) => {
            await deliver?.({ text: "fallback deliver text" }, { kind: "block" });
          }),
        },
      },
    } as any,
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.ok(sentTexts.some(t => t.includes("fallback deliver text")), "should use deliver text as fallback");
});

void test("dispatch-reply: deliver text ignored when onPartialReply already received", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");
  const { sender, sentTexts } = createMockSender();

  const ctx = createDispatchCtx({
    sender,
    core: {
      channel: {
        text: {
          convertMarkdownTables: (t: string) => t,
          chunkMarkdownText: (t: string, _max: number) => [t],
        },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: makeDispatcher(async ({ deliver, replyOptions }) => {
            await replyOptions?.onPartialReply?.({ text: "from partial" });
            await deliver?.({ text: "duplicate from deliver" }, { kind: "block" });
          }),
        },
      },
    } as any,
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.equal(sentTexts.filter(t => t.includes("from partial")).length, 1);
  assert.ok(!sentTexts.some(t => t.includes("duplicate from deliver")), "deliver text must not duplicate partial");
});

void test("dispatch-reply: /status deliver fallback appends bot version suffix", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");
  const { sender, sentTexts } = createMockSender();

  const ctx = createDispatchCtx({
    rawBody: "/status",
    sender,
    core: {
      channel: {
        text: {
          convertMarkdownTables: (txt: string) => txt,
          chunkMarkdownText: (txt: string, _max: number) => [txt],
        },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: makeDispatcher(async ({ deliver }) => {
            await deliver?.({ text: "运行正常" }, { kind: "block" });
          }),
        },
      },
    } as any,
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  const joined = sentTexts.join("");
  assert.ok(joined.includes("运行正常"));
  assert.ok(joined.includes("🤖 Bot: yuanbaobot("), "status suffix should append on deliver fallback");
});

void test("dispatch-reply: /status with onPartialReply does not append bot version suffix", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");
  const { sender, sentTexts } = createMockSender();

  const ctx = createDispatchCtx({
    rawBody: "/status",
    sender,
    core: {
      channel: {
        text: {
          convertMarkdownTables: (txt: string) => txt,
          chunkMarkdownText: (txt: string, _max: number) => [txt],
        },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: makeDispatcher(async ({ deliver, replyOptions }) => {
            await replyOptions?.onPartialReply?.({ text: "状态 OK" });
            await deliver?.({ text: "状态 OK" }, { kind: "block" });
          }),
        },
      },
    } as any,
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  const joined = sentTexts.join("");
  assert.ok(joined.includes("状态 OK"));
  assert.ok(!joined.includes("🤖 Bot: yuanbaobot("), "status suffix only on deliver fallback");
});

void test("dispatch-reply: /status with no partial and no deliver text skips version suffix", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");
  const { sender, sentTexts } = createMockSender();

  const ctx = createDispatchCtx({
    rawBody: "/status",
    sender,
    core: {
      channel: {
        text: {
          convertMarkdownTables: (txt: string) => txt,
          chunkMarkdownText: (txt: string, _max: number) => [txt],
        },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: makeDispatcher(async () => {
            // no onPartialReply, no deliver text
          }),
        },
      },
    } as any,
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.equal(sentTexts.length, 0);
  assert.ok(!sentTexts.some(t => t.includes("🤖 Bot: yuanbaobot(")));
});

// ── media delivery ───────────────────────────────────────────────────────────

void test("dispatch-reply: media from deliver is sent immediately", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");
  const { sender, sentTexts, sentMediaUrls } = createMockSender();

  const ctx = createDispatchCtx({
    sender,
    core: {
      channel: {
        text: {
          convertMarkdownTables: (t: string) => t,
          chunkMarkdownText: (t: string, _max: number) => [t],
        },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: makeDispatcher(async ({ deliver, replyOptions }) => {
            await replyOptions?.onPartialReply?.({ text: "看这张图" });
            await deliver?.({ text: "看这张图", mediaUrls: ["https://example.com/img.jpg"] }, { kind: "block" });
          }),
        },
      },
    } as any,
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.ok(sentTexts.some(t => t.includes("看这张图")), "text should be sent");
  assert.ok(sentMediaUrls.includes("https://example.com/img.jpg"), "media URL should be sent");
});

void test("dispatch-reply: tool-kind deliver does not send text", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");
  const { sender, sentTexts } = createMockSender();

  const ctx = createDispatchCtx({
    sender,
    core: {
      channel: {
        text: {
          convertMarkdownTables: (t: string) => t,
          chunkMarkdownText: (t: string, _max: number) => [t],
        },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: makeDispatcher(async ({ deliver, replyOptions }) => {
            await deliver?.({ text: "tool result" }, { kind: "tool" });
            await replyOptions?.onPartialReply?.({ text: "最终回复" });
            await deliver?.({ text: "最终回复" }, { kind: "block" });
          }),
        },
      },
    } as any,
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.ok(!sentTexts.some(t => t.includes("tool result")), "tool text should not be sent");
  assert.ok(sentTexts.some(t => t.includes("最终回复")), "block text should be sent");
});

// ── fallback reply ───────────────────────────────────────────────────────────

void test("dispatch-reply: AI returns nothing + has fallbackReply -> send fallback", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");
  const { sender, sentTexts } = createMockSender();

  const ctx = createDispatchCtx({
    account: {
      accountId: "bot-001",
      botId: "bot-001",
      disableBlockStreaming: false,
      fallbackReply: "我暂时无法回答",
    },
    sender,
    core: {
      channel: {
        text: {
          convertMarkdownTables: (t: string) => t,
          chunkMarkdownText: (t: string, _max: number) => [t],
        },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: makeDispatcher(async () => {
            // No callbacks, no content
          }),
        },
      },
    } as any,
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.ok(sentTexts.includes("我暂时无法回答"), "should send fallback reply");
});

void test("dispatch-reply: delivered via action -> no fallback reply", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");
  const { sender, sentTexts } = createMockSender();

  const ctx = createDispatchCtx({
    account: {
      accountId: "bot-001",
      botId: "bot-001",
      disableBlockStreaming: false,
      fallbackReply: "我暂时无法回答",
    },
    traceContext: {
      traceId: "t-1",
      traceparent: "00-x-y-01",
      nextMsgSeq: () => undefined,
      markActionDelivered: () => {},
      hasActionDelivered: () => true,
    },
    sender,
    core: {
      channel: {
        text: {
          convertMarkdownTables: (t: string) => t,
          chunkMarkdownText: (t: string, _max: number) => [t],
        },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: makeDispatcher(async () => {}),
        },
      },
    } as any,
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.ok(!sentTexts.includes("我暂时无法回答"), "should not send fallback when delivered via action");
});

// ── incomplete-turn false-positive suppression ──────────────────────────────

void test("dispatch-reply: incomplete-turn warning suppression gated by action delivery", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");

  const warning = "⚠️ Agent couldn't generate a response. Note: some tool actions may have already been executed — please verify before retrying.";

  const cases = [
    { name: "suppressed when action already delivered", actionDelivered: true, expectSent: false },
    { name: "surfaced when no action delivered", actionDelivered: false, expectSent: true },
  ] as const;

  for (const c of cases) {
    const { sender, sentTexts } = createMockSender();
    const ctx = createDispatchCtx({
      account: {
        accountId: "bot-001",
        botId: "bot-001",
        disableBlockStreaming: false,
        fallbackReply: "我暂时无法回答",
      },
      traceContext: {
        traceId: "t-1",
        traceparent: "00-x-y-01",
        nextMsgSeq: () => undefined,
        markActionDelivered: () => {},
        hasActionDelivered: () => c.actionDelivered,
      },
      sender,
      core: {
        channel: {
          text: {
            convertMarkdownTables: (txt: string) => txt,
            chunkMarkdownText: (txt: string, _max: number) => [txt],
          },
          session: { recordInboundSession: async () => {} },
          reply: {
            dispatchReplyWithBufferedBlockDispatcher: makeDispatcher(async ({ deliver }) => {
              // Core emits the incomplete-turn payload after an empty post-tool stop.
              await deliver?.({ text: warning, isError: true }, { kind: "block" });
            }),
          },
        },
      } as any,
    });
    const { next } = createMockNext();

    await dispatchReply.handler(ctx, next);

    const sent = sentTexts.some(s => s.includes("Agent couldn't generate a response"));
    assert.equal(sent, c.expectSent, c.name);
  }
});

// ── error handling ───────────────────────────────────────────────────────────

void test("dispatch-reply: dispatch error propagates", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");
  const { sender } = createMockSender();

  const ctx = createDispatchCtx({
    sender,
    core: {
      channel: {
        text: {
          convertMarkdownTables: (t: string) => t,
          chunkMarkdownText: (t: string, _max: number) => [t],
        },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async () => {
            throw new Error("dispatch error");
          },
        },
      },
    } as any,
  });
  const { next } = createMockNext();

  await assert.rejects(() => dispatchReply.handler(ctx, next), { message: "dispatch error" });
});
