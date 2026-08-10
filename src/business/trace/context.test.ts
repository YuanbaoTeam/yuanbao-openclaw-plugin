/**
 * Unit tests for business/trace/context.ts — trace id generation, traceparent
 * normalization, seq counter, and AsyncLocalStorage context propagation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { generateTraceId, getActiveTraceContext, getActiveTraceparent, resolveTraceContext, runWithTraceContext } from "./context.js";

void test("generateTraceId returns a 32-char lowercase hex string", () => {
  const id = generateTraceId();
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.notEqual(generateTraceId(), id); // random
});

void test("resolveTraceContext keeps a valid inbound 32-hex traceId in traceparent", () => {
  const traceId = "abcdef0123456789abcdef0123456789";
  const ctx = resolveTraceContext({ traceId, seqId: "100" });
  assert.equal(ctx.traceId, traceId);
  assert.equal(ctx.seqId, "100");
  assert.match(ctx.traceparent, new RegExp(`^00-${traceId}-[0-9a-f]{16}-01$`));
});

void test("resolveTraceContext generates a traceId when absent", () => {
  const ctx = resolveTraceContext({});
  assert.match(ctx.traceId, /^[0-9a-f]{32}$/);
  assert.equal(ctx.seqId, undefined);
});

void test("resolveTraceContext hashes a non-hex traceId for the traceparent", () => {
  const ctx = resolveTraceContext({ traceId: "human-readable-trace-id" });
  assert.equal(ctx.traceId, "human-readable-trace-id"); // preserved as-is
  // traceparent uses a normalized 32-hex (sha256-derived) value
  assert.match(ctx.traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
});

void test("nextMsgSeq increments from the inbound seq, undefined when no seq", () => {
  const withSeq = resolveTraceContext({ traceId: "t", seqId: 10 });
  assert.equal(withSeq.nextMsgSeq(), 11);
  assert.equal(withSeq.nextMsgSeq(), 12);

  const noSeq = resolveTraceContext({ traceId: "t" });
  assert.equal(noSeq.nextMsgSeq(), undefined);
});

void test("getActiveTraceparent returns undefined outside an OTel span", () => {
  assert.equal(getActiveTraceparent(), undefined);
});

void test("runWithTraceContext exposes the context via getActiveTraceContext", async () => {
  assert.equal(getActiveTraceContext(), undefined);
  const ctx = resolveTraceContext({ traceId: "t", seqId: "1" });
  const seen = await runWithTraceContext(ctx, async () => getActiveTraceContext());
  assert.equal(seen, ctx);
  assert.equal(getActiveTraceContext(), undefined); // restored after
});
