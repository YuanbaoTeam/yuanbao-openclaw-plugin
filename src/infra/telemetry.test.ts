/**
 * Unit tests for infra/telemetry.ts.
 *
 * No global OTel SDK is registered in tests, so the API returns no-op
 * instruments — the emit helpers must stay safe (never throw). We also verify
 * the `safeAttributes` PII/scalar guard.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  SPAN,
  SPAN_ATTR,
  buildPipelineExecuteSpanAttributes,
  safeAttributes,
  setTelemetryVersion,
  withActiveSpan,
  __resetTelemetryForTest,
} from "./telemetry.js";

void test("safeAttributes keeps scalars and drops non-scalar / nullish values", () => {
  const out = safeAttributes({
    state: "connected",
    count: 3,
    ok: true,
    nested: { secret: "13800000000" } as unknown as string,
    list: [1, 2] as unknown as number,
    empty: null,
    missing: undefined,
  });
  assert.deepEqual(out, { state: "connected", count: 3, ok: true });
});

void test("safeAttributes truncates long strings to 128 chars", () => {
  const long = "x".repeat(200);
  const out = safeAttributes({ blob: long });
  assert.equal((out?.blob as string).length, 128);
});

void test("safeAttributes returns undefined when nothing survives", () => {
  assert.equal(safeAttributes(undefined), undefined);
  assert.equal(safeAttributes({}), undefined);
  assert.equal(safeAttributes({ a: null, b: { x: 1 } as unknown as string }), undefined);
});

void test("withActiveSpan is no-op safe without a registered SDK", async () => {
  __resetTelemetryForTest();
  setTelemetryVersion("9.9.9");
  const result = await withActiveSpan(
    SPAN.pipelineExecute,
    { traceId: "abcdef0123456789abcdef0123456789", attributes: { chat: "c2c" } },
    async () => "ok",
  );
  assert.equal(result, "ok");
  await assert.rejects(
    () => withActiveSpan(SPAN.pipelineExecute, {}, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
});

void test("buildPipelineExecuteSpanAttributes stamps deviceInfo and host instance", () => {
  const attrs = buildPipelineExecuteSpanAttributes({
    chat: "c2c",
    account: "bot-a",
    botId: "yb-bot-uid-001",
    deviceInfo: {
      appVersion: "2.17.0",
      appOperationSystem: "Darwin",
      botVersion: "2026.6.5",
      instanceId: "16",
    },
    hostInstanceId: "yb_prod_001",
  });
  assert.deepEqual(attrs, {
    chat: "c2c",
    account: "bot-a",
    [SPAN_ATTR.botId]: "yb-bot-uid-001",
    [SPAN_ATTR.appVersion]: "2.17.0",
    [SPAN_ATTR.appOperationSystem]: "Darwin",
    [SPAN_ATTR.botVersion]: "2026.6.5",
    [SPAN_ATTR.terminalType]: "16",
    [SPAN_ATTR.hostInstanceId]: "yb_prod_001",
  });
});
