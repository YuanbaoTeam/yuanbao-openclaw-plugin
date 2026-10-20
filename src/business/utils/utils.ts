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
 * sessionKey format: `agent:<agentId>:yuanbao:group:<groupCode>`
 * Matches `yuanbao:group:` and returns the trailing part as groupCode.
 */
export function extractGroupCode(sessionKey: string): string {
  const prefix = "yuanbao:group:";
  const idx = sessionKey.indexOf(prefix);
  if (idx === -1) {
    return "";
  }
  return sessionKey.slice(idx + prefix.length);
}

export interface YuanbaoConversationTarget {
  isGroup: boolean;
  targetId: string;
}

/** Session-key scopes that never represent a user-facing Yuanbao conversation turn. */
const NON_CONVERSATIONAL_SESSION_SCOPES = [":cron:", ":subagent:", ":internal-"] as const;

/**
 * Resolve the current Yuanbao conversation.
 *
 * The caller must already have verified that this turn arrived on the Yuanbao channel
 * (ctx.messageChannel): channel identity comes from the host's per-turn context, never
 * from the session key. Group keys always embed `yuanbao:group:<code>`, so groups are
 * recognized from the key. Direct keys, however, change shape with the host's
 * session.dmScope — `yuanbao:direct:<id>` (per-channel-peer), `<account>:direct:<id>`
 * (per-account-channel-peer), `direct:<id>` (per-peer), or no peer at all in
 * `agent:<agentId>:main` (the default "main" scope, shared by every channel). Parsing
 * the key for a `yuanbao:direct:` marker therefore misses most real direct turns, so
 * a non-group Yuanbao turn is treated as a direct chat whose target is the trusted,
 * authenticated requester id (the key suffix is lowercased by the host and unreliable).
 * Derived sessions (cron/subagent/internal) keep returning null so background turns
 * never gain card-sending tools.
 */
export function resolveYuanbaoConversation(
  sessionKey: string,
  requesterSenderId?: string,
): YuanbaoConversationTarget | null {
  const groupCode = extractGroupCode(sessionKey);
  if (groupCode) return { isGroup: true, targetId: groupCode };
  if (NON_CONVERSATIONAL_SESSION_SCOPES.some((scope) => sessionKey.includes(scope))) return null;
  const targetId = requesterSenderId?.trim();
  return targetId ? { isGroup: false, targetId } : null;
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
