/**
 * Unit tests for the dispatcher concurrency primitives:
 *  - SessionQueue: per-session serial execution, cross-session parallelism,
 *    generation-based supersede (invalidate), error isolation, auto-cleanup.
 *  - SessionAbortManager: rotate aborts the previous controller; cleanup only
 *    removes a still-current signal.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { SessionAbortManager } from "./session-abort-manager.js";
import { SessionQueue } from "./session-queue.js";

/** A promise plus its resolver, for ordering control. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

// ── SessionQueue ─────────────────────────────────────────────────────────────
void test("SessionQueue runs tasks of the same session serially", async () => {
  const q = new SessionQueue();
  const order: string[] = [];
  const gate = deferred();

  const p1 = q.enqueue("s1", async () => { order.push("t1-start"); await gate.promise; order.push("t1-end"); });
  const p2 = q.enqueue("s1", async () => { order.push("t2"); });

  // t2 must not start until t1 finished.
  await Promise.resolve();
  assert.deepEqual(order, ["t1-start"]);
  gate.resolve();
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["t1-start", "t1-end", "t2"]);
});

void test("SessionQueue runs different sessions in parallel", async () => {
  const q = new SessionQueue();
  const order: string[] = [];
  const g1 = deferred();

  const p1 = q.enqueue("a", async () => { order.push("a-start"); await g1.promise; order.push("a-end"); });
  const p2 = q.enqueue("b", async () => { order.push("b"); });

  await Promise.resolve();
  // b (different session) ran while a is still blocked
  assert.ok(order.includes("b"));
  assert.ok(!order.includes("a-end"));
  g1.resolve();
  await Promise.all([p1, p2]);
});

void test("invalidate supersedes an already-queued task (skipped, not run)", async () => {
  const q = new SessionQueue();
  let ran = false;
  const p = q.enqueue("s1", async () => { ran = true; });
  q.invalidate("s1");
  await p;
  assert.equal(ran, false);
});

void test("a task error is caught and does not break the chain", async () => {
  const q = new SessionQueue();
  const order: string[] = [];
  const p1 = q.enqueue("s1", async () => { throw new Error("boom"); });
  const p2 = q.enqueue("s1", async () => { order.push("after-error"); });
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["after-error"]);
});

void test("SessionQueue cleans up idle chains (activeCount returns to 0)", async () => {
  const q = new SessionQueue();
  await q.enqueue("s1", async () => {});
  assert.equal(q.activeCount, 0);
});

// ── SessionAbortManager ──────────────────────────────────────────────────────
void test("rotate aborts the previous controller and returns a fresh signal", () => {
  const m = new SessionAbortManager();
  const first = m.rotate("s1");
  assert.equal(first.aborted, false);
  const second = m.rotate("s1");
  assert.equal(first.aborted, true, "previous signal should be aborted");
  assert.equal(second.aborted, false);
  assert.equal(m.activeCount, 1);
});

void test("cleanup removes only the still-current signal", () => {
  const m = new SessionAbortManager();
  const sig1 = m.rotate("s1");
  const sig2 = m.rotate("s1"); // sig1 now stale
  m.cleanup("s1", sig1); // stale → no-op
  assert.equal(m.activeCount, 1);
  m.cleanup("s1", sig2); // current → removed
  assert.equal(m.activeCount, 0);
});

void test("independent sessions keep separate controllers", () => {
  const m = new SessionAbortManager();
  m.rotate("a");
  m.rotate("b");
  assert.equal(m.activeCount, 2);
});
