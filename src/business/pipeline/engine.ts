/**
 * Message processing pipeline engine.
 *
 * Onion-model middleware engine with conditional guards (when) and named insert/remove support.
 */

import { buildDeviceInfo, getHostInstanceId } from "../../infra/env.js";
import {
  SPAN,
  buildPipelineExecuteSpanAttributes,
  withActiveSpan,
} from "../../infra/telemetry.js";
import { runWithInboundDiagnosticTrace } from "../trace/diagnostic-trace.js";
import {
  getActiveTraceparent,
  resolveTraceContext,
  runWithTraceContext,
} from "../trace/context.js";
import type { PipelineContext, MiddlewareDescriptor } from "./types.js";

export class MessagePipeline {
  private readonly middlewares: MiddlewareDescriptor[] = [];

  /** Register middleware at the end of the pipeline */
  use(descriptor: MiddlewareDescriptor): this {
    this.middlewares.push(descriptor);
    return this;
  }

  /** Insert before a named middleware */
  useBefore(targetName: string, descriptor: MiddlewareDescriptor): this {
    const idx = this.middlewares.findIndex(m => m.name === targetName);
    if (idx === -1) {
      this.middlewares.push(descriptor);
    } else {
      this.middlewares.splice(idx, 0, descriptor);
    }
    return this;
  }

  /** Insert after a named middleware */
  useAfter(targetName: string, descriptor: MiddlewareDescriptor): this {
    const idx = this.middlewares.findIndex(m => m.name === targetName);
    if (idx === -1) {
      this.middlewares.push(descriptor);
    } else {
      this.middlewares.splice(idx + 1, 0, descriptor);
    }
    return this;
  }

  /** Remove middleware by name */
  remove(name: string): this {
    const idx = this.middlewares.findIndex(m => m.name === name);
    if (idx !== -1) {
      this.middlewares.splice(idx, 1);
    }
    return this;
  }

  /** Execute the pipeline */
  async execute(ctx: PipelineContext): Promise<void> {
    const chat = ctx.isGroup ? "group" : "c2c";
    const traceContext = resolveTraceContext({
      traceId: ctx.raw.trace_id,
      seqId: ctx.raw.seq_id ?? ctx.raw.msg_seq,
    });
    ctx.traceContext = traceContext;

    await runWithTraceContext(traceContext, async () => {
      await withActiveSpan(
        SPAN.pipelineExecute,
        {
          traceId: traceContext.traceId,
          traceparent: traceContext.traceparent,
          attributes: buildPipelineExecuteSpanAttributes({
            chat,
            account: ctx.account.accountId,
            botId: ctx.account.botId?.trim() || undefined,
            deviceInfo: buildDeviceInfo(),
            hostInstanceId: getHostInstanceId(),
          }),
        },
        async () => {
          const activeTraceparent = getActiveTraceparent();
          const effectiveTraceContext = activeTraceparent
            ? { ...traceContext, traceparent: activeTraceparent }
            : traceContext;
          ctx.traceContext = effectiveTraceContext;

          await runWithInboundDiagnosticTrace(effectiveTraceContext, async () =>
            this.runMiddlewareChain(ctx),
          );
        },
      );
    });
  }

  private async runMiddlewareChain(ctx: PipelineContext): Promise<void> {
    const chain = this.middlewares;
    let index = 0;

    const next = async (): Promise<void> => {
      while (index < chain.length) {
        const mw = chain[index++];

        // Conditional guard: skip middleware when `when` returns false
        if (mw.when && !mw.when(ctx)) {
          continue;
        }

        try {
          await mw.handler(ctx, next);
        } catch (err) {
          ctx.log.error(`middleware [${mw.name}] execution error`, { error: String(err) });
          throw err;
        }
        return;
      }
    };

    await next();
  }
}
