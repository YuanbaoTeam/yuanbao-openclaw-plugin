/**
 * Integration test for the inbound gating chain.
 *
 * Drives the REAL middlewares (skip-self → skip-placeholder → guard-command →
 * resolve-mention) through the REAL MessagePipeline engine and asserts the
 * keep/drop decision for each inbound variant. A sentinel terminal middleware
 * records whether a message survived the gates (i.e. would reach dispatch).
 *
 * This complements the per-middleware unit tests: it catches breakage in how
 * the gates compose and short-circuit, which a single-middleware test cannot.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { MessagePipeline } from "./engine.js";
import { guardCommand } from "./middlewares/guard-command.js";
import { resolveMention } from "./middlewares/resolve-mention.js";
import { skipPlaceholder } from "./middlewares/skip-placeholder.js";
import { skipSelf } from "./middlewares/skip-self.js";
import { createMockCtx } from "./test-helpers/mock-ctx.js";
import type { PipelineContext } from "./types.js";

/** Run the gating chain; returns true if the message survived all gates. */
async function runGates(ctx: PipelineContext): Promise<boolean> {
  let reached = false;
  const pipeline = new MessagePipeline()
    .use(skipSelf)
    .use(skipPlaceholder)
    .use(guardCommand)
    .use(resolveMention)
    .use({
      name: "__sentinel",
      handler: async (_ctx, next) => {
        reached = true;
        await next();
      },
    });
  await pipeline.execute(ctx);
  return reached;
}

void test("C2C plain text survives the gates", async () => {
  const ctx = createMockCtx({ isGroup: false, fromAccount: "user-001", rawBody: "hello", medias: [] });
  assert.equal(await runGates(ctx), true);
});

void test("bot self message is dropped by skip-self", async () => {
  // account.botId is "bot-001" in the mock; sender == bot → self
  const ctx = createMockCtx({ isGroup: false, fromAccount: "bot-001", rawBody: "echo", medias: [] });
  assert.equal(await runGates(ctx), false);
});

void test("C2C empty body is dropped by skip-placeholder", async () => {
  const ctx = createMockCtx({ isGroup: false, fromAccount: "user-001", rawBody: "   ", medias: [] });
  assert.equal(await runGates(ctx), false);
});

void test("C2C bracket placeholder without media is dropped", async () => {
  const ctx = createMockCtx({ isGroup: false, fromAccount: "user-001", rawBody: "[image]", medias: [] });
  assert.equal(await runGates(ctx), false);
});

void test("C2C [EMOJI] placeholder is NOT dropped (emoji semantics)", async () => {
  const ctx = createMockCtx({ isGroup: false, fromAccount: "user-001", rawBody: "[EMOJI:smile]", medias: [] });
  assert.equal(await runGates(ctx), true);
});

void test("group message without @bot is dropped by mention gating", async () => {
  const ctx = createMockCtx({
    isGroup: true, chatType: "group", fromAccount: "user-001", groupCode: "g-1",
    rawBody: "hi everyone", isAtBot: false, medias: [],
    account: { botId: "bot-001", accountId: "bot-001", requireMention: true, historyLimit: 10, config: { dm: { policy: "open", allowFrom: [] } } },
  });
  assert.equal(await runGates(ctx), false);
});

void test("group message @bot survives mention gating", async () => {
  const ctx = createMockCtx({
    isGroup: true, chatType: "group", fromAccount: "user-001", groupCode: "g-1",
    rawBody: "hey bot", isAtBot: true, medias: [],
    account: { botId: "bot-001", accountId: "bot-001", requireMention: true, historyLimit: 10, config: { dm: { policy: "open", allowFrom: [] } } },
  });
  assert.equal(await runGates(ctx), true);
});

void test("group message survives when requireMention is false even without @bot", async () => {
  const ctx = createMockCtx({
    isGroup: true, chatType: "group", fromAccount: "user-001", groupCode: "g-1",
    rawBody: "no mention needed", isAtBot: false, medias: [],
    account: { botId: "bot-001", accountId: "bot-001", requireMention: false, historyLimit: 10, config: { dm: { policy: "open", allowFrom: [] } } },
  });
  assert.equal(await runGates(ctx), true);
});
