import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

// Type aliases

/**
 * Extract OpenClawPluginToolContext from OpenClawPluginApi['registerTool'] params.
 * SDK doesn't export OpenClawPluginToolContext directly, so we derive it via type inference.
 */
type RegisterToolParam = Parameters<OpenClawPluginApi["registerTool"]>[0];

/** Extract the function type (OpenClawPluginToolFactory) from registerTool's union param */
type ToolFactory = Extract<RegisterToolParam, (...args: never[]) => unknown>;

/** Tool context derived from OpenClawPluginToolFactory's first parameter */
export type OpenClawPluginToolContext = Parameters<ToolFactory>[0];

// Session check

/**
 * Check if the current session is a Yuanbao channel group chat.
 *
 * Returns true only when both conditions are met:
 * 1. sessionKey contains `:group:` (group chat)
 * 2. messageChannel is `yuanbao`
 */
export function isYbGroupChat(ctx: OpenClawPluginToolContext): boolean {
  if (ctx.messageChannel === "yuanbao") {
    return ctx.sessionKey?.includes("yuanbao:group:") ?? false;
  }
  return false;
}

// Session parsing

/**
 * Extract groupCode from a Yuanbao group chat sessionKey.
 *
 * sessionKey formats (both supported):
 *   - `agent:<agentId>:yuanbao:group:<groupCode>`
 *   - `agent:<agentId>:yuanbao:group:<groupCode>:topic:<topicId>` (topic-scoped)
 *
 * We split on `:` and take only the first segment after `yuanbao:group:`,
 * so topic-scoped sessions still yield a clean groupCode for downstream
 * IM tools (send-message / member-list / group-info).
 */
export function extractGroupCode(sessionKey: string): string {
  const prefix = "yuanbao:group:";
  const idx = sessionKey.indexOf(prefix);
  if (idx === -1) {
    return "";
  }
  const tail = sessionKey.slice(idx + prefix.length);
  // Stop at the next `:` so `<groupCode>:topic:<topicId>` collapses to `<groupCode>`.
  const nextColon = tail.indexOf(":");
  return nextColon === -1 ? tail : tail.slice(0, nextColon);
}

// MCP response builders

/**
 * Build a plain-text MCP content response.
 */
export function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

/**
 * Build a JSON MCP content response.
 *
 * Serializes data as formatted JSON text, with raw data preserved in `details`.
 */
export function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

// Log desensitization

/**
 * Desensitize a MsgBody array for safe logging.
 * Text messages (TIMTextElem) are masked; other types retain original structure for debugging.
 */export function msgBodyDesensitization(msg_body: Array<{ msg_type?: string; msg_content?: { text?: string } & Record<string, unknown> }>) {
  let log = "";
  msg_body.forEach((item: { msg_type?: string; msg_content?: { text?: string } & Record<string, unknown> }) => {
    if (item.msg_type === "TIMTextElem") {
      log += `[text:${textDesensitization(item.msg_content?.text ?? "") ?? "-"}]`;
    } else {
      log += `[${item.msg_type}:${JSON.stringify(item.msg_content)}]`;
    }
  });
  return log;
}

/**
 * Desensitize text by keeping first and last 2 chars, masking the middle.
 * Returns text as-is when length <= 5.
 */export function textDesensitization(text: string) {
  if (text.length > 5) {
    return `${text.slice(0, 2)}***(${text.length - 4})***${text.slice(-2)}`;
  }
  return text;
}
