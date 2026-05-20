/**
 * Middleware: rewrite slash commands + append quote context + append mentions.
 */

import { formatQuoteContext } from "../../messaging/quote.js";
import { formatThreadContext } from "../../messaging/thread-info.js";
import type { MiddlewareDescriptor } from "../types.js";

/** Regex for /yuanbao-health-check with optional start_time and end_time (HH:MM) */
const SLASH_HEALTH_CHECK_RE = /^\/yuanbao-health-check(?:\s+(\d{1,2}:\d{2})(?:\s+(\d{1,2}:\d{2}))?)?\s*$/;

/**
 * Rewrite recognized slash commands into natural language queries.
 */
function rewriteSlashCommand(
  text: string,
  onRewrite?: (original: string, rewritten: string) => void,
): string {
  const trimmed = text.trim();
  const match = SLASH_HEALTH_CHECK_RE.exec(trimmed);
  if (!match) {
    return text;
  }

  const startTime = match[1];
  const endTime = match[2];

  const result = startTime && endTime
    ? `Query openclaw system [yuanbao channel] warn and error logs from ${startTime} to ${endTime}`
    : "Query openclaw system [yuanbao channel] warn and error logs in the last 10 minutes";

  const prompt = `
    ${result}

    **Requirements**:
    - Do not output your reasoning process
    - Only list log summaries, no code-level analysis
    - Output in plain text, no Markdown syntax
    - One log summary per line, no leading symbols
  `;

  onRewrite?.(text, prompt);

  return prompt;
}

export const rewriteBody: MiddlewareDescriptor = {
  name: "rewrite-body",
  handler: async (ctx, next) => {
    const { rawBody, threadInfo, quoteInfo, mentions, isGroup, account } = ctx;

    // Slash command rewrite
    const rewritten = rewriteSlashCommand(rawBody, (orig, result) => {
      ctx.log.info("[rewrite-body] command rewrite", { orig, result });
    });

    const parts: string[] = [];

    // Thread context prefix (outermost, provides conversation topic background)
    if (threadInfo) {
      parts.push(formatThreadContext(threadInfo));
    }

    // Quote context prefix
    if (quoteInfo) {
      parts.push(formatQuoteContext(quoteInfo));
    }

    // Main body
    parts.push(rewritten);

    ctx.rewrittenBody = parts.join("\n\n");

    // Group chat scenario: mentions metadata goes to UntrustedContext (not injected into body)
    if (isGroup && mentions && mentions.length > 0) {
      const untrusted: string[] = [];
      if (ctx.botUsername) {
        untrusted.push(`BotUsername(self): ${ctx.botUsername}`);
      }
      untrusted.push(`Message mentions the following users: ${mentions.map(m => `${m.text}(userId: ${m.userId})`).join(", ")}`);
      ctx.untrustedContext = untrusted;
    }

    await next();
  },
};
