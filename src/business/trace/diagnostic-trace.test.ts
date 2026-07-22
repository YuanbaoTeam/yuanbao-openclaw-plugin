/**
 * Unit tests for inbound DiagnosticTrace propagation helper.
 */

import assert from "node:assert/strict";
import test from "node:test";

void test("runWithInboundDiagnosticTrace skips when host lacks runWithDiagnosticTraceContext", async (t) => {
  t.mock.module("openclaw/plugin-sdk/diagnostic-runtime", {
    namedExports: {
      createDiagnosticTraceContext: () => ({
        traceId: "unused",
        spanId: "unused",
        traceFlags: "01",
        traceparent: "",
      }),
    },
  });

  const { runWithInboundDiagnosticTrace } = await import("./diagnostic-trace.js");
  let ran = false;
  await runWithInboundDiagnosticTrace(
    {
      traceId: "558548be9c0eef30fa5656815d8ce5e5",
      traceparent: "00-558548be9c0eef30fa5656815d8ce5e5-1111111111111111-01",
      nextMsgSeq: () => 1,
    },
    async () => {
      ran = true;
    },
  );
  assert.equal(ran, true);
});

void test("runWithInboundDiagnosticTrace delegates to host when available", async (t) => {
  let capturedTraceparent: string | undefined;
  t.mock.module("openclaw/plugin-sdk/diagnostic-runtime", {
    namedExports: {
      createDiagnosticTraceContext: (input: { traceparent?: string }) => {
        capturedTraceparent = input.traceparent;
        return {
          traceId: "558548be9c0eef30fa5656815d8ce5e5",
          spanId: "1111111111111111",
          traceFlags: "01",
          traceparent: input.traceparent ?? "",
        };
      },
      runWithDiagnosticTraceContext: async (_trace: unknown, callback: () => unknown) =>
        callback(),
    },
  });

  const { runWithInboundDiagnosticTrace } = await import("./diagnostic-trace.js");
  await runWithInboundDiagnosticTrace(
    {
      traceId: "558548be9c0eef30fa5656815d8ce5e5",
      traceparent: "00-558548be9c0eef30fa5656815d8ce5e5-1111111111111111-01",
      nextMsgSeq: () => 1,
    },
    async () => {},
  );
  assert.equal(
    capturedTraceparent,
    "00-558548be9c0eef30fa5656815d8ce5e5-1111111111111111-01",
  );
});
