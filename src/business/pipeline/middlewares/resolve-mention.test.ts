/**
 * Unit tests for resolve-mention middleware: @detection guard and when condition.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

let mockGatingResult = { effectiveWasMentioned: false, shouldSkip: false };

/** Captures the last entry passed to recordPendingHistoryEntryIfEnabled. */
let lastRecordEntry: { entry?: { sender?: string; body?: string } } | null = null;

function setupMocks(
  t: any,
  overrides?: {
    gatingResult?: { effectiveWasMentioned: boolean; shouldSkip: boolean };
  },
) {
  mockGatingResult = overrides?.gatingResult ?? { effectiveWasMentioned: false, shouldSkip: false };
  lastRecordEntry = null;
  t.mock.module("openclaw/plugin-sdk/channel-inbound", {
    namedExports: {
      resolveInboundMentionDecision: () => ({ ...mockGatingResult }),
      logInboundDrop: () => {},
    },
  });
  t.mock.module("openclaw/plugin-sdk/reply-history", {
    namedExports: {
      recordPendingHistoryEntryIfEnabled: (opts: any) => { lastRecordEntry = opts; },
    },
  });
  t.mock.module("../../messaging/chat-history.js", {
    namedExports: {
      chatHistories: new Map(),
      deriveChatKey: (isGroup: boolean, groupCode?: string, fromAccount?: string) => {
        if (isGroup && groupCode) { return `group:${groupCode}`; }
        return `direct:${fromAccount ?? "unknown"}`;
      },
      recordMediaHistory: () => {},
    },
  });
}

void test("resolve-mention: when guard - executes in group chat", async (t) => {
  setupMocks(t);
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({ isGroup: true });
  assert.equal(resolveMention.when!(ctx), true);
});

void test("resolve-mention: when guard - skips in C2C", async (t) => {
  setupMocks(t);
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({ isGroup: false });
  assert.equal(resolveMention.when!(ctx), false);
});

void test("resolve-mention: @bot message -> pass through", async (t) => {
  setupMocks(t, {
    gatingResult: { effectiveWasMentioned: true, shouldSkip: false },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: true,
    account: {
      botId: "bot-001",
      accountId: "bot-001",
      requireMention: true,
      historyLimit: 10,
    } as any,
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
      },
    } as any,
    config: {} as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(ctx.effectiveWasMentioned, true);
  assert.equal(wasCalled(), true);
});

void test("resolve-mention: non-@bot message -> abort pipeline", async (t) => {
  setupMocks(t, {
    gatingResult: { effectiveWasMentioned: false, shouldSkip: true },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    groupCode: "group-001" as any,
    rawBody: "normal group message",
    fromAccount: "user-001",
    medias: [],
    account: {
      botId: "bot-001",
      accountId: "bot-001",
      requireMention: true,
      historyLimit: 10,
    } as any,
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
      },
    } as any,
    config: {} as any,
    raw: { msg_id: "msg-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(wasCalled(), false, "non-@bot should abort pipeline");
});

void test("resolve-mention: command bypasses @detection -> pass through", async (t) => {
  setupMocks(t, {
    gatingResult: { effectiveWasMentioned: false, shouldSkip: false },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    hasControlCommand: true,
    commandAuthorized: true,
    account: {
      botId: "bot-001",
      accountId: "bot-001",
      requireMention: true,
      historyLimit: 0,
    } as any,
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
      },
    } as any,
    config: {} as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(wasCalled(), true, "command should bypass @detection");
});

void test("resolve-mention: non-@bot group message records senderLabel (nickname + id) in history body", async (t) => {
  setupMocks(t, {
    gatingResult: { effectiveWasMentioned: false, shouldSkip: true },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    groupCode: "group-001" as any,
    rawBody: "我叫小明",
    fromAccount: "user-001",
    senderNickname: "小明",
    medias: [],
    account: {
      botId: "bot-001",
      accountId: "bot-001",
      requireMention: true,
      historyLimit: 10,
    } as any,
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
      },
    } as any,
    config: {} as any,
    raw: { msg_id: "msg-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(wasCalled(), false, "non-@bot should abort pipeline");
  assert.ok(lastRecordEntry, "history entry should be recorded");
  // Body must surface both nickname and id so the agent can tell members apart
  // in the shared group history.
  assert.match(lastRecordEntry!.entry!.body!, /小明 \(user-001\): 我叫小明/);
});

void test("resolve-mention: non-@bot group message falls back to fromAccount when nickname is absent", async (t) => {
  setupMocks(t, {
    gatingResult: { effectiveWasMentioned: false, shouldSkip: true },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    groupCode: "group-002" as any,
    rawBody: "hi",
    fromAccount: "user-002",
    senderNickname: undefined,
    medias: [],
    account: {
      botId: "bot-001",
      accountId: "bot-001",
      requireMention: true,
      historyLimit: 10,
    } as any,
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
      },
    } as any,
    config: {} as any,
    raw: { msg_id: "msg-002" } as any,
  });
  const { next } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.ok(lastRecordEntry, "history entry should be recorded");
  // No nickname -> body uses fromAccount only, no empty parens.
  assert.equal(lastRecordEntry!.entry!.body, "user-002: hi");
});
