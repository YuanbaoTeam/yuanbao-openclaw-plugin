/**
 * Cross-plugin inbound trace channel.
 *
 * Observability plugins (e.g. openclaw-apm-tracing) need the upstream traceId
 * of the message currently being handled, but OpenClaw does not put trace
 * fields on the inbound `message_received` hook context — only on the outbound
 * `message_sending` / `message_sent` ones. The two indirect relays both have
 * preconditions that can fail: the host DiagnosticTrace scope needs a host that
 * exports `runWithDiagnosticTraceContext`, and the ambient OTel context needs
 * diagnostics-otel to have finished installing a global ContextManager. This
 * channel is a direct alternative with neither precondition.
 *
 * Contract — channel-agnostic, any channel plugin may publish:
 *
 *   globalThis[Symbol.for("openclaw.plugin.inboundTrace.v1")] = {
 *     marker: <that same symbol>,
 *     storage: AsyncLocalStorage<PublishedInboundTrace>,
 *   }
 *
 * Keyed off `globalThis` + `Symbol.for` so it survives the plugin bundle being
 * loaded in several module scopes. Consumers must tolerate the entry being
 * absent and must not mutate it.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type PublishedInboundTrace = {
  /** 32-char lowercase hex, already normalized to W3C form. */
  traceId: string;
  /** 16-char lowercase hex parent span id, when known. */
  spanId?: string;
  /** Publishing channel id, for diagnostics only. */
  channel?: string;
};

const INBOUND_TRACE_CHANNEL_KEY = Symbol.for("openclaw.plugin.inboundTrace.v1");

type InboundTraceChannelState = {
  marker: symbol;
  storage: AsyncLocalStorage<PublishedInboundTrace>;
};

function isChannelState(value: unknown): value is InboundTraceChannelState {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as InboundTraceChannelState;
  return candidate.marker === INBOUND_TRACE_CHANNEL_KEY
    && candidate.storage instanceof AsyncLocalStorage;
}

function getChannelState(): InboundTraceChannelState {
  const existing = (globalThis as Record<symbol, unknown>)[INBOUND_TRACE_CHANNEL_KEY];
  if (isChannelState(existing)) {
    return existing;
  }
  const state: InboundTraceChannelState = {
    marker: INBOUND_TRACE_CHANNEL_KEY,
    storage: new AsyncLocalStorage<PublishedInboundTrace>(),
  };
  Object.defineProperty(globalThis, INBOUND_TRACE_CHANNEL_KEY, {
    configurable: true,
    enumerable: false,
    value: state,
    writable: false,
  });
  return state;
}

/** Publish `trace` for the duration of `callback` and everything it awaits. */
export function runWithPublishedInboundTrace<T>(
  trace: PublishedInboundTrace,
  callback: () => T,
): T {
  return getChannelState().storage.run(trace, callback);
}

/** Read the trace published by the channel plugin handling the current message. */
export function getPublishedInboundTrace(): PublishedInboundTrace | undefined {
  return getChannelState().storage.getStore();
}
