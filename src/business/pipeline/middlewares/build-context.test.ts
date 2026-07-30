/**
 * Unit tests for build-context middleware: FinalizedMsgContext construction and group history.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

let mockRegistered = false;

function setupMocks(t: any) {
  if (!mockRegistered) {
    t.mock.module("openclaw/plugin-sdk/reply-history", {
      namedExports: {
        buildPendingHistoryContextFromMap: (opts: any) => opts.currentMessage,
        clearHistoryEntriesIfEnabled: () => {},
      },
    });
    t.mock.module("../../messaging/chat-history.js", {
      namedExports: {
        chatHistories: new Map(),
      },
    });
    mockRegistered = true;
  }
}

/** Create build-context specific mock ctx with all required fields */
function createBuildCtx(overrides: Record<string, any> = {}) {
  let _finalizedPayload: any = null;
  const ctx = createMockCtx({
    isGroup: false,
    fromAccount: "user-001",
    senderNickname: undefined as any,
    rewrittenBody: "test",
    mediaPaths: [],
    mediaTypes: [],
    commandAuthorized: false,
    route: { agentId: "agent-001", sessionKey: "session-001", accountId: "bot-001" } as any,
    storePath: "/tmp/store" as any,
    envelopeOptions: {} as any,
    previousTimestamp: undefined,
    raw: { msg_id: "msg-001" } as any,
    account: { accountId: "bot-001", botId: "bot-001", historyLimit: 0 } as any,
    config: {} as any,
    core: {
      channel: {
        reply: {
          formatAgentEnvelope: (opts: any) => String(opts.body ?? ""),
          finalizeInboundContext: (opts: any) => {
            _finalizedPayload = opts;
            return opts;
          },
        },
      },
    } as any,
    ...overrides,
  });
  return { ctx, getFinalizedPayload: () => _finalizedPayload };
}

void test("build-context: prerequisite middleware not ready -> abort pipeline", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const ctx = createMockCtx({
    route: undefined,
    storePath: undefined,
    envelopeOptions: undefined,
  });
  const { next, wasCalled } = createMockNext();

  await buildContext.handler(ctx, next);

  assert.equal(wasCalled(), false, "should abort when prerequisites not ready");
  assert.equal(ctx.ctxPayload, undefined);
});

void test("build-context: C2C - constructs ctxPayload", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    senderNickname: "张三",
    rewrittenBody: "你好",
    envelopeOptions: { format: "markdown" },
    account: { accountId: "bot-001", botId: "bot-001", historyLimit: 10 },
  });
  const { next, wasCalled } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  assert.equal(wasCalled(), true);
  assert.ok(ctx.ctxPayload !== undefined, "ctxPayload should be populated");
  assert.equal(payload.SenderName, "张三");
  assert.equal(payload.SenderId, "user-001");
  assert.equal(payload.ChatType, "direct");
  assert.equal(payload.Provider, "yuanbao");
});

void test("build-context: group chat - ChatType is group", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    isGroup: true,
    groupCode: "group-001",
    senderNickname: "李四",
    rewrittenBody: "群消息",
    raw: { msg_id: "msg-002", group_name: "测试群" },
    account: { accountId: "bot-001", botId: "bot-001", historyLimit: 10 },
  });
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  assert.equal(payload.ChatType, "group");
  assert.equal(payload.GroupSubject, "测试群");
});

void test("build-context: populates MediaPaths when media present", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    rewrittenBody: "看图",
    mediaPaths: ["/tmp/img1.jpg", "/tmp/img2.jpg"],
    mediaTypes: ["image", "image"],
    raw: { msg_id: "msg-003" },
  });
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  assert.deepEqual(payload.MediaPaths, ["/tmp/img1.jpg", "/tmp/img2.jpg"]);
  assert.equal(payload.MediaPath, "/tmp/img1.jpg");
});

void test("build-context: uses fromAccount when senderNickname is empty", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    senderNickname: undefined,
    raw: { msg_id: "msg-004" },
  });
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  assert.equal(payload.SenderName, "user-001");
});

void test("build-context: UntrustedContext always contains system time", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    account: { accountId: "bot-001", botId: "bot-001", historyLimit: 0, markdownHintEnabled: false },
  });
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  assert.ok(
    Array.isArray(payload.UntrustedContext) && payload.UntrustedContext[0].includes("[Current Time]"),
    "UntrustedContext should always contain [Current Time]",
  );
});

void test("build-context: uses raw.msg_time as envelope timestamp when available", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  let capturedTimestamp: Date | undefined;
  const { ctx } = createBuildCtx({
    raw: { msg_id: "msg-005", msg_time: 1718530000 },
    core: {
      channel: {
        reply: {
          formatAgentEnvelope: (opts: any) => {
            capturedTimestamp = opts.timestamp;
            return String(opts.body ?? "");
          },
          finalizeInboundContext: (opts: any) => opts,
        },
      },
    } as any,
  });
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  assert.ok(capturedTimestamp instanceof Date, "timestamp should be a Date");
  assert.equal(capturedTimestamp!.getTime(), 1718530000 * 1000);
});

void test("build-context: group chat attributes @bot body with senderLabel (nickname + id)", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    isGroup: true,
    groupCode: "group-001",
    fromAccount: "user-001",
    senderNickname: "小明",
    rewrittenBody: "我叫小明",
    raw: { msg_id: "msg-grp-1" },
    account: { accountId: "bot-001", botId: "bot-001", historyLimit: 0 },
  });
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  // Body must surface both nickname and id so the agent can tell who is asking
  // inside the shared group session.
  assert.match(payload.Body, /小明 \(user-001\): 我叫小明/);
  // BodyForAgent drives agentText / the persisted session transcript, so it
  // must also carry the sender label — otherwise group members collapse into
  // one anonymous voice in the shared session.
  assert.match(payload.BodyForAgent, /小明 \(user-001\): 我叫小明/);
  // RawBody / CommandBody stay raw so command parsing is not polluted.
  assert.equal(payload.RawBody, "我叫小明");
  assert.equal(payload.CommandBody, "我叫小明");
});

void test("build-context: group chat falls back to fromAccount in body when nickname is absent", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    isGroup: true,
    groupCode: "group-002",
    fromAccount: "user-002",
    senderNickname: undefined,
    rewrittenBody: "hi",
    raw: { msg_id: "msg-grp-2" },
    account: { accountId: "bot-001", botId: "bot-001", historyLimit: 0 },
  });
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  // No nickname -> body uses fromAccount only, no empty parens.
  assert.equal(payload.Body, "user-002: hi");
  // BodyForAgent must mirror the attributed body so the agent can attribute
  // the message even when only the raw id is known.
  assert.equal(payload.BodyForAgent, "user-002: hi");
});

void test("build-context: C2C body is not attributed with a sender prefix", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    isGroup: false,
    fromAccount: "user-001",
    senderNickname: "张三",
    rewrittenBody: "你好",
    raw: { msg_id: "msg-c2c-1" },
    account: { accountId: "bot-001", botId: "bot-001", historyLimit: 0 },
  });
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  // C2C does not need in-body sender attribution; body stays as rewrittenBody.
  assert.equal(payload.Body, "你好");
  // C2C BodyForAgent also stays as the raw body — no sender prefix leak.
  assert.equal(payload.BodyForAgent, "你好");
  assert.equal(payload.RawBody, "你好");
});

void test("build-context: group chat surfaces bot identity + mentions in UntrustedContext", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    isGroup: true,
    groupCode: "group-001",
    fromAccount: "user-001",
    senderNickname: "小明",
    rewrittenBody: "@元宝助手 帮我总结",
    raw: { msg_id: "msg-grp-mention" },
    account: { accountId: "bot-001", botId: "bot_456", historyLimit: 0 },
    mentions: [
      { text: "@元宝助手", userId: "bot_456" },
      { text: "@朋友", userId: "user-002" },
    ] as any,
  });
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  const untrusted = payload.UntrustedContext as string[];
  assert.ok(Array.isArray(untrusted), "UntrustedContext should be an array");
  // [Current Time] always present.
  assert.ok(untrusted[0].includes("[Current Time]"), "first element should be Current Time");
  // Bot self-identity: display name reverse-looked-up from mentions (text has @).
  assert.ok(
    untrusted.some(s => s === "[You are: @元宝助手(userId: bot_456)]"),
    "UntrustedContext should expose bot identity with display name from mentions",
  );
  // Mentions list migrated here from rewrittenBody.
  assert.ok(
    untrusted.some(s => s.includes("[Message mentions the following users:") && s.includes("@元宝助手(userId: bot_456)") && s.includes("@朋友(userId: user-002)")),
    "UntrustedContext should carry the mentions list",
  );
  // Body / RawBody / CommandBody must stay free of the mentions suffix.
  assert.ok(!payload.Body.includes("Message mentions"), "Body should not contain mentions suffix");
  assert.ok(!payload.RawBody.includes("Message mentions"), "RawBody should not contain mentions suffix");
  assert.ok(!payload.CommandBody.includes("Message mentions"), "CommandBody should not contain mentions suffix");
});

void test("build-context: bot identity display name falls back to account.name when bot not @-ed", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    isGroup: true,
    groupCode: "group-001",
    fromAccount: "user-001",
    senderNickname: "小明",
    rewrittenBody: "大家看好不好玩",
    raw: { msg_id: "msg-grp-no-bot-mention" },
    // requireMention=false path: bot itself is NOT in mentions, so display
    // name cannot be reverse-looked-up — must fall back to account.name.
    account: { accountId: "bot-001", botId: "bot_456", name: "元宝账号", historyLimit: 0 },
    mentions: [{ text: "@朋友", userId: "user-002" }] as any,
  });
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  const untrusted = payload.UntrustedContext as string[];
  assert.ok(
    untrusted.some(s => s === "[You are: 元宝账号(userId: bot_456)]"),
    "bot identity should fall back to account.name when bot not in mentions",
  );
  // Mentions list still present (non-empty mentions in group chat).
  assert.ok(
    untrusted.some(s => s.includes("[Message mentions the following users:") && s.includes("@朋友(userId: user-002)")),
    "mentions list should still be present",
  );
});

void test("build-context: C2C UntrustedContext has no bot identity or mentions", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    isGroup: false,
    fromAccount: "user-001",
    rewrittenBody: "你好",
    raw: { msg_id: "msg-c2c-2" },
    account: { accountId: "bot-001", botId: "bot_456", historyLimit: 0 },
    // C2C path must stay unchanged even if mentions happen to be populated.
    mentions: [{ text: "@元宝助手", userId: "bot_456" }] as any,
  });
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  const untrusted = payload.UntrustedContext as string[];
  assert.equal(untrusted.length, 1, "C2C UntrustedContext should only contain Current Time");
  assert.ok(untrusted[0].includes("[Current Time]"));
  assert.ok(!untrusted.some(s => s.includes("[You are:")), "C2C should not expose bot identity");
  assert.ok(!untrusted.some(s => s.includes("Message mentions")), "C2C should not expose mentions");
});
