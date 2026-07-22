/**
 * Unit test for resolve-trace middleware — injects ctx.traceContext and continues.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { resolveTrace } from "./resolve-trace.js";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

void test("resolve-trace populates ctx.traceContext from raw trace fields and calls next", async () => {
  const ctx = createMockCtx({ raw: { trace_id: "tr-1", seq_id: "9", msg_body: [], from_account: "u", msg_id: "m", msg_seq: 9 } as never });
  const { next, wasCalled } = createMockNext();
  await resolveTrace.handler(ctx, next);
  assert.ok(ctx.traceContext);
  assert.equal(ctx.traceContext!.traceId, "tr-1");
  assert.equal(ctx.traceContext!.seqId, "9");
  assert.equal(wasCalled(), true);
});

void test("resolve-trace generates a traceId when none provided", async () => {
  const ctx = createMockCtx({ raw: { msg_body: [], from_account: "u", msg_id: "m" } as never });
  const { next } = createMockNext();
  await resolveTrace.handler(ctx, next);
  assert.match(ctx.traceContext!.traceId, /^[0-9a-f]{32}$/);
});

void test("resolve-trace preserves engine-seeded traceContext and refreshes traceparent", async () => {
  const ctx = createMockCtx({
    raw: { trace_id: "tr-1", seq_id: "9", msg_body: [], from_account: "u", msg_id: "m" } as never,
    traceContext: {
      traceId: "tr-1",
      traceparent: "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01",
      seqId: "9",
      nextMsgSeq: () => 10,
    },
  });
  const { next, wasCalled } = createMockNext();
  await resolveTrace.handler(ctx, next);
  assert.equal(ctx.traceContext!.traceId, "tr-1");
  assert.equal(ctx.traceContext!.seqId, "9");
  assert.equal(wasCalled(), true);
});
