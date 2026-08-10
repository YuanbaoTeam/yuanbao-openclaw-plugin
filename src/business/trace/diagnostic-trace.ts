import type { YuanbaoTraceContext } from "./context.js";

type DiagnosticRuntimeModule = typeof import("openclaw/plugin-sdk/diagnostic-runtime");

/**
 * Propagate backend trace into OpenClaw DiagnosticTrace (logger JSON traceId field).
 * Uses dynamic import so older hosts without `runWithDiagnosticTraceContext` still load.
 */
export async function runWithInboundDiagnosticTrace<T>(
  traceContext: YuanbaoTraceContext,
  callback: () => T | Promise<T>,
): Promise<T> {
  const diagnosticRuntime = (await import(
    "openclaw/plugin-sdk/diagnostic-runtime"
  )) as DiagnosticRuntimeModule & {
    runWithDiagnosticTraceContext?: (
      trace: unknown,
      fn: () => T | Promise<T>,
    ) => T | Promise<T>;
  };

  const runWithDiagnosticTraceContext = diagnosticRuntime.runWithDiagnosticTraceContext;
  if (typeof runWithDiagnosticTraceContext !== "function") {
    return await callback();
  }

  const diagnosticTrace = diagnosticRuntime.createDiagnosticTraceContext({
    traceparent: traceContext.traceparent,
  });
  return await runWithDiagnosticTraceContext(diagnosticTrace, callback);
}
