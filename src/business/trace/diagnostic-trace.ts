/**
 * Bridge the inbound (backend) trace into OpenClaw's DiagnosticTrace scope —
 * the source the host logger stamps as `traceId` on every log line, and the
 * last-resort parent source for the APM plugin.
 *
 * Two ways in, tried in order:
 *
 * 1. `runWithDiagnosticTraceContext` from `openclaw/plugin-sdk/diagnostic-runtime`.
 *    The supported entry point, but as of 2026.7.1 the SDK re-exports only the
 *    read/create helpers and not this setter, so it never actually resolves.
 *    Kept first so we switch over automatically once a host does export it.
 * 2. The scope's AsyncLocalStorage directly. The host parks it on
 *    `globalThis[Symbol.for("openclaw.diagnosticTraceScope.state.v1")]` (see the
 *    host's `src/infra/diagnostic-trace-context.ts`), reachable without the SDK
 *    export and independent of which copy of a module either side loaded. This
 *    is the path that actually runs today, and it seeds the scope itself when
 *    the host has not lazily built it yet.
 *
 * Falling through both leaves the host minting a random traceId per turn, with
 * logs that cannot be joined to the backend trace or to APM spans, so warn once
 * rather than degrade silently.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createLog } from "../../logger.js";
import type { YuanbaoTraceContext } from "./context.js";

type DiagnosticRuntimeModule = typeof import("openclaw/plugin-sdk/diagnostic-runtime");

/** Shape of the host's `DiagnosticTraceContext`. */
type HostDiagnosticTrace = {
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  traceFlags?: string;
};

/**
 * Both extras are optional: `runWithDiagnosticTraceContext` exists in the host
 * but is not re-exported from the plugin SDK, and
 * `createDiagnosticTraceContextFromActiveScope` is missing on older SDKs.
 */
type DiagnosticRuntimeExports = DiagnosticRuntimeModule & {
  createDiagnosticTraceContextFromActiveScope?: () => unknown;
  runWithDiagnosticTraceContext?: <R>(trace: HostDiagnosticTrace, fn: () => R) => R;
};

/** Mirrors the host's `src/infra/diagnostic-trace-context.ts` scope key. */
const DIAGNOSTIC_TRACE_SCOPE_STATE_KEY = Symbol.for("openclaw.diagnosticTraceScope.state.v1");

type DiagnosticTraceScopeState = {
  marker?: unknown;
  storage?: unknown;
};

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

const warnedReasons = new Set<string>();

function warnOnce(reason: string, message: string): void {
  if (warnedReasons.has(reason)) {
    return;
  }
  warnedReasons.add(reason);
  createLog("trace").warn(`[msg-trace] ${message}`);
}

async function loadDiagnosticRuntime(): Promise<DiagnosticRuntimeExports | undefined> {
  try {
    return (await import("openclaw/plugin-sdk/diagnostic-runtime")) as DiagnosticRuntimeExports;
  } catch {
    // Host without the SDK entry point; the globalThis scope may still be there.
    return undefined;
  }
}

function isAllZero(value: string): boolean {
  return /^0+$/.test(value);
}

/**
 * Parse locally rather than handing the raw traceparent to the host's
 * `createDiagnosticTraceContext`, which silently mints a random traceId for
 * input it rejects — exactly the misalignment this module exists to prevent.
 */
function parseTraceparent(traceparent: string): HostDiagnosticTrace | undefined {
  const match = TRACEPARENT_PATTERN.exec(traceparent.trim().toLowerCase());
  if (!match) {
    return undefined;
  }
  const [, traceId, spanId, traceFlags] = match;
  if (isAllZero(traceId) || isAllZero(spanId)) {
    return undefined;
  }
  return { traceId, spanId, traceFlags };
}

/**
 * Let the host normalize the already-validated fields when it can, so the
 * stored object matches whatever shape that host version expects. Falls back to
 * our own object, and rejects a host result that drifted off our trace id.
 */
function buildHostTrace(
  runtime: DiagnosticRuntimeExports | undefined,
  traceparent: string,
): HostDiagnosticTrace | undefined {
  const parsed = parseTraceparent(traceparent);
  if (!parsed) {
    return undefined;
  }
  if (typeof runtime?.createDiagnosticTraceContext === "function") {
    const created = runtime.createDiagnosticTraceContext(parsed) as HostDiagnosticTrace | undefined;
    if (created?.traceId === parsed.traceId) {
      // The host freezes before storing; match that on the direct-write path too.
      return Object.freeze(created);
    }
  }
  return Object.freeze(parsed);
}

function readScopeStorage(): AsyncLocalStorage<HostDiagnosticTrace> | undefined {
  const state = (globalThis as Record<symbol, unknown>)[DIAGNOSTIC_TRACE_SCOPE_STATE_KEY] as
    | DiagnosticTraceScopeState
    | undefined;
  if (!state || state.marker !== DIAGNOSTIC_TRACE_SCOPE_STATE_KEY) {
    return undefined;
  }
  return state.storage instanceof AsyncLocalStorage
    ? (state.storage as AsyncLocalStorage<HostDiagnosticTrace>)
    : undefined;
}

/**
 * The host builds the scope state lazily on first read, so it can legitimately
 * be missing here. Prefer letting the host construct it; failing that, seed it
 * with the exact shape the host's own constructor produces — its
 * `getDiagnosticTraceScopeState` validates marker + storage and adopts whatever
 * is already on the key, so it picks ours up instead of replacing it.
 *
 * Seeding is inert if it ever goes wrong: the key carries a version suffix, so
 * a host that changes the shape moves to a new key and simply never reads this
 * one. Only creating it is safe; overwriting an existing entry is not.
 */
function resolveScopeStorage(
  runtime: DiagnosticRuntimeExports | undefined,
): AsyncLocalStorage<HostDiagnosticTrace> | undefined {
  const existing = readScopeStorage();
  if (existing) {
    return existing;
  }
  if (typeof runtime?.createDiagnosticTraceContextFromActiveScope === "function") {
    runtime.createDiagnosticTraceContextFromActiveScope();
    const hostCreated = readScopeStorage();
    if (hostCreated) {
      return hostCreated;
    }
  }

  try {
    const storage = new AsyncLocalStorage<HostDiagnosticTrace>();
    Object.defineProperty(globalThis, DIAGNOSTIC_TRACE_SCOPE_STATE_KEY, {
      configurable: true,
      enumerable: false,
      value: { marker: DIAGNOSTIC_TRACE_SCOPE_STATE_KEY, storage },
      writable: false,
    });
  } catch {
    // Someone locked the key down with an incompatible value; leave it alone.
    return undefined;
  }
  return readScopeStorage();
}

/**
 * Run `callback` with the inbound trace bound to the host's DiagnosticTrace
 * scope, so host log lines and everything downstream carry the backend traceId.
 */
export async function runWithInboundDiagnosticTrace<T>(
  traceContext: YuanbaoTraceContext,
  callback: () => T | Promise<T>,
): Promise<T> {
  const runtime = await loadDiagnosticRuntime();
  const hostTrace = buildHostTrace(runtime, traceContext.traceparent);
  if (!hostTrace) {
    warnOnce(
      "traceparent",
      `unusable traceparent ${traceContext.traceparent} — inbound traceId will NOT reach logs`,
    );
    return await callback();
  }

  const runWithHostScope = runtime?.runWithDiagnosticTraceContext;
  if (typeof runWithHostScope === "function") {
    return await runWithHostScope(hostTrace, callback);
  }

  const storage = resolveScopeStorage(runtime);
  if (storage) {
    return await storage.run(hostTrace, callback);
  }

  warnOnce(
    "scope",
    "host exposes no DiagnosticTrace scope — inbound traceId will NOT propagate to logs or APM",
  );
  return await callback();
}

/** Clear one-shot warning state — test-only helper. */
export function __resetDiagnosticTraceWarningsForTest(): void {
  warnedReasons.clear();
}
