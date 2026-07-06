/**
 * Unit tests for prepare-sender middleware: MessageSender creation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

let mockRegistered = false;

function setupMocks(t: any) {
  if (!mockRegistered) {
    t.mock.module("../../outbound/create-sender.js", {
      namedExports: {
        createMessageSender: (opts: any) => ({
          _mockSender: true,
          isGroup: opts.isGroup,
          target: opts.target,
          fromAccount: opts.fromAccount,
          refMsgId: opts.refMsgId,
          refFromAccount: opts.refFromAccount,
          cloudCustomData: opts.cloudCustomData,
          sendText: async () => {},
        }),
      },
    });
    mockRegistered = true;
  }
}

void test("prepare-sender: C2C - creates sender and injects into ctx", async (t) => {
  setupMocks(t);
  const { prepareSender } = await import("./prepare-sender.js");

  const ctx = createMockCtx({
    isGroup: false,
    fromAccount: "user-001",
    account: { accountId: "bot-001", botId: "bot-001", disableBlockStreaming: false } as any,
    route: { agentId: "agent-001", sessionKey: "session-001", accountId: "bot-001" } as any,
    raw: {} as any,
    config: {} as any,
    core: {
      channel: {
        text: { chunkMarkdownText: (t: string, _max: number) => [t] },
      },
    } as any,
  });
  const { next, wasCalled } = createMockNext();

  await prepareSender.handler(ctx, next);

  assert.ok(ctx.sender !== undefined, "sender should be injected");
  assert.ok((ctx.sender as any)._mockSender, "sender should be mock-created");
  assert.equal((ctx.sender as any).target, "user-001", "C2C target should be fromAccount");
  assert.equal(wasCalled(), true);
});

void test("prepare-sender: group - target is groupCode", async (t) => {
  setupMocks(t);
  const { prepareSender } = await import("./prepare-sender.js");

  const ctx = createMockCtx({
    isGroup: true,
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    account: { accountId: "bot-001", botId: "bot-001", disableBlockStreaming: false } as any,
    route: { agentId: "agent-001", sessionKey: "group-session", accountId: "bot-001" } as any,
    raw: { msg_id: "msg-001", msg_key: "key-001" } as any,
    config: {} as any,
    core: {
      channel: {
        text: { chunkMarkdownText: (t: string, _max: number) => [t] },
      },
    } as any,
  });
  const { next } = createMockNext();

  await prepareSender.handler(ctx, next);

  assert.equal((ctx.sender as any).target, "group-001", "group target should be groupCode");
  assert.equal((ctx.sender as any).isGroup, true);
  assert.equal((ctx.sender as any).refMsgId, "msg-001");
  assert.equal((ctx.sender as any).refFromAccount, "user-001");
});

void test("prepare-sender: C2C sets fromAccount from botId", async (t) => {
  setupMocks(t);
  const { prepareSender } = await import("./prepare-sender.js");

  const ctx = createMockCtx({
    isGroup: false,
    fromAccount: "user-001",
    account: { accountId: "bot-001", botId: "my-bot-id", disableBlockStreaming: false } as any,
    route: { agentId: "agent-001", sessionKey: "session-001", accountId: "bot-001" } as any,
    raw: {} as any,
    config: {} as any,
    core: {
      channel: {
        text: { chunkMarkdownText: (t: string, _max: number) => [t] },
      },
    } as any,
  });
  const { next } = createMockNext();

  await prepareSender.handler(ctx, next);

  assert.equal((ctx.sender as any).fromAccount, "my-bot-id", "fromAccount should use botId");
});

void test("prepare-sender: no topicId → cloudCustomData undefined (legacy)", async (t) => {
  setupMocks(t);
  const { prepareSender } = await import("./prepare-sender.js");

  const ctx = createMockCtx({
    isGroup: true,
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    account: { accountId: "bot-001", botId: "bot-001", disableBlockStreaming: false } as any,
    route: { agentId: "agent-001", sessionKey: "s", accountId: "bot-001" } as any,
    raw: {} as any,
    config: {} as any,
    core: { channel: { text: { chunkMarkdownText: (t: string) => [t] } } } as any,
    // topicId intentionally omitted
  });
  const { next } = createMockNext();

  await prepareSender.handler(ctx, next);

  assert.equal((ctx.sender as any).cloudCustomData, undefined, "no topic → no cloudCustomData");
});

void test("prepare-sender: topicId → cloudCustomData carries {topicId}", async (t) => {
  setupMocks(t);
  const { prepareSender } = await import("./prepare-sender.js");

  const ctx = createMockCtx({
    isGroup: true,
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    account: { accountId: "bot-001", botId: "bot-001", disableBlockStreaming: false } as any,
    route: { agentId: "agent-001", sessionKey: "s", accountId: "bot-001" } as any,
    raw: {} as any,
    config: {} as any,
    core: { channel: { text: { chunkMarkdownText: (t: string) => [t] } } } as any,
    topicId: "t-42",
  });
  const { next } = createMockNext();

  await prepareSender.handler(ctx, next);

  assert.equal(
    (ctx.sender as any).cloudCustomData,
    JSON.stringify({ topicId: "t-42" }),
    "topic-scoped sender must echo topicId in cloud_custom_data",
  );
});
