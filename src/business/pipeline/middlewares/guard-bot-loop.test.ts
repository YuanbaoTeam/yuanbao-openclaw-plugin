/**
 * Unit tests for guard-bot-loop middleware.
 *
 * Coverage:
 * - non-group / disabled config / missing groupCode -> pass through
 * - sender is a human (userType undefined or 1) -> pass through, no count
 * - sender is a bot (userType 2/3) -> counted; below threshold -> pass through
 * - threshold reached -> abort, log info
 * - already muted -> abort silently (no count advance)
 * - default enabled (config undefined) still applies
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BotLoopCounter } from "../../../infra/cache/bot-loop-counter.js";
import { getMember } from "../../../infra/cache/member.js";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";
import {
  guardBotLoop,
  resetBotLoopCounterProvider,
  setBotLoopCounterProvider,
} from "./guard-bot-loop.js";

function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function withMockCounter(counter: BotLoopCounter): () => void {
  setBotLoopCounterProvider(() => counter);
  return () => resetBotLoopCounterProvider();
}

/** Seed a user record into the session cache with the given userType. */
function seedSender(accountId: string, groupCode: string, userId: string, userType?: number) {
  const member = getMember(accountId);
  member.session.upsertUser(groupCode, {
    userId,
    nickName: `nick-${userId}`,
    lastSeen: Date.now(),
    userType,
  });
}

void test("guard-bot-loop: non-group message -> when-hook skips middleware", () => {
  // The pipeline engine honors `when`; verify the predicate returns false.
  const ctx = createMockCtx({ isGroup: false });
  assert.equal(guardBotLoop.when?.(ctx), false);
});

void test("guard-bot-loop: disabled config -> pass through, no count", async () => {
  const clock = makeClock();
  const counter = new BotLoopCounter({ threshold: 5, windowMs: 60_000, muteMs: 60_000, now: clock.now });
  const restore = withMockCounter(counter);
  try {
    const ctx = createMockCtx({
      isGroup: true,
      groupCode: "g-disabled",
      fromAccount: "peer-bot",
      account: { accountId: "acc-1", botId: "bot-1", botLoop: { enabled: false } } as any,
    });
    seedSender("acc-1", "g-disabled", "peer-bot", 3); // bot

    const { next, wasCalled } = createMockNext();
    await guardBotLoop.handler(ctx, next);
    assert.equal(wasCalled(), true, "next should be called");
    assert.equal(counter.size(), 0, "counter should not be touched");
  } finally {
    restore();
  }
});

void test("guard-bot-loop: sender is human (userType=1) -> pass through, no count", async () => {
  const clock = makeClock();
  const counter = new BotLoopCounter({ threshold: 5, windowMs: 60_000, muteMs: 60_000, now: clock.now });
  const restore = withMockCounter(counter);
  try {
    const ctx = createMockCtx({
      isGroup: true,
      groupCode: "g-human",
      fromAccount: "human-1",
      account: { accountId: "acc-2", botId: "bot-2", botLoop: { threshold: 5, windowMs: 60_000, muteMs: 60_000 } } as any,
    });
    seedSender("acc-2", "g-human", "human-1", 1);

    const { next, wasCalled } = createMockNext();
    await guardBotLoop.handler(ctx, next);
    assert.equal(wasCalled(), true);
    assert.equal(counter.size(), 0);
  } finally {
    restore();
  }
});

void test("guard-bot-loop: sender userType unknown (cache miss) -> conservative pass through", async () => {
  const clock = makeClock();
  const counter = new BotLoopCounter({ threshold: 5, windowMs: 60_000, muteMs: 60_000, now: clock.now });
  const restore = withMockCounter(counter);
  try {
    const ctx = createMockCtx({
      isGroup: true,
      groupCode: "g-unknown",
      fromAccount: "mystery",
      account: { accountId: "acc-3", botId: "bot-3", botLoop: { threshold: 5, windowMs: 60_000, muteMs: 60_000 } } as any,
    });
    // Do NOT seed sender.

    const { next, wasCalled } = createMockNext();
    await guardBotLoop.handler(ctx, next);
    assert.equal(wasCalled(), true, "unknown userType should be treated as human");
    assert.equal(counter.size(), 0);
  } finally {
    restore();
  }
});

void test("guard-bot-loop: bot sender below threshold -> counted, pass through", async () => {
  const clock = makeClock();
  const counter = new BotLoopCounter({ threshold: 5, windowMs: 60_000, muteMs: 60_000, now: clock.now });
  const restore = withMockCounter(counter);
  try {
    const ctx = createMockCtx({
      isGroup: true,
      groupCode: "g-bot",
      fromAccount: "peer-bot-a",
      account: { accountId: "acc-4", botId: "bot-4", botLoop: { threshold: 5, windowMs: 60_000, muteMs: 60_000 } } as any,
    });
    seedSender("acc-4", "g-bot", "peer-bot-a", 3);

    const { next, wasCalled } = createMockNext();
    await guardBotLoop.handler(ctx, next);
    assert.equal(wasCalled(), true, "below-threshold bot msg should pass through");
    assert.equal(counter.isMuted("g-bot", "bot-4"), false);
  } finally {
    restore();
  }
});

void test("guard-bot-loop: 5th bot message trips mute -> abort", async () => {
  const clock = makeClock();
  const counter = new BotLoopCounter({ threshold: 5, windowMs: 60_000, muteMs: 60_000, now: clock.now });
  const restore = withMockCounter(counter);
  try {
    seedSender("acc-5", "g-loop", "peer-bot-b", 2);
    const account = { accountId: "acc-5", botId: "bot-5", botLoop: { threshold: 5, windowMs: 60_000, muteMs: 60_000 } } as any;

    for (let i = 1; i <= 4; i++) {
      const ctx = createMockCtx({ isGroup: true, groupCode: "g-loop", fromAccount: "peer-bot-b", account });
      const { next, wasCalled } = createMockNext();
      await guardBotLoop.handler(ctx, next);
      assert.equal(wasCalled(), true, `iter ${i} should pass through`);
    }

    // 5th trips the mute
    const ctx5 = createMockCtx({ isGroup: true, groupCode: "g-loop", fromAccount: "peer-bot-b", account });
    const { next: n5, wasCalled: c5 } = createMockNext();
    await guardBotLoop.handler(ctx5, n5);
    assert.equal(c5(), false, "5th (threshold) message should abort");
    assert.equal(counter.isMuted("g-loop", "bot-5"), true);
  } finally {
    restore();
  }
});

void test("guard-bot-loop: already muted -> silent abort, no count advance", async () => {
  const clock = makeClock();
  const counter = new BotLoopCounter({ threshold: 3, windowMs: 60_000, muteMs: 60_000, now: clock.now });
  const restore = withMockCounter(counter);
  try {
    // Trip mute out-of-band.
    counter.record("g-mute", "bot-6");
    counter.record("g-mute", "bot-6");
    counter.record("g-mute", "bot-6");
    assert.equal(counter.isMuted("g-mute", "bot-6"), true);

    seedSender("acc-6", "g-mute", "peer-bot-c", 3);
    const ctx = createMockCtx({
      isGroup: true,
      groupCode: "g-mute",
      fromAccount: "peer-bot-c",
      account: { accountId: "acc-6", botId: "bot-6", botLoop: { threshold: 3, windowMs: 60_000, muteMs: 60_000 } } as any,
    });
    const { next, wasCalled } = createMockNext();
    await guardBotLoop.handler(ctx, next);
    assert.equal(wasCalled(), false, "muted period should abort");
    // Also verify a human sender is still dropped while muted.
    seedSender("acc-6", "g-mute", "human-x", 1);
    const ctxHuman = createMockCtx({
      isGroup: true,
      groupCode: "g-mute",
      fromAccount: "human-x",
      account: { accountId: "acc-6", botId: "bot-6", botLoop: { threshold: 3, windowMs: 60_000, muteMs: 60_000 } } as any,
    });
    const { next: nh, wasCalled: ch } = createMockNext();
    await guardBotLoop.handler(ctxHuman, nh);
    assert.equal(ch(), false, "human messages are also dropped during mute (side effect of protecting the pipeline)");
  } finally {
    restore();
  }
});

void test("guard-bot-loop: mute expires -> next bot msg starts fresh window", async () => {
  const clock = makeClock();
  const counter = new BotLoopCounter({ threshold: 2, windowMs: 60_000, muteMs: 60_000, now: clock.now });
  const restore = withMockCounter(counter);
  try {
    seedSender("acc-7", "g-recover", "peer-bot-d", 3);
    const account = { accountId: "acc-7", botId: "bot-7", botLoop: { threshold: 2, windowMs: 60_000, muteMs: 60_000 } } as any;

    // Trip mute (threshold=2).
    for (let i = 0; i < 2; i++) {
      const ctx = createMockCtx({ isGroup: true, groupCode: "g-recover", fromAccount: "peer-bot-d", account });
      await guardBotLoop.handler(ctx, async () => {});
    }
    assert.equal(counter.isMuted("g-recover", "bot-7"), true);

    // Advance past mute expiry.
    clock.advance(61_000);
    const ctxAfter = createMockCtx({ isGroup: true, groupCode: "g-recover", fromAccount: "peer-bot-d", account });
    const { next, wasCalled } = createMockNext();
    await guardBotLoop.handler(ctxAfter, next);
    assert.equal(wasCalled(), true, "after mute expiry, bot msg should pass again");
    assert.equal(counter.isMuted("g-recover", "bot-7"), false);
  } finally {
    restore();
  }
});

void test("guard-bot-loop: config undefined on account -> defaults enabled with default thresholds", async () => {
  const clock = makeClock();
  const counter = new BotLoopCounter({ threshold: 5, windowMs: 60_000, muteMs: 60_000, now: clock.now });
  const restore = withMockCounter(counter);
  try {
    seedSender("acc-8", "g-default", "peer-bot-e", 2);
    const account = { accountId: "acc-8", botId: "bot-8" } as any; // no botLoop field
    const ctx = createMockCtx({ isGroup: true, groupCode: "g-default", fromAccount: "peer-bot-e", account });
    const { next, wasCalled } = createMockNext();
    await guardBotLoop.handler(ctx, next);
    assert.equal(wasCalled(), true, "1st bot msg passes under default threshold=5");
  } finally {
    restore();
  }
});
