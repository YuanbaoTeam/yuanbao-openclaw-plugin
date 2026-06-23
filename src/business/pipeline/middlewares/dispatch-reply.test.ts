/**
 * Unit tests for dispatch-reply middleware: AI reply dispatch, prerequisite checks, deliver callbacks, error handling.
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
          stop: () => {},
        }),
      },
    });
    mockRegistered = true;
  }
}

/**
 * Create dispatch-reply specific mock ctx.
 *
 * deliverPayloads: simulated AI reply block list
 * shouldThrow: simulate dispatchReplyWithBufferedBlockDispatcher throwing
 */
function createDispatchCtx(overrides: Record<string, any> = {}) {
  const deliverPayloads: Array<{ text?: string; mediaUrls?: string[]; kind?: string }> =
    overrides._deliverPayloads ?? [];
  const shouldThrow = overrides._shouldThrow ?? false;

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
        text: { convertMarkdownTables: (t: string) => t },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (args: any) => {
            if (shouldThrow) {
              throw new Error("dispatch error");
            }
            // Simulate calling deliver callback
            const deliver = args.dispatcherOptions?.deliver;
            if (deliver) {
              for (const p of deliverPayloads) {
                await deliver(
                  { text: p.text ?? "", mediaUrls: p.mediaUrls ?? [] },
                  { kind: p.kind ?? "block" },
                );
              }
            }
          },
        },
      },
    } as any,
    sender: { sendText: async () => {} } as any,
    queueSession: {
      push: async () => {},
      flush: async () => true,
      abort: () => {},
    } as any,
    ...overrides,
    // Do not pass internal control fields into ctx
  });
}

void test("dispatch-reply: prerequisite middleware not ready -> abort pipeline", async (t) => {
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");

  const ctx = createMockCtx({
    ctxPayload: undefined,
    route: undefined,
    storePath: undefined,
    sender: undefined,
    queueSession: undefined,
  });
  const { next, wasCalled } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.equal(wasCalled(), false, "should abort when prerequisites not ready");
});

void test("dispatch-reply: normal reply - deliver text", async (t) => {
  const pushedItems: any[] = [];
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");

  const ctx = createDispatchCtx({
    _deliverPayloads: [{ text: "你好，我是 AI" }],
    queueSession: {
      push: async (item: any) => {
        pushedItems.push(item);
      },
      flush: async () => true,
      abort: () => {},
    },
  });
  const { next, wasCalled } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.equal(wasCalled(), true);
  assert.ok(pushedItems.length > 0, "should have pushed items");
  assert.equal(pushedItems[0].type, "text");
  assert.ok(pushedItems[0].text.includes("你好，我是 AI"));
});

void test("dispatch-reply: AI returns nothing + has fallbackReply -> send fallback", async (t) => {
  let sentFallback = false;
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");

  const ctx = createDispatchCtx({
    _deliverPayloads: [],
    account: {
      accountId: "bot-001",
      botId: "bot-001",
      disableBlockStreaming: false,
      fallbackReply: "我暂时无法回答",
    },
    sender: {
      sendText: async (text: string) => {
        sentFallback = text === "我暂时无法回答";
      },
    },
    queueSession: {
      push: async () => {},
      flush: async () => false,
      abort: () => {},
    },
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.equal(sentFallback, true, "should send fallback reply");
});

void test("dispatch-reply: AI returns nothing but delivered via action -> no fallback", async (t) => {
  let sentFallback = false;
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");

  const ctx = createDispatchCtx({
    _deliverPayloads: [],
    account: {
      accountId: "bot-001",
      botId: "bot-001",
      disableBlockStreaming: false,
      fallbackReply: "我暂时无法回答",
    },
    // Simulate a sticker/react reply delivered via handleAction (bypasses queueSession),
    // which marks the trace context within the agent run.
    traceContext: {
      traceId: "t-1",
      traceparent: "00-x-y-01",
      nextMsgSeq: () => undefined,
      markActionDelivered: () => {},
      hasActionDelivered: () => true,
    },
    sender: {
      sendText: async () => {
        sentFallback = true;
      },
    },
    queueSession: {
      push: async () => {},
      flush: async () => false,
      abort: () => {},
    },
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  assert.equal(sentFallback, false, "should not send fallback when delivered via action");
});

void test("dispatch-reply: dispatch error -> abort queue and throw", async (t) => {
  let aborted = false;
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");

  const ctx = createDispatchCtx({
    _shouldThrow: true,
    queueSession: {
      push: async () => {},
      flush: async () => false,
      abort: () => {
        aborted = true;
      },
    },
  });
  const { next } = createMockNext();

  await assert.rejects(() => dispatchReply.handler(ctx, next), { message: "dispatch error" });

  assert.equal(aborted, true, "should abort queue on error");
});

void test("dispatch-reply: deliver contains media URLs", async (t) => {
  const pushedItems: any[] = [];
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");

  const ctx = createDispatchCtx({
    _deliverPayloads: [{ text: "看这张图", mediaUrls: ["https://example.com/img.jpg"] }],
    queueSession: {
      push: async (item: any) => {
        pushedItems.push(item);
      },
      flush: async () => true,
      abort: () => {},
    },
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  const mediaItems = pushedItems.filter((i) => i.type === "media");
  assert.ok(mediaItems.length > 0, "should have pushed media items");
  assert.equal(mediaItems[0].mediaUrl, "https://example.com/img.jpg");
});

void test("dispatch-reply: tool-kind deliver is not sent to user", async (t) => {
  const pushedItems: any[] = [];
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");

  const ctx = createDispatchCtx({
    _deliverPayloads: [
      { text: "tool result", kind: "tool" },
      { text: "最终回复", kind: "block" },
    ],
    queueSession: {
      push: async (item: any) => {
        pushedItems.push(item);
      },
      flush: async () => true,
      abort: () => {},
    },
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  const textItems = pushedItems.filter((i) => i.type === "text");
  assert.equal(textItems.length, 1, "only block kind should be pushed");
  assert.equal(textItems[0].text, "\n\n最终回复", "text after tool call should be paragraph-separated");
});

void test("dispatch-reply: skips duplicate block deliver when partial stream is active", async (t) => {
  const pushedItems: any[] = [];
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");

  const ctx = createDispatchCtx({
    core: {
      channel: {
        text: { convertMarkdownTables: (text: string) => text },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (args: any) => {
            await args.replyOptions?.onPartialReply?.({ text: "full html page content" });
            const deliver = args.dispatcherOptions?.deliver;
            await deliver?.({ text: "<div>chunk one" }, { kind: "block" });
            await deliver?.({ text: "<div>chunk two tail" }, { kind: "block" });
          },
        },
      },
    } as any,
    queueSession: {
      push: async (item: any) => {
        pushedItems.push(item);
      },
      flush: async () => true,
      abort: () => {},
    },
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  const textItems = pushedItems.filter((i) => i.type === "text");
  assert.equal(textItems.length, 1);
  assert.equal(textItems[0].text, "full html page content");
});

void test("dispatch-reply: repairs spurious newline in onPartialReply after onReasoningEnd", async (t) => {
  const pushedItems: any[] = [];
  setupMocks(t);
  const { dispatchReply } = await import("./dispatch-reply.js");

  const prefix = "来一首不一样的 🦞\n\n---\n\n**《闺怨》**\n\n庭前花";
  const sdkPartialAfterReasoning = `${prefix}\n落春将暮，\n独倚栏杆望归路。`;
  const expectedText = `${prefix}落春将暮，\n独倚栏杆望归路。`;
  const sdkPartialLater = `${sdkPartialAfterReasoning}\n千里江山云缥缈，`;
  const expectedLater = `${expectedText}\n千里江山云缥缈，`;
  const coalescedDeliverText = `${prefix}\n\n落春将暮，\n独倚栏杆望归路。\n千里江山云缥缈，`;

  const ctx = createDispatchCtx({
    core: {
      channel: {
        text: { convertMarkdownTables: (text: string) => text },
        session: { recordInboundSession: async () => {} },
        reply: {
          dispatchReplyWithBufferedBlockDispatcher: async (args: any) => {
            await args.replyOptions?.onPartialReply?.({ text: prefix });
            await args.replyOptions?.onReasoningEnd?.();
            await args.replyOptions?.onPartialReply?.({ text: sdkPartialAfterReasoning });
            await args.replyOptions?.onPartialReply?.({ text: sdkPartialLater });
            const deliver = args.dispatcherOptions?.deliver;
            await deliver?.({ text: coalescedDeliverText }, { kind: "block" });
          },
        },
      },
    } as any,
    queueSession: {
      push: async (item: any) => {
        pushedItems.push(item);
      },
      flush: async () => true,
      abort: () => {},
    },
  });
  const { next } = createMockNext();

  await dispatchReply.handler(ctx, next);

  const textItems = pushedItems.filter((i) => i.type === "text");
  assert.equal(textItems.length, 1);
  assert.equal(textItems[0].text, expectedLater);
  assert.ok(!textItems[0].text.includes("庭前花\n落春"));
  assert.ok(!textItems[0].text.includes("庭前花\n\n落春"));
});
