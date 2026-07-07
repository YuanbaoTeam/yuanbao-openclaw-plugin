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

void test("build-context: topicPersona alone -> GroupSystemPrompt contains persona", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    isGroup: true,
    groupCode: "group-001",
    account: { accountId: "bot-001", botId: "bot-001", historyLimit: 0, markdownHintEnabled: false },
    raw: { msg_id: "msg-p1" },
  });
  ctx.topicPersona = "你是一位冷静的分析师，回复请保持简洁。";
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  assert.ok(typeof payload.GroupSystemPrompt === "string");
  // Override wrapper headline + XML delimiter must both be present
  assert.ok(payload.GroupSystemPrompt.includes("严格人设覆盖"));
  assert.ok(payload.GroupSystemPrompt.includes("<persona>"));
  assert.ok(payload.GroupSystemPrompt.includes("</persona>"));
  assert.ok(payload.GroupSystemPrompt.includes("冷静的分析师"));
});

void test("build-context: topicPersona + markdownHintEnabled -> both concatenated", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    isGroup: true,
    groupCode: "group-001",
    account: { accountId: "bot-001", botId: "bot-001", historyLimit: 0, markdownHintEnabled: true },
    raw: { msg_id: "msg-p2" },
  });
  ctx.topicPersona = "PERSONA_TEXT";
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  assert.ok(typeof payload.GroupSystemPrompt === "string");
  assert.ok(payload.GroupSystemPrompt.includes("PERSONA_TEXT"));
  assert.ok(payload.GroupSystemPrompt.includes("Markdown"));
  // Persona should appear before the markdown hint
  const personaIdx = payload.GroupSystemPrompt.indexOf("PERSONA_TEXT");
  const mdIdx = payload.GroupSystemPrompt.indexOf("Markdown");
  assert.ok(personaIdx < mdIdx, "persona should precede markdown hint");
});

void test("build-context: no persona and no markdown hint -> GroupSystemPrompt omitted", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    account: { accountId: "bot-001", botId: "bot-001", historyLimit: 0, markdownHintEnabled: false },
    raw: { msg_id: "msg-p3" },
  });
  // ctx.topicPersona intentionally left undefined
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  assert.equal(payload.GroupSystemPrompt, undefined);
});

void test("build-context: topicPersona -> override also injected into BodyForAgent/RawBody/CommandBody, but Body untouched", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    isGroup: true,
    groupCode: "group-001",
    rewrittenBody: "帮我想想人生的意义",
    account: { accountId: "bot-001", botId: "bot-001", historyLimit: 0, markdownHintEnabled: false },
    raw: { msg_id: "msg-p4" },
  });
  ctx.topicPersona = "PERSONA_BODY_TEST";
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();

  // BodyForAgent / RawBody / CommandBody must carry the override wrapper
  // and the persona text, followed by the original user message.
  for (const field of ["BodyForAgent", "RawBody", "CommandBody"] as const) {
    const value = payload[field] as string;
    assert.equal(typeof value, "string", `${field} should be string`);
    assert.ok(value.includes("<system-override>"), `${field} should contain <system-override>`);
    assert.ok(value.includes("</system-override>"), `${field} should contain </system-override>`);
    assert.ok(value.includes("严格人设覆盖"), `${field} should contain override headline`);
    assert.ok(value.includes("PERSONA_BODY_TEST"), `${field} should contain persona text`);
    assert.ok(value.includes("帮我想想人生的意义"), `${field} should still contain user message`);
    // Override must come before the user message
    assert.ok(
      value.indexOf("PERSONA_BODY_TEST") < value.indexOf("帮我想想人生的意义"),
      `${field} should place override before user message`,
    );
  }

  // Body is the history/display channel — it MUST NOT be polluted with
  // the override text, otherwise persona instructions would leak into
  // stored chat history and be visible to human viewers.
  assert.equal(typeof payload.Body, "string");
  assert.ok(!payload.Body.includes("<system-override>"), "Body must not contain override wrapper");
  assert.ok(!payload.Body.includes("严格人设覆盖"), "Body must not contain override headline");
  assert.ok(!payload.Body.includes("PERSONA_BODY_TEST"), "Body must not contain persona text");
});

void test("build-context: no persona -> BodyForAgent equals rewrittenBody (no override wrapper)", async (t) => {
  setupMocks(t);
  const { buildContext } = await import("./build-context.js");

  const { ctx, getFinalizedPayload } = createBuildCtx({
    rewrittenBody: "普通消息",
    account: { accountId: "bot-001", botId: "bot-001", historyLimit: 0, markdownHintEnabled: false },
    raw: { msg_id: "msg-p5" },
  });
  const { next } = createMockNext();

  await buildContext.handler(ctx, next);

  const payload = getFinalizedPayload();
  assert.equal(payload.BodyForAgent, "普通消息");
  assert.equal(payload.RawBody, "普通消息");
  assert.equal(payload.CommandBody, "普通消息");
});
