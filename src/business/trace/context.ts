import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import {
  createDiagnosticTraceContext,
  parseDiagnosticTraceparent,
  type DiagnosticTraceContext,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { createLog } from "../../logger.js";

export type YuanbaoTraceContext = {
  traceId: string;
  traceparent: string;
  diagnosticTrace?: DiagnosticTraceContext;
  seqId?: string;
  messageId?: string;
  messageSeq?: string;
  /** Auto-incremented based on inbound seqId */
  nextMsgSeq: () => number | undefined;
  /**
   * Mark that an outbound message was successfully delivered via a message
   * action (e.g. sticker/react/send) during this agent run. Used by
   * dispatch-reply to avoid sending the fallback reply when the model already
   * replied through an action rather than the deliver callback.
   */
  markActionDelivered: () => void;
  /** Whether any action-driven outbound succeeded within this agent run. */
  hasActionDelivered: () => boolean;
};

export type YuanbaoTraceSnapshot = {
  traceId: string;
  traceparent: string;
  seqId?: string;
  messageId?: string;
  messageSeq?: string;
};

const TRACE_STORAGE_KEY = Symbol.for("openclaw-plugin-yuanbao.trace-storage.v1");
const globalTraceStore = globalThis as typeof globalThis & {
  [TRACE_STORAGE_KEY]?: AsyncLocalStorage<YuanbaoTraceContext>;
};
const traceStorage = globalTraceStore[TRACE_STORAGE_KEY]
  ?? (globalTraceStore[TRACE_STORAGE_KEY] = new AsyncLocalStorage<YuanbaoTraceContext>());
const EMPTY_TRACE_ID = "0".repeat(32);
const OPENCLAW_DIAGNOSTIC_TRACE_SCOPE_STATE_KEY = Symbol.for("openclaw.diagnosticTraceScope.state.v1");

type OpenClawDiagnosticTraceScopeState = {
  marker: symbol;
  storage: AsyncLocalStorage<DiagnosticTraceContext>;
};

const globalDiagnosticTraceScopeStore = globalThis as typeof globalThis & {
  [OPENCLAW_DIAGNOSTIC_TRACE_SCOPE_STATE_KEY]?: OpenClawDiagnosticTraceScopeState;
};

function isOpenClawDiagnosticTraceScopeState(value: unknown): value is OpenClawDiagnosticTraceScopeState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<OpenClawDiagnosticTraceScopeState>;
  return candidate.marker === OPENCLAW_DIAGNOSTIC_TRACE_SCOPE_STATE_KEY
    && candidate.storage instanceof AsyncLocalStorage;
}

function getOpenClawDiagnosticTraceStorage(): AsyncLocalStorage<DiagnosticTraceContext> {
  const existing = globalDiagnosticTraceScopeStore[OPENCLAW_DIAGNOSTIC_TRACE_SCOPE_STATE_KEY];
  if (isOpenClawDiagnosticTraceScopeState(existing)) {
    return existing.storage;
  }

  const state: OpenClawDiagnosticTraceScopeState = {
    marker: OPENCLAW_DIAGNOSTIC_TRACE_SCOPE_STATE_KEY,
    storage: new AsyncLocalStorage<DiagnosticTraceContext>(),
  };
  Object.defineProperty(globalDiagnosticTraceScopeStore, OPENCLAW_DIAGNOSTIC_TRACE_SCOPE_STATE_KEY, {
    configurable: true,
    enumerable: false,
    value: state,
    writable: false,
  });
  return state.storage;
}

function generateHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Generate a random trace ID (32-char hex string).
 * Used as fallback when inbound message has no trace_id.
 */ export function generateTraceId(): string {
  return generateHex(16);
}

function normalizeTraceIdForTraceparent(traceId: string): string {
  const normalized = traceId
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "");
  if (normalized.length >= 32) {
    const candidate = normalized.slice(0, 32);
    if (candidate !== EMPTY_TRACE_ID) {
      return candidate;
    }
  }

  const hashed = createHash("sha256").update(traceId.trim())
    .digest("hex")
    .slice(0, 32);
  if (hashed !== EMPTY_TRACE_ID) {
    return hashed;
  }

  return generateTraceId();
}

function buildTraceparent(traceId: string): string {
  return `00-${normalizeTraceIdForTraceparent(traceId)}-${generateHex(8)}-01`;
}

function buildOpenClawDiagnosticTrace(traceparent: string): DiagnosticTraceContext {
  return parseDiagnosticTraceparent(traceparent) ?? createDiagnosticTraceContext({ traceparent });
}

function normalizeSeqId(seqId?: string | number): string | undefined {
  if (seqId === undefined || seqId === null) {
    return undefined;
  }
  const normalized = String(seqId).trim();
  return normalized || undefined;
}

function normalizeOptionalString(value?: string | number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

/**
 * Resolve or generate a complete trace context.
 * Prefers inbound traceId; generates one if missing.
 * Also parses the associated seq_id.
 */
export function resolveTraceContext(params: {
  traceId?: string;
  seqId?: string | number;
  messageId?: string | number;
  messageSeq?: string | number;
}): YuanbaoTraceContext {
  const incomingTraceId = params.traceId?.trim();
  const traceId = incomingTraceId || generateTraceId();
  const seqId = normalizeSeqId(params.seqId);
  const messageId = normalizeOptionalString(params.messageId);
  const messageSeq = normalizeOptionalString(params.messageSeq);

  const baseSeq = seqId ? parseInt(seqId, 10) : NaN;
  let seqCounter = 0;
  const nextMsgSeq = (): number | undefined => {
    if (Number.isNaN(baseSeq)) {
      return undefined;
    }
    seqCounter++;
    return baseSeq + seqCounter;
  };

  let actionDelivered = false;
  const markActionDelivered = (): void => {
    actionDelivered = true;
  };
  const hasActionDelivered = (): boolean => actionDelivered;

  const log = createLog("trace");
  log.debug("[msg-trace] resolve context", {
    traceId,
    generated: !incomingTraceId,
    seqId: seqId ?? "(none)",
    messageId: messageId ?? "(none)",
  });

  const traceparent = buildTraceparent(traceId);

  return {
    traceId,
    traceparent,
    diagnosticTrace: buildOpenClawDiagnosticTrace(traceparent),
    nextMsgSeq,
    markActionDelivered,
    hasActionDelivered,
    ...(seqId ? { seqId } : {}),
    ...(messageId ? { messageId } : {}),
    ...(messageSeq ? { messageSeq } : {}),
  };
}

/**
 * Get the trace context from the current async context (via AsyncLocalStorage).
 */
export function getActiveTraceContext(): YuanbaoTraceContext | undefined {
  return traceStorage.getStore();
}

/**
 * Return a read-only serializable view of the active trace context.
 */
export function getActiveYuanbaoTraceSnapshot(): YuanbaoTraceSnapshot | undefined {
  const ctx = getActiveTraceContext();
  if (!ctx) {
    return undefined;
  }

  return {
    traceId: ctx.traceId,
    traceparent: ctx.traceparent,
    ...(ctx.seqId ? { seqId: ctx.seqId } : {}),
    ...(ctx.messageId ? { messageId: ctx.messageId } : {}),
    ...(ctx.messageSeq ? { messageSeq: ctx.messageSeq } : {}),
  };
}

/**
 * Run an async callback within the given trace context.
 * Inside the callback (and all spawned async ops), the context is available
 * via {@link getActiveTraceContext}, and the fetch interceptor auto-injects X-Traceparent.
 */
export function runWithTraceContext<T>(
  traceContext: YuanbaoTraceContext,
  callback: () => Promise<T>,
): Promise<T> {
  return traceStorage.run(traceContext, () => {
    if (!traceContext.diagnosticTrace) {
      return callback();
    }

    return getOpenClawDiagnosticTraceStorage().run(traceContext.diagnosticTrace, callback);
  });
}
