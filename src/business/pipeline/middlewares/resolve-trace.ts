/**
 * Middleware: parse or generate trace context from inbound message trace_id / seq_id.
 * Injected into ctx.traceContext for downstream middlewares and transport layer.
 */

import { getActiveTraceparent, resolveTraceContext } from "../../trace/context.js";
import type { MiddlewareDescriptor } from "../types.js";

export const resolveTrace: MiddlewareDescriptor = {
  name: "resolve-trace",
  handler: async (ctx, next) => {
    // Engine seeds ctx.traceContext; refresh seq_id here and merge active OTel span.
    ctx.traceContext = ctx.traceContext ?? resolveTraceContext({
      traceId: ctx.raw.trace_id,
      seqId: ctx.raw.seq_id ?? ctx.raw.msg_seq,
    });

    const activeTraceparent = getActiveTraceparent();
    if (activeTraceparent) {
      ctx.traceContext = { ...ctx.traceContext, traceparent: activeTraceparent };
    }

    ctx.log.debug("[resolve-trace] trace context resolved", {
      traceId: ctx.traceContext.traceId,
      seqId: ctx.traceContext.seqId ?? "(none)",
      traceparent: ctx.traceContext.traceparent,
    });

    await next();
  },
};
