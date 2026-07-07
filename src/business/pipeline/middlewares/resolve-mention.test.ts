/**
 * Unit tests for resolve-mention middleware — 4-layer reply decision:
 *   L0 mute → L1 @mention → L2 topic self-judge → L3 default gating.
 *
 * Every test asserts BOTH the flow control (next called / not called) AND
 * `ctx.replyDecision.source` so future regressions can't silently downgrade
 * a message to the wrong decision layer.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

// ─── Module mocks (shared state; setup once, per-test overrides via lets) ───

let mockGatingResult = { effectiveWasMentioned: false, shouldSkip: false };
let mockJudgeResult: { shouldReply: boolean; reason: string } = {
  shouldReply: false,
  reason: "no soul rules",
};
let mockJudgeCalls: Array<{ topicId: string; rawBody: string; soul: string }> = [];
let mockSoulByTopic: Record<string, string> = {};
let mockRecordedHistory: Array<{ historyKey: string; body: string }> = [];
let mockDropReasons: string[] = [];

let mockRegistered = false;

function setupMocks(
  t: any,
  overrides?: {
    gatingResult?: { effectiveWasMentioned: boolean; shouldSkip: boolean };
    judgeResult?: { shouldReply: boolean; reason: string };
    soulByTopic?: Record<string, string>;
  },
) {
  mockGatingResult = overrides?.gatingResult ?? { effectiveWasMentioned: false, shouldSkip: false };
  mockJudgeResult = overrides?.judgeResult ?? { shouldReply: false, reason: "no soul rules" };
  mockSoulByTopic = overrides?.soulByTopic ?? {};
  mockJudgeCalls = [];
  mockRecordedHistory = [];
  mockDropReasons = [];

  if (!mockRegistered) {
    t.mock.module("openclaw/plugin-sdk/channel-inbound", {
      namedExports: {
        resolveMentionGatingWithBypass: () => ({ ...mockGatingResult }),
        logInboundDrop: (opts: { reason: string }) => {
          mockDropReasons.push(opts.reason);
        },
      },
    });
    t.mock.module("openclaw/plugin-sdk/reply-history", {
      namedExports: {
        recordPendingHistoryEntryIfEnabled: (opts: { historyKey: string; entry: { body: string } }) => {
          mockRecordedHistory.push({ historyKey: opts.historyKey, body: opts.entry.body });
        },
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
    t.mock.module("../topic-judge/soul-loader.js", {
      namedExports: {
        loadSoulForTopic: async (topicId: string) => mockSoulByTopic[topicId] ?? "",
      },
    });
    t.mock.module("../topic-judge/index.js", {
      namedExports: {
        shouldBotReplyInTopic: async (input: { topicId: string; rawBody: string; soul: string }) => {
          mockJudgeCalls.push({ topicId: input.topicId, rawBody: input.rawBody, soul: input.soul });
          return { ...mockJudgeResult };
        },
      },
    });
    mockRegistered = true;
  }
}

// ─── Fixtures ────────────────────────────────────────────────────────────

const baseAccount = {
  botId: "bot-001",
  accountId: "bot-001",
  requireMention: true,
  historyLimit: 10,
  config: {},
} as any;

const baseCore = {
  channel: {
    commands: { shouldHandleTextCommands: () => true },
  },
} as any;

function makeCloudCustomData(payload: Record<string, unknown>): string {
  return JSON.stringify(payload);
}

// ─── L0: Muted ───────────────────────────────────────────────────────────

void test("resolve-mention L0: botMuted=true → skip even without @", async (t) => {
  setupMocks(t);
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    groupCode: "group-1" as any,
    rawBody: "hi",
    fromAccount: "user-1",
    account: baseAccount,
    core: baseCore,
    config: {} as any,
    raw: { msg_id: "m-1", cloud_custom_data: makeCloudCustomData({ topicId: "t-1", botMuted: true }) } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(wasCalled(), false, "muted must abort pipeline");
  assert.equal(ctx.isMuted, true);
  assert.equal(ctx.replyDecision?.source, "mute");
  assert.equal(ctx.replyDecision?.shouldReply, false);
  assert.equal(ctx.topicId, "t-1");
  assert.equal(mockRecordedHistory.length, 1, "muted still records to history");
  assert.deepEqual(mockDropReasons, ["muted"]);
});

void test("resolve-mention L0: botMuted=true overrides explicit @ (mute wins over mention)", async (t) => {
  setupMocks(t);
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: true, // user @'d the bot, but topic is muted → still no reply
    groupCode: "group-1" as any,
    rawBody: "@bot help",
    fromAccount: "user-1",
    account: baseAccount,
    core: baseCore,
    config: {} as any,
    raw: { msg_id: "m-2", cloud_custom_data: makeCloudCustomData({ topicId: "t-1", botMuted: true }) } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(wasCalled(), false, "mute must beat @mention");
  assert.equal(ctx.replyDecision?.source, "mute");
  assert.equal(mockJudgeCalls.length, 0, "topic-judge should NOT run when muted");
});

void test("resolve-mention L0: soul.md `## Muted true` → skip (even without cloud botMuted)", async (t) => {
  setupMocks(t, {
    soulByTopic: { "t-muted": "## Reply Rules\n- keyword: hi\n\n## Muted\ntrue\n" },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    groupCode: "group-1" as any,
    rawBody: "hi",
    fromAccount: "user-1",
    account: baseAccount,
    core: baseCore,
    config: {} as any,
    raw: { msg_id: "m-mute-soul", cloud_custom_data: makeCloudCustomData({ topicId: "t-muted" }) } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(wasCalled(), false, "soul-level mute must abort pipeline");
  assert.equal(ctx.isMuted, true);
  assert.equal(ctx.replyDecision?.source, "mute");
  assert.equal(ctx.replyDecision?.reason, "muted (source: soul)");
  assert.deepEqual(mockDropReasons, ["muted"]);
  assert.equal(mockJudgeCalls.length, 0, "muted topic must not invoke judge");
});

void test("resolve-mention L0: soul.md muted overrides explicit @mention", async (t) => {
  setupMocks(t, {
    soulByTopic: { "t-muted": "## Muted\ntrue\n" },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: true,
    groupCode: "group-1" as any,
    rawBody: "@bot hi",
    fromAccount: "user-1",
    account: baseAccount,
    core: baseCore,
    config: {} as any,
    raw: { msg_id: "m-mute-soul-at", cloud_custom_data: makeCloudCustomData({ topicId: "t-muted" }) } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(wasCalled(), false, "soul mute must beat @mention");
  assert.equal(ctx.replyDecision?.source, "mute");
  assert.equal(ctx.replyDecision?.reason, "muted (source: soul)");
});

void test("resolve-mention L0: soul.md `## Muted false` → does NOT mute, L2 runs normally", async (t) => {
  setupMocks(t, {
    judgeResult: { shouldReply: false, reason: "no rule matched" },
    soulByTopic: { "t-live": "## Reply Rules\n- keyword: 报名\n\n## Muted\nfalse\n" },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    groupCode: "group-1" as any,
    rawBody: "闲聊",
    fromAccount: "user-1",
    account: baseAccount,
    core: baseCore,
    config: {} as any,
    raw: { msg_id: "m-mute-false", cloud_custom_data: makeCloudCustomData({ topicId: "t-live" }) } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(ctx.isMuted, undefined, "false Muted flag must not mute");
  assert.equal(ctx.replyDecision?.source, "topic-judge", "L2 must run when soul is not muted");
  assert.equal(wasCalled(), false, "judge=false still aborts, but at L2 not L0");
  assert.equal(mockJudgeCalls.length, 1);
});

void test("resolve-mention L0: cloud+soul both muted → reason marks both sources", async (t) => {
  setupMocks(t, {
    soulByTopic: { "t-dual": "## Muted\ntrue\n" },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    groupCode: "group-1" as any,
    rawBody: "hi",
    fromAccount: "user-1",
    account: baseAccount,
    core: baseCore,
    config: {} as any,
    raw: { msg_id: "m-mute-dual", cloud_custom_data: makeCloudCustomData({ topicId: "t-dual", botMuted: true }) } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(wasCalled(), false);
  assert.equal(ctx.replyDecision?.source, "mute");
  assert.equal(ctx.replyDecision?.reason, "muted (source: cloud+soul)");
});

// ─── L1: Explicit @bot ────────────────────────────────────────────────────

void test("resolve-mention L1: @bot without topic → pass through (default-gating not consulted)", async (t) => {
  setupMocks(t);
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: true,
    account: baseAccount,
    core: baseCore,
    config: {} as any,
    raw: { msg_id: "m-3" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(wasCalled(), true);
  assert.equal(ctx.effectiveWasMentioned, true);
  assert.equal(ctx.replyDecision?.source, "at-mention");
  assert.equal(ctx.replyDecision?.shouldReply, true);
});

void test("resolve-mention L1: @bot with topic → still pass through (topic-judge skipped)", async (t) => {
  setupMocks(t);
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: true,
    account: baseAccount,
    core: baseCore,
    config: {} as any,
    raw: { msg_id: "m-4", cloud_custom_data: makeCloudCustomData({ topicId: "t-1" }) } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(wasCalled(), true);
  assert.equal(ctx.topicId, "t-1");
  assert.equal(ctx.replyDecision?.source, "at-mention");
  assert.equal(mockJudgeCalls.length, 0, "@mention short-circuits topic-judge");
});

// ─── L2: Topic self-judge ─────────────────────────────────────────────────

void test("resolve-mention L2: topic + no @ + judge=true → pass through with implicit mention", async (t) => {
  setupMocks(t, {
    judgeResult: { shouldReply: true, reason: "matched rule: keyword:报名" },
    soulByTopic: { "t-42": "## Reply Rules\n- keyword: 报名" },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    groupCode: "group-1" as any,
    rawBody: "我要报名活动",
    fromAccount: "user-42",
    senderNickname: "小明",
    account: { ...baseAccount, config: { topicSoulDir: "/tmp/souls" } },
    core: baseCore,
    config: {} as any,
    raw: { msg_id: "m-5", cloud_custom_data: makeCloudCustomData({ topicId: "t-42" }) } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(wasCalled(), true, "judge=true should invoke next()");
  assert.equal(ctx.effectiveWasMentioned, true, "L2 pass should set effectiveWasMentioned as implicit mention");
  assert.equal(ctx.replyDecision?.source, "topic-judge");
  assert.equal(ctx.replyDecision?.shouldReply, true);
  assert.equal(mockJudgeCalls.length, 1);
  assert.equal(mockJudgeCalls[0].topicId, "t-42");
  assert.equal(mockJudgeCalls[0].soul, "## Reply Rules\n- keyword: 报名");
});

void test("resolve-mention L2: topic + no @ + judge=false → skip + record history + log", async (t) => {
  setupMocks(t, {
    judgeResult: { shouldReply: false, reason: "no rule matched" },
    soulByTopic: { "t-42": "## Reply Rules\n- keyword: 报名" },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    groupCode: "group-1" as any,
    rawBody: "闲聊几句",
    fromAccount: "user-42",
    account: baseAccount,
    core: baseCore,
    config: {} as any,
    raw: { msg_id: "m-6", cloud_custom_data: makeCloudCustomData({ topicId: "t-42" }) } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(wasCalled(), false, "judge=false must abort");
  assert.equal(ctx.replyDecision?.source, "topic-judge");
  assert.equal(ctx.replyDecision?.shouldReply, false);
  assert.equal(ctx.replyDecision?.reason, "no rule matched");
  assert.equal(mockRecordedHistory.length, 1, "L2 skip records to history");
  assert.deepEqual(mockDropReasons, ["topic-judge"]);
});

void test("resolve-mention L2: soul missing → judge returns shouldReply=false → skip", async (t) => {
  setupMocks(t, {
    judgeResult: { shouldReply: false, reason: "no soul rules" },
    soulByTopic: {}, // t-99 has no soul.md
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    groupCode: "group-1" as any,
    rawBody: "anything",
    fromAccount: "user-99",
    account: baseAccount,
    core: baseCore,
    config: {} as any,
    raw: { msg_id: "m-7", cloud_custom_data: makeCloudCustomData({ topicId: "t-99" }) } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(wasCalled(), false);
  assert.equal(ctx.replyDecision?.reason, "no soul rules");
  assert.equal(mockJudgeCalls[0].soul, "", "loader returns empty string for missing soul");
});

// ─── L3: Default gating (legacy path) ─────────────────────────────────────

void test("resolve-mention L3: no topic + no @ + gating skip → abort with mention-gating reason", async (t) => {
  setupMocks(t, {
    gatingResult: { effectiveWasMentioned: false, shouldSkip: true },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    groupCode: "group-1" as any,
    rawBody: "normal group chatter",
    fromAccount: "user-1",
    medias: [],
    account: baseAccount,
    core: baseCore,
    config: {} as any,
    raw: { msg_id: "m-8" } as any, // no cloud_custom_data
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(wasCalled(), false);
  assert.equal(ctx.replyDecision?.source, "default-gating");
  assert.equal(ctx.replyDecision?.shouldReply, false);
  assert.equal(ctx.topicId, undefined);
  assert.deepEqual(mockDropReasons, ["mention-gating"]);
  assert.equal(mockJudgeCalls.length, 0, "no topic → judge not called");
});

void test("resolve-mention L3: command bypass (no topic, no @) → pass through", async (t) => {
  setupMocks(t, {
    gatingResult: { effectiveWasMentioned: false, shouldSkip: false },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    hasControlCommand: true,
    commandAuthorized: true,
    account: { ...baseAccount, historyLimit: 0 },
    core: baseCore,
    config: {} as any,
    raw: { msg_id: "m-9" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  assert.equal(wasCalled(), true);
  assert.equal(ctx.replyDecision?.source, "default-gating");
  assert.equal(ctx.replyDecision?.shouldReply, true);
});

// ─── When guard ──────────────────────────────────────────────────────────

void test("resolve-mention when guard: skips in C2C", async (t) => {
  setupMocks(t);
  const { resolveMention } = await import("./resolve-mention.js");

  assert.equal(resolveMention.when!(createMockCtx({ isGroup: false })), false);
  assert.equal(resolveMention.when!(createMockCtx({ isGroup: true })), true);
});

// ─── Edge: parseTopicMeta tolerates broken cloud_custom_data ─────────────

void test("resolve-mention: broken cloud_custom_data → falls through to L3", async (t) => {
  setupMocks(t, {
    gatingResult: { effectiveWasMentioned: false, shouldSkip: true },
  });
  const { resolveMention } = await import("./resolve-mention.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    groupCode: "group-1" as any,
    rawBody: "hi",
    fromAccount: "user-1",
    account: baseAccount,
    core: baseCore,
    config: {} as any,
    raw: { msg_id: "m-10", cloud_custom_data: "{not-json" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await resolveMention.handler(ctx, next);

  // Broken JSON → parseTopicMeta returns {} → no topicId → L3 path
  assert.equal(wasCalled(), false);
  assert.equal(ctx.topicId, undefined);
  assert.equal(ctx.replyDecision?.source, "default-gating");
});
