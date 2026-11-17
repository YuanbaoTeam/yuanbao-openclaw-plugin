/**
 * Unit tests for guard-command middleware: control command authorization guard.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

let mockGateResult = { commandAuthorized: false, shouldBlock: true };
let mockGateCallback: ((opts: any) => { commandAuthorized: boolean; shouldBlock: boolean }) | null =
  null;

let mockRegistered = false;

function setupMocks(
  t: any,
  opts?: {
    gateResult?: { commandAuthorized: boolean; shouldBlock: boolean };
    gateCallback?: (opts: any) => { commandAuthorized: boolean; shouldBlock: boolean };
  },
) {
  mockGateResult = opts?.gateResult ?? { commandAuthorized: false, shouldBlock: true };
  mockGateCallback = opts?.gateCallback ?? null;
  if (!mockRegistered) {
    t.mock.module("openclaw/plugin-sdk/command-auth-native", {
      namedExports: {
        resolveControlCommandGate: (args: any) => {
          if (mockGateCallback) {
            return mockGateCallback(args);
          }
          return { ...mockGateResult };
        },
      },
    });
    mockRegistered = true;
  }
}

void test("guard-command: unauthorized control command -> abort pipeline", async (t) => {
  setupMocks(t, {
    gateResult: { commandAuthorized: false, shouldBlock: true },
  });
  const { guardCommand } = await import("./guard-command.js");

  const ctx = createMockCtx({
    rawBody: "/some-command",
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
        text: { hasControlCommand: () => true },
      },
    } as any,
    account: {
      botId: "bot-001",
      accountId: "bot-001",
      config: { dm: { policy: "open", allowFrom: [] } },
    } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardCommand.handler(ctx, next);

  assert.equal(wasCalled(), false, "unauthorized should abort pipeline");
  assert.equal(ctx.commandAuthorized, false);
});

void test("guard-command: authorized control command -> pass through", async (t) => {
  setupMocks(t, {
    gateResult: { commandAuthorized: true, shouldBlock: false },
  });
  const { guardCommand } = await import("./guard-command.js");

  const ctx = createMockCtx({
    rawBody: "/some-command",
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
        text: { hasControlCommand: () => true },
      },
    } as any,
    account: {
      botId: "bot-001",
      accountId: "bot-001",
      config: { dm: { policy: "open", allowFrom: [] } },
    } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardCommand.handler(ctx, next);

  assert.equal(wasCalled(), true, "authorized should pass through");
  assert.equal(ctx.commandAuthorized, true);
});

void test("guard-command: non-control command -> pass through", async (t) => {
  setupMocks(t, {
    gateResult: { commandAuthorized: false, shouldBlock: false },
  });
  const { guardCommand } = await import("./guard-command.js");

  const ctx = createMockCtx({
    rawBody: "你好",
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
        text: { hasControlCommand: () => false },
      },
    } as any,
    account: {
      botId: "bot-001",
      accountId: "bot-001",
      config: { dm: { policy: "open", allowFrom: [] } },
    } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardCommand.handler(ctx, next);

  assert.equal(wasCalled(), true);
  assert.equal(ctx.hasControlCommand, false);
});

void test("guard-command: group control command WITHOUT @bot -> not a control command, passes through", async (t) => {
  setupMocks(t, { gateResult: { commandAuthorized: false, shouldBlock: true } });
  const { guardCommand } = await import("./guard-command.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: false,
    rawBody: "/stop",
    raw: { msg_body: [{ msg_type: "TIMTextElem", msg_content: { text: "/stop" } }] } as any,
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
        text: { hasControlCommand: () => true },
      },
    } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardCommand.handler(ctx, next);

  assert.equal(wasCalled(), true, "no @bot in group => treated as plain text, must pass through");
  assert.equal(ctx.hasControlCommand, false, "control command requires @bot in group");
});

void test("guard-command: group control command WITH @bot + authorized -> sets commandParts, passes", async (t) => {
  setupMocks(t, { gateResult: { commandAuthorized: true, shouldBlock: false } });
  const { guardCommand } = await import("./guard-command.js");

  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: true,
    rawBody: "@bot /stop",
    raw: { msg_body: [{ msg_type: "TIMTextElem", msg_content: { text: "/stop" } }] } as any,
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
        text: { hasControlCommand: () => true },
      },
    } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardCommand.handler(ctx, next);

  assert.equal(wasCalled(), true, "@bot + authorized should pass through");
  assert.equal(ctx.hasControlCommand, true);
  assert.deepEqual(ctx.commandParts, ["/stop"]);
});

void test("guard-command: group extracts TIMTextElem-only text (skips @mention custom elems)", async (t) => {
  setupMocks(t, { gateResult: { commandAuthorized: true, shouldBlock: false } });
  const { guardCommand } = await import("./guard-command.js");

  let detectedText = "";
  const ctx = createMockCtx({
    isGroup: true,
    isAtBot: true,
    // rawBody carries the @mention noise that would break command matching
    rawBody: "@元宝 /new",
    raw: {
      msg_body: [
        { msg_type: "TIMCustomElem", msg_content: { data: "@元宝" } },
        { msg_type: "TIMTextElem", msg_content: { text: "/new" } },
      ],
    } as any,
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
        text: {
          hasControlCommand: (text: string) => {
            detectedText = text;
            return true;
          },
        },
      },
    } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardCommand.handler(ctx, next);

  assert.equal(detectedText, "/new", "command detection should run on TIMTextElem-only text");
  assert.equal(wasCalled(), true);
  assert.deepEqual(ctx.commandParts, ["/new"]);
});

void test("guard-command: DM policy closed + not in allowFrom -> shouldBlock", async (t) => {
  setupMocks(t, {
    gateCallback: (opts: any) => {
      // Verify authorizers parameter
      const senderAllowed = opts.authorizers[0].allowed;
      return {
        commandAuthorized: false,
        shouldBlock: !senderAllowed && opts.hasControlCommand,
      };
    },
  });
  const { guardCommand } = await import("./guard-command.js");

  const ctx = createMockCtx({
    rawBody: "/restricted-cmd",
    fromAccount: "stranger",
    core: {
      channel: {
        commands: { shouldHandleTextCommands: () => true },
        text: { hasControlCommand: () => true },
      },
    } as any,
    account: {
      botId: "bot-001",
      accountId: "bot-001",
      config: { dm: { policy: "closed", allowFrom: ["admin-001"] } },
    } as any,
  });
  const { next, wasCalled } = createMockNext();

  await guardCommand.handler(ctx, next);

  assert.equal(wasCalled(), false, "closed policy + non-allowed user should abort");
});
