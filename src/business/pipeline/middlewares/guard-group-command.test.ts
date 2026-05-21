/**
 * Unit tests for guard-group-command middleware: group command whitelist guard.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

/** Create common mock modules */
function setupMocks(t: any) {
  t.mock.module("../../messaging/context.js", {
    namedExports: {
      resolveOutboundSenderAccount: () => "bot-001",
    },
  });
  t.mock.module("../../../infra/transport.js", {
    namedExports: {
      sendGroupMsgBody: async () => {},
    },
  });
  t.mock.module("../../messaging/handlers/index.js", {
    namedExports: {
      prepareOutboundContent: (text: string) => text,
      buildOutboundMsgBody: (text: string) => [{ text }],
    },
  });
  t.mock.module("../../../infra/cache/member.js", {
    namedExports: {
      getMember: () => ({}),
    },
  });
}

void test("guard-group-command: when guard - executes for group command", async (t) => {
  setupMocks(t);
  const { guardGroupCommand } = await import("./guard-group-command.js");

  const ctx = createMockCtx({ isGroup: true, hasControlCommand: true } as any);
  assert.equal(guardGroupCommand.when!(ctx), true);
});

void test("guard-group-command: when guard - skips in C2C", async (t) => {
  setupMocks(t);
  const { guardGroupCommand } = await import("./guard-group-command.js");

  const ctx = createMockCtx({ isGroup: false, hasControlCommand: true } as any);
  assert.equal(guardGroupCommand.when!(ctx), false);
});

void test("guard-group-command: when guard - skips non-command in group", async (t) => {
  setupMocks(t);
  const { guardGroupCommand } = await import("./guard-group-command.js");

  const ctx = createMockCtx({ isGroup: true, hasControlCommand: false } as any);
  assert.equal(guardGroupCommand.when!(ctx), false);
});

void test("guard-group-command: non-owner + whitelisted command -> reject (owner-only)", async (t) => {
  setupMocks(t);
  const { guardGroupCommand } = await import("./guard-group-command.js");

  const ctx = createMockCtx({
    isGroup: true,
    hasControlCommand: true,
    commandParts: ["/new"],
    rawBody: "/new",
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    raw: { bot_owner_id: "owner-001", from_account: "user-001", msg_id: "msg-001" } as any,
    config: {} as any,
  } as any);
  const { next, wasCalled } = createMockNext();

  await guardGroupCommand.handler(ctx, next);

  assert.equal(wasCalled(), false, "non-owner should abort pipeline");
});

void test("guard-group-command: owner + whitelisted command -> pass through", async (t) => {
  setupMocks(t);
  const { guardGroupCommand } = await import("./guard-group-command.js");

  const ctx = createMockCtx({
    isGroup: true,
    hasControlCommand: true,
    commandParts: ["/new"],
    rawBody: "/new",
    groupCode: "group-001" as any,
    fromAccount: "owner-001",
    raw: { bot_owner_id: "owner-001", from_account: "owner-001" } as any,
    config: {} as any,
  } as any);
  const { next, wasCalled } = createMockNext();

  await guardGroupCommand.handler(ctx, next);

  assert.equal(wasCalled(), true, "owner should pass through");
});

void test("guard-group-command: non-whitelisted command -> reject", async (t) => {
  setupMocks(t);
  const { guardGroupCommand } = await import("./guard-group-command.js");

  const ctx = createMockCtx({
    isGroup: true,
    hasControlCommand: true,
    commandParts: ["/config"],
    rawBody: "/config",
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    raw: { bot_owner_id: "owner-001", from_account: "user-001", msg_id: "msg-001" } as any,
    config: {} as any,
  } as any);
  const { next, wasCalled } = createMockNext();

  await guardGroupCommand.handler(ctx, next);

  assert.equal(wasCalled(), false, "non-whitelisted command should abort pipeline");
});
