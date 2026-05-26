/**
 * Unit tests for resolve-quote middleware: quote parsing, desc enrichment, and formatting.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

/** Shared proxy Map — tests mutate via clear()/set() so the same instance
 *  is always visible through the module mock (both resolve-quote.ts and quote.ts
 *  import from chat-history.js, which gets this single mock). */
const mockMediaHistories = new Map<string, Array<{ sender: string; messageId?: string; timestamp: number; medias: Array<{ url: string; mediaName?: string }> }>>();

let mockRegistered = false;

function setupMocks(t: any, opts?: { mediaHistories?: Map<string, any> }) {
  mockMediaHistories.clear();
  if (opts?.mediaHistories) {
    for (const [k, v] of opts.mediaHistories) {
      mockMediaHistories.set(k, v);
    }
  }
  if (!mockRegistered) {
    t.mock.module("../../messaging/chat-history.js", {
      namedExports: {
        chatHistories: new Map(),
        chatMediaHistories: mockMediaHistories,
        deriveChatKey: (isGroup: boolean, groupCode?: string, fromAccount?: string) => {
          if (isGroup && groupCode) { return `group:${groupCode}`; }
          return `direct:${fromAccount ?? "unknown"}`;
        },
        recordMediaHistory: () => {},
      },
    });
    mockRegistered = true;
  }
}

function makeCloudData(quote: Record<string, unknown>): string {
  return JSON.stringify({ quote });
}

void test("resolve-quote: populates ctx.quoteInfo when quote exists", async (t) => {
  setupMocks(t);
  const { resolveQuote } = await import("./resolve-quote.js");

  const ctx = createMockCtx({
    raw: { cloud_custom_data: makeCloudData({ id: "msg-1", desc: "被引用的内容", sender_nickname: "张三" }) } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveQuote.handler(ctx, next);

  assert.equal(ctx.quoteInfo!.desc, "被引用的内容");
  assert.equal(wasCalled(), true);
});

void test("resolve-quote: quoteInfo stays undefined when no quote", async (t) => {
  setupMocks(t);
  const { resolveQuote } = await import("./resolve-quote.js");

  const ctx = createMockCtx({});
  const { next, wasCalled } = createMockNext();

  await resolveQuote.handler(ctx, next);

  assert.equal(ctx.quoteInfo, undefined);
  assert.equal(wasCalled(), true);
});

void test("resolve-quote: empty cloud_custom_data passes through", async (t) => {
  setupMocks(t);
  const { resolveQuote } = await import("./resolve-quote.js");

  const ctx = createMockCtx({
    raw: { cloud_custom_data: undefined } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveQuote.handler(ctx, next);

  assert.equal(wasCalled(), true);
});

void test("resolve-quote: resolves image quote desc from LRU with actual filenames", async (t) => {
  const histories = new Map();
  histories.set("group:group-001", [
    {
      sender: "user-001",
      messageId: "quoted-msg-1",
      timestamp: Date.now(),
      medias: [
        { url: "https://example.com/a.jpg", mediaName: "abc_720_1793.jpeg" },
        { url: "https://example.com/b.jpg", mediaName: "def_400_300.png" },
      ],
    },
  ]);
  setupMocks(t, { mediaHistories: histories });
  const { resolveQuote } = await import("./resolve-quote.js");

  const ctx = createMockCtx({
    isGroup: true,
    groupCode: "group-001" as any,
    fromAccount: "user-002",
    raw: { cloud_custom_data: makeCloudData({ id: "quoted-msg-1", type: 2, desc: "", sender_nickname: "用户" }) } as any,
  });
  const { next } = createMockNext();

  await resolveQuote.handler(ctx, next);

  assert.equal(ctx.quoteInfo!.desc, "[image:abc_720_1793.jpeg][image:def_400_300.png]");
});

void test("resolve-quote: resolves file quote desc from LRU", async (t) => {
  const histories = new Map();
  histories.set("direct:user-001", [
    {
      sender: "user-001",
      messageId: "quoted-file-msg",
      timestamp: Date.now(),
      medias: [
        { url: "https://example.com/doc.pdf", mediaName: "报告.pdf" },
      ],
    },
  ]);
  setupMocks(t, { mediaHistories: histories });
  const { resolveQuote } = await import("./resolve-quote.js");

  const ctx = createMockCtx({
    isGroup: false,
    fromAccount: "user-001",
    raw: { cloud_custom_data: makeCloudData({ id: "quoted-file-msg", type: 3, desc: "", sender_nickname: "用户" }) } as any,
  });
  const { next } = createMockNext();

  await resolveQuote.handler(ctx, next);

  assert.equal(ctx.quoteInfo!.desc, "[file:报告.pdf]");
});

void test("resolve-quote: falls back to generic [image] when LRU has no data", async (t) => {
  setupMocks(t);
  const { resolveQuote } = await import("./resolve-quote.js");

  const ctx = createMockCtx({
    isGroup: true,
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    raw: { cloud_custom_data: makeCloudData({ id: "old-msg", type: 2, desc: "", sender_nickname: "用户" }) } as any,
  });
  const { next } = createMockNext();

  await resolveQuote.handler(ctx, next);

  assert.equal(ctx.quoteInfo!.desc, "[image]");
});

void test("resolve-quote: keeps original desc when quote has text", async (t) => {
  setupMocks(t);
  const { resolveQuote } = await import("./resolve-quote.js");

  const ctx = createMockCtx({
    raw: { cloud_custom_data: makeCloudData({ id: "msg-1", desc: "用户写的文字", sender_nickname: "张三" }) } as any,
  });
  const { next } = createMockNext();

  await resolveQuote.handler(ctx, next);

  assert.equal(ctx.quoteInfo!.desc, "用户写的文字");
});

void test("resolve-quote: empty desc + unknown type → quoteInfo is undefined", async (t) => {
  setupMocks(t);
  const { resolveQuote } = await import("./resolve-quote.js");

  const ctx = createMockCtx({
    raw: { cloud_custom_data: makeCloudData({ id: "msg-1", type: 99, desc: "" }) } as any,
  });
  const { next } = createMockNext();

  await resolveQuote.handler(ctx, next);

  assert.equal(ctx.quoteInfo, undefined);
});
