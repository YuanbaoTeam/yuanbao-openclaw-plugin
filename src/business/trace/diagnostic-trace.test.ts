/**
 * Unit tests for inbound DiagnosticTrace propagation helper.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import test from "node:test";

const DIAGNOSTIC_TRACE_SCOPE_STATE_KEY = Symbol.for("openclaw.diagnosticTraceScope.state.v1");

const TRACE_ID = "558548be9c0eef30fa5656815d8ce5e5";
const SPAN_ID = "1111111111111111";
const TRACEPARENT = `00-${TRACE_ID}-${SPAN_ID}-01`;

type HostTrace = { traceId?: string; spanId?: string; traceFlags?: string };

function inboundTraceContext(traceparent = TRACEPARENT) {
  return { traceId: TRACE_ID, traceparent, nextMsgSeq: () => 1 };
}

/** Stand in for the host's lazily created DiagnosticTrace scope state. */
function installHostScope(): {
  storage: AsyncLocalStorage<HostTrace>;
  uninstall: () => void;
} {
  const storage = new AsyncLocalStorage<HostTrace>();
  Object.defineProperty(globalThis, DIAGNOSTIC_TRACE_SCOPE_STATE_KEY, {
    configurable: true,
    enumerable: false,
    value: { marker: DIAGNOSTIC_TRACE_SCOPE_STATE_KEY, storage },
    writable: false,
  });
  return {
    storage,
    uninstall: () => {
      delete (globalThis as Record<symbol, unknown>)[DIAGNOSTIC_TRACE_SCOPE_STATE_KEY];
    },
  };
}

function removeHostScope(): void {
  delete (globalThis as Record<symbol, unknown>)[DIAGNOSTIC_TRACE_SCOPE_STATE_KEY];
}

const passthroughCreate = (input: HostTrace): HostTrace => ({ ...input });

void test("delegates to the host runner when the SDK exports one", async (t) => {
  let captured: HostTrace | undefined;
  t.mock.module("openclaw/plugin-sdk/diagnostic-runtime", {
    namedExports: {
      createDiagnosticTraceContext: passthroughCreate,
      runWithDiagnosticTraceContext: async (trace: HostTrace, callback: () => unknown) => {
        captured = trace;
        return await callback();
      },
    },
  });

  const { runWithInboundDiagnosticTrace } = await import("./diagnostic-trace.js");
  let ran = false;
  await runWithInboundDiagnosticTrace(inboundTraceContext(), async () => {
    ran = true;
  });

  assert.equal(ran, true);
  assert.deepEqual(captured, { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: "01" });
});

void test("writes the host scope directly when the SDK omits the runner", async (t) => {
  t.mock.module("openclaw/plugin-sdk/diagnostic-runtime", {
    namedExports: { createDiagnosticTraceContext: passthroughCreate },
  });
  const scope = installHostScope();
  t.after(scope.uninstall);

  const { runWithInboundDiagnosticTrace } = await import("./diagnostic-trace.js");
  let seen: HostTrace | undefined;
  await runWithInboundDiagnosticTrace(inboundTraceContext(), async () => {
    await Promise.resolve();
    seen = scope.storage.getStore();
  });

  assert.equal(seen?.traceId, TRACE_ID);
  assert.equal(seen?.spanId, SPAN_ID);
  assert.equal(scope.storage.getStore(), undefined);
});

void test("triggers host lazy init when the scope has not been created yet", async (t) => {
  removeHostScope();
  let storage: AsyncLocalStorage<HostTrace> | undefined;
  t.mock.module("openclaw/plugin-sdk/diagnostic-runtime", {
    namedExports: {
      createDiagnosticTraceContext: passthroughCreate,
      createDiagnosticTraceContextFromActiveScope: () => {
        storage = installHostScope().storage;
        return { traceId: TRACE_ID };
      },
    },
  });
  t.after(removeHostScope);

  const { runWithInboundDiagnosticTrace } = await import("./diagnostic-trace.js");
  let seen: HostTrace | undefined;
  await runWithInboundDiagnosticTrace(inboundTraceContext(), async () => {
    seen = storage?.getStore();
  });

  assert.equal(seen?.traceId, TRACE_ID);
});

void test("keeps the backend trace id when the host creator returns a different one", async (t) => {
  t.mock.module("openclaw/plugin-sdk/diagnostic-runtime", {
    namedExports: {
      createDiagnosticTraceContext: () => ({ traceId: "f".repeat(32), spanId: SPAN_ID }),
    },
  });
  const scope = installHostScope();
  t.after(scope.uninstall);

  const { runWithInboundDiagnosticTrace } = await import("./diagnostic-trace.js");
  let seen: HostTrace | undefined;
  await runWithInboundDiagnosticTrace(inboundTraceContext(), async () => {
    seen = scope.storage.getStore();
  });

  assert.equal(seen?.traceId, TRACE_ID);
});

void test("seeds a host-compatible scope when the host has not created one", async (t) => {
  removeHostScope();
  t.mock.module("openclaw/plugin-sdk/diagnostic-runtime", {
    namedExports: { createDiagnosticTraceContext: passthroughCreate },
  });
  t.after(removeHostScope);

  const { runWithInboundDiagnosticTrace } = await import("./diagnostic-trace.js");
  await runWithInboundDiagnosticTrace(inboundTraceContext(), async () => {
    await Promise.resolve();
  });

  // Shape the host's own `getDiagnosticTraceScopeState` validates before adopting.
  const seeded = (globalThis as Record<symbol, unknown>)[DIAGNOSTIC_TRACE_SCOPE_STATE_KEY] as
    | { marker?: unknown; storage?: unknown }
    | undefined;
  assert.equal(seeded?.marker, DIAGNOSTIC_TRACE_SCOPE_STATE_KEY);
  assert.ok(seeded?.storage instanceof AsyncLocalStorage);
});

void test("never replaces a scope the host already owns", async (t) => {
  t.mock.module("openclaw/plugin-sdk/diagnostic-runtime", {
    namedExports: { createDiagnosticTraceContext: passthroughCreate },
  });
  const scope = installHostScope();
  t.after(scope.uninstall);

  const { runWithInboundDiagnosticTrace } = await import("./diagnostic-trace.js");
  await runWithInboundDiagnosticTrace(inboundTraceContext(), async () => {});

  const current = (globalThis as Record<symbol, unknown>)[DIAGNOSTIC_TRACE_SCOPE_STATE_KEY] as {
    storage?: unknown;
  };
  assert.equal(current.storage, scope.storage);
});

void test("does not write a scope for an unusable traceparent", async (t) => {
  t.mock.module("openclaw/plugin-sdk/diagnostic-runtime", {
    namedExports: { createDiagnosticTraceContext: passthroughCreate },
  });
  const scope = installHostScope();
  t.after(scope.uninstall);

  const { runWithInboundDiagnosticTrace, __resetDiagnosticTraceWarningsForTest } = await import(
    "./diagnostic-trace.js"
  );
  __resetDiagnosticTraceWarningsForTest();
  let seen: HostTrace | undefined | null = null;
  await runWithInboundDiagnosticTrace(inboundTraceContext("not-a-traceparent"), async () => {
    seen = scope.storage.getStore();
  });

  assert.equal(seen, undefined);
});
