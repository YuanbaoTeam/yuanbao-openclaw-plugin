/**
 * Message processing pipeline engine.
 *
 * Onion-model middleware engine with conditional guards (when) and named insert/remove support.
 */

import { formatLog } from "../../logger.js";
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
    // ─── [debug] Force-inject topicId into cloud_custom_data ─────────────
    // Temporary workaround: the intermediate hop between TIM webhook and
    // openclaw is stripping `topicId` (both top-level and quote-nested) from
    // cloud_custom_data. Until that owner adds it back to their pick list, we
    // extract a debug topicId from the message text itself so downstream logic
    // (resolve-mention L2 / resolve-route session isolation) can be exercised
    // end-to-end.
    //
    // - The topicId is parsed from any `TIMTextElem` in `msg_body` matching the
    //   pattern `[topicId: <value>]` (case-insensitive, whitespace-tolerant).
    //   The marker is stripped from the text in place so downstream consumers
    //   (extract-content, OpenClaw upstream, etc.) never see the debug tag.
    // - Env var `YUANBAO_FORCE_TOPIC_ID` overrides the parsed value when set.
    // - When neither env nor an inline `[topicId: …]` marker is present, this
    //   block is a no-op.
    // - Only runs on group messages, and never overwrites an existing topicId
    //   coming from upstream — the day the middle hop fixes their pick list,
    //   this workaround auto-yields to the real value.
    //
    // TODO(remove): delete this block once the middle-hop owner adds topicId
    // to their cloud_custom_data pick list.
    const extractInlineTopicId = (): string | undefined => {
      const body = ctx.raw.msg_body;
      if (!Array.isArray(body)) return undefined;
      // Regex matches `[topicId: <value>]` — case-insensitive on the key,
      // trims surrounding whitespace, and accepts any non-`]` chars as value.
      // Also swallows any leading whitespace / newline immediately before the
      // marker so we don't leave a dangling blank line after stripping.
      const RE = /[ \t]*\r?\n?[ \t]*\[\s*topicId\s*:\s*([^\]\s]+)\s*\]/i;
      let found: string | undefined;
      for (const elem of body) {
        if (elem?.msg_type !== "TIMTextElem") continue;
        const text = elem.msg_content?.text;
        if (typeof text !== "string" || text.length === 0) continue;
        const m = RE.exec(text);
        if (!m || !m[1]) continue;
        if (!found) found = m[1];
        // Strip the marker (and its preceding whitespace/newline) from the
        // original text. `msg_content` is a plain object on the inbound
        // payload; mutating in place is safe here.
        const stripped = text.replace(RE, "").replace(/[ \t]+$/gm, "");
        (elem.msg_content as { text?: string }).text = stripped;
      }
      return found;
    };
    const forcedTopicId =
      process.env.YUANBAO_FORCE_TOPIC_ID?.trim() || extractInlineTopicId();
    if (forcedTopicId && ctx.isGroup) {
      try {
        const parsed: Record<string, unknown> = ctx.raw.cloud_custom_data
          ? JSON.parse(ctx.raw.cloud_custom_data)
          : {};
        const existing = parsed.topicId;
        if (typeof existing !== "string" || existing.length === 0) {
          parsed.topicId = forcedTopicId;
          // Mutating a readonly property of `raw` — the readonly is on the
          // reference, not the inner fields. cloud_custom_data is a plain
          // mutable string on YuanbaoInboundMessage.
          (ctx.raw as { cloud_custom_data?: string }).cloud_custom_data =
            JSON.stringify(parsed);
          ctx.log.info(
            `[inbound-inject] forced topicId injected topicId=${forcedTopicId} msgId=${ctx.raw.msg_id ?? ""}`,
          );
        } else {
          ctx.log.info(
            `[inbound-inject] skip — upstream already has topicId=${existing} msgId=${ctx.raw.msg_id ?? ""}`,
          );
        }
      } catch (err) {
        ctx.log.warn(
          `[inbound-inject] failed to inject topicId: ${String(err)}`,
        );
      }
    }

    // [inbound-raw] Dump the full raw message payload as delivered by openclaw
    // gateway — before any middleware mutates ctx. Uses skipSanitize so
    // normally-masked fields (cloud_custom_data / user_input / …) are visible.
    //
    // NOTE: route through ctx.log (SDK-provided sink, identical path as
    // [extract-content]) instead of the plugin `logger` singleton — the
    // singleton's child logger appears to write to a different sink that does
    // not surface in gateway.log for this call site. We pre-render with
    // formatLog(skipSanitize=true) and pass the finished string as `msg`
    // (data omitted) so ctx.log.info won't re-sanitize it.
    try {
      const line = formatLog(
        "pipeline",
        "[inbound-raw] full raw payload",
        {
          isGroup: ctx.isGroup,
          msgId: ctx.raw.msg_id,
          fromAccount: ctx.raw.from_account,
          groupCode: ctx.raw.group_code ?? ctx.raw.group_id,
          senderNickname: ctx.raw.sender_nickname,
          raw: ctx.raw,
        },
        true, // skipSanitize
      );
      ctx.log.info(line);
    } catch (err) {
      ctx.log.error(`[inbound-raw] serialize failed: ${String(err)}`);
    }

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
