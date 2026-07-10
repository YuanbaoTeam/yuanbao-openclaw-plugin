/**
 * Unit tests for BotLoopCounter — sliding-window counter with mute state.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { BotLoopCounter } from "./bot-loop-counter.js";

function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

void test("BotLoopCounter: below threshold -> not muted", () => {
  const clock = makeClock();
  const counter = new BotLoopCounter({
    threshold: 5,
    windowMs: 10 * 60 * 1000,
    muteMs: 30 * 60 * 1000,
    now: clock.now,
  });

  for (let i = 1; i <= 4; i++) {
    const r = counter.record("group-1", "bot-1");
    assert.equal(r.muted, false, `iter ${i} should not be muted`);
    assert.equal(r.justEnteredMute, false);
    assert.equal(r.count, i);
  }
});

void test("BotLoopCounter: hit threshold -> enters mute exactly once", () => {
  const clock = makeClock();
  const counter = new BotLoopCounter({
    threshold: 5,
    windowMs: 10 * 60 * 1000,
    muteMs: 30 * 60 * 1000,
    now: clock.now,
  });

  for (let i = 1; i <= 4; i++) {
    counter.record("group-1", "bot-1");
  }
  const fifth = counter.record("group-1", "bot-1");
  assert.equal(fifth.muted, true);
  assert.equal(fifth.justEnteredMute, true);
  assert.equal(fifth.count, 5);

  // Subsequent calls within mute window: still muted, no re-entry.
  clock.advance(1000);
  const sixth = counter.record("group-1", "bot-1");
  assert.equal(sixth.muted, true);
  assert.equal(sixth.justEnteredMute, false);
});

void test("BotLoopCounter: mute expires -> next record starts a fresh window", () => {
  const clock = makeClock();
  const counter = new BotLoopCounter({
    threshold: 3,
    windowMs: 10 * 60 * 1000,
    muteMs: 30 * 60 * 1000,
    now: clock.now,
  });

  // Trip the mute.
  counter.record("g", "b");
  counter.record("g", "b");
  const tripped = counter.record("g", "b");
  assert.equal(tripped.muted, true);
  assert.equal(tripped.justEnteredMute, true);

  // Fast-forward past mute expiry.
  clock.advance(31 * 60 * 1000);

  const revived = counter.record("g", "b");
  assert.equal(revived.muted, false, "mute should auto-recover after TTL");
  assert.equal(revived.justEnteredMute, false);
  assert.equal(revived.count, 1, "fresh window starts count=1");
  assert.equal(counter.isMuted("g", "b"), false);
});

void test("BotLoopCounter: window rolls over -> counter resets", () => {
  const clock = makeClock();
  const counter = new BotLoopCounter({
    threshold: 5,
    windowMs: 10 * 60 * 1000,
    muteMs: 30 * 60 * 1000,
    now: clock.now,
  });

  counter.record("g", "b");
  counter.record("g", "b");
  clock.advance(11 * 60 * 1000); // window expired

  const r = counter.record("g", "b");
  assert.equal(r.count, 1, "new window should start at 1");
  assert.equal(r.muted, false);
});

void test("BotLoopCounter: independent (group, bot) keys are isolated", () => {
  const clock = makeClock();
  const counter = new BotLoopCounter({
    threshold: 3,
    windowMs: 10 * 60 * 1000,
    muteMs: 30 * 60 * 1000,
    now: clock.now,
  });

  counter.record("group-A", "bot-1");
  counter.record("group-A", "bot-1");
  counter.record("group-A", "bot-1"); // group-A/bot-1 muted

  // Different group, same bot -> still counts from scratch.
  const other = counter.record("group-B", "bot-1");
  assert.equal(other.muted, false);
  assert.equal(other.count, 1);

  // Same group, different bot -> also isolated.
  const other2 = counter.record("group-A", "bot-2");
  assert.equal(other2.muted, false);
  assert.equal(other2.count, 1);

  assert.equal(counter.isMuted("group-A", "bot-1"), true);
  assert.equal(counter.isMuted("group-B", "bot-1"), false);
});

void test("BotLoopCounter: threshold=1 -> first message trips mute immediately", () => {
  const clock = makeClock();
  const counter = new BotLoopCounter({
    threshold: 1,
    windowMs: 10 * 60 * 1000,
    muteMs: 30 * 60 * 1000,
    now: clock.now,
  });

  const r = counter.record("g", "b");
  assert.equal(r.muted, true);
  assert.equal(r.justEnteredMute, true);
  assert.equal(r.count, 1);
});

void test("BotLoopCounter: isMuted is read-only", () => {
  const clock = makeClock();
  const counter = new BotLoopCounter({
    threshold: 3,
    windowMs: 10 * 60 * 1000,
    muteMs: 30 * 60 * 1000,
    now: clock.now,
  });

  assert.equal(counter.isMuted("g", "b"), false);
  // isMuted should not create an entry.
  assert.equal(counter.size(), 0);

  counter.record("g", "b");
  assert.equal(counter.isMuted("g", "b"), false);
  counter.record("g", "b");
  counter.record("g", "b");
  assert.equal(counter.isMuted("g", "b"), true);
});

void test("BotLoopCounter: reset clears state", () => {
  const clock = makeClock();
  const counter = new BotLoopCounter({
    threshold: 3,
    windowMs: 10 * 60 * 1000,
    muteMs: 30 * 60 * 1000,
    now: clock.now,
  });

  counter.record("g", "b");
  counter.record("g", "b");
  counter.record("g", "b");
  assert.equal(counter.isMuted("g", "b"), true);

  counter.reset("g", "b");
  assert.equal(counter.isMuted("g", "b"), false);
  assert.equal(counter.size(), 0);

  counter.record("g", "b");
  counter.record("g2", "b2");
  counter.reset();
  assert.equal(counter.size(), 0);
});

void test("BotLoopCounter: lazy cleanup drops fully-expired entries", () => {
  const clock = makeClock();
  const counter = new BotLoopCounter({
    threshold: 3,
    windowMs: 10 * 60 * 1000,
    muteMs: 30 * 60 * 1000,
    now: clock.now,
    cleanupMinIntervalMs: 0, // cleanup on every call
  });

  counter.record("g1", "b");
  counter.record("g2", "b");
  assert.equal(counter.size(), 2);

  // Advance past both window and mute expiry.
  clock.advance(31 * 60 * 1000);
  // Trigger cleanup via an unrelated record.
  counter.record("g3", "b");

  // g1/g2 should be gone; g3 remains.
  assert.equal(counter.size(), 1);
});
