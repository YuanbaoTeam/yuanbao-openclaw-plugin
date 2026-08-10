/**
 * Trace helpers — thin wrapper over `@opentelemetry/api` trace API.
 *
 * The plugin only uses the OTel **API** package; the global SDK / exporter is
 * registered by OpenClaw's `diagnostics-otel` plugin. When no global provider
 * is present (local dev, tests, diagnostics disabled) every call degrades to a
 * no-op automatically.
 *
 * Compliance red line: span attributes must NEVER carry message text, phone
 * numbers, or any PII. `safeAttributes` strips non-scalar values and truncates
 * strings as a backstop.
 */

import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import type { Attributes } from "@opentelemetry/api";
import { buildRemoteParentOtelContext } from "../business/trace/context.js";
import type { DeviceInfo } from "./env.js";

const TRACER_NAME = "openclaw-plugin-yuanbao";

/** Stable span names (dotted, OTel-style). */
export const SPAN = {
  pipelineExecute: "pipeline.execute",
} as const;

/** Auth-bind deviceInfo + deployment fields on `pipeline.execute`. */
export const SPAN_ATTR = {
  appVersion: "device.app_version",
  appOperationSystem: "device.app_operation_system",
  botVersion: "device.bot_version",
  /** Proto `instance_id` — terminal/access-party type (OpenClaw=16), not host instance. */
  terminalType: "device.terminal_type",
  hostInstanceId: "deployment.host_instance_id",
  /** IM bot uid from sign-token (`account.botId`), distinct from config `account`. */
  botId: "yuanbao.bot_id",
} as const;

export type PipelineExecuteSpanParams = {
  chat: string;
  account?: string;
  botId?: string;
  deviceInfo?: DeviceInfo;
  hostInstanceId?: string;
};

/** Build scalar-only attributes for the inbound `pipeline.execute` span. */
export function buildPipelineExecuteSpanAttributes(
  params: PipelineExecuteSpanParams,
): Attributes {
  const attrs: Attributes = { chat: params.chat };
  if (params.account) {
    attrs.account = params.account;
  }
  if (params.botId) {
    attrs[SPAN_ATTR.botId] = params.botId;
  }
  const device = params.deviceInfo;
  if (device) {
    if (device.appVersion) {
      attrs[SPAN_ATTR.appVersion] = device.appVersion;
    }
    if (device.appOperationSystem) {
      attrs[SPAN_ATTR.appOperationSystem] = device.appOperationSystem;
    }
    if (device.botVersion) {
      attrs[SPAN_ATTR.botVersion] = device.botVersion;
    }
    if (device.instanceId) {
      attrs[SPAN_ATTR.terminalType] = device.instanceId;
    }
  }
  if (params.hostInstanceId) {
    attrs[SPAN_ATTR.hostInstanceId] = params.hostInstanceId;
  }
  return attrs;
}

let tracerVersion = "0.0.0";

/** Set the tracer version (plugin version); optional, called once at init. */
export function setTelemetryVersion(version: string): void {
  if (version) {
    tracerVersion = version;
  }
}

function getTracer() {
  return trace.getTracer(TRACER_NAME, tracerVersion);
}

const MAX_ATTR_STR_LEN = 128;

/**
 * Drop anything that isn't a scalar (objects/arrays could smuggle PII) and
 * truncate long strings. Returns undefined when there is nothing to keep.
 */
export function safeAttributes(attrs?: Attributes): Attributes | undefined {
  if (!attrs) {
    return undefined;
  }
  const out: Attributes = {};
  let kept = false;
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null) {
      continue;
    }
    if (typeof value === "string") {
      out[key] = value.length > MAX_ATTR_STR_LEN ? value.slice(0, MAX_ATTR_STR_LEN) : value;
      kept = true;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
      kept = true;
    }
    // objects / arrays are intentionally dropped to avoid leaking content
  }
  return kept ? out : undefined;
}

/**
 * Run `fn` inside an active OTel span. Prefers inbound `traceId` (server logExt)
 * over W3C `traceparent`: locally generated traceparent uses a random span id
 * that was never exported, so linking via trace_id keeps APM correlation aligned
 * with the backend. Falls back to traceparent when traceId is absent.
 */
export async function withActiveSpan<T>(
  name: string,
  params: { attributes?: Attributes; traceId?: string; traceparent?: string },
  fn: () => Promise<T>,
): Promise<T> {
  let parentCtx = ROOT_CONTEXT;
  const traceparent = params.traceparent?.trim();
  const traceId = params.traceId?.trim();
  if (traceId) {
    parentCtx = buildRemoteParentOtelContext(traceId);
  } else if (traceparent) {
    parentCtx = propagation.extract(ROOT_CONTEXT, { traceparent });
  }

  const span = getTracer().startSpan(
    name,
    {
      kind: SpanKind.SERVER,
      attributes: safeAttributes(params.attributes),
    },
    parentCtx,
  );

  return context.with(trace.setSpan(parentCtx, span), async () => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      if (err instanceof Error) {
        span.recordException(err);
      }
      throw err;
    } finally {
      span.end();
    }
  });
}

/** Reset tracer version — test-only helper. */
export function __resetTelemetryForTest(): void {
  tracerVersion = "0.0.0";
}
