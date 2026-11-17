/**
 * Shared input handling for generated-card tools: exactly one of `express` / `messages`,
 * compiled or parsed, then validated against the Yuanbao xCard rules.
 */

import { compileExpressMessages } from "./express.js";
import { parseGeneratedMessages, validateGeneratedMessages } from "./generated.js";
import type { A2uiMessage } from "./validate.js";

const MAX_ERRORS = 30;

const EXPRESS_RETRY_NOTE = "请再次调用本工具并只修正 express 参数后重试；不要把 Express、<a2ui>、Markdown 代码块或错误详情发给用户。"
  + "对照 express-prompt.md 的组件签名；常见错误：必须定义 root、列表用 _template($/items, item)、不要写 $/items[0] 或自造 JSON schema。";

export type GeneratedInputResult =
  | { ok: true; messages: A2uiMessage[]; source: "express" | "messages" }
  | { ok: false; failure: Record<string, unknown> };

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function failure(error: string, note: string, errors?: string[]): GeneratedInputResult {
  return {
    ok: false,
    failure: {
      ok: false,
      error,
      ...(errors?.length ? { errors: errors.slice(0, MAX_ERRORS) } : {}),
      retryable: true,
      note,
    },
  };
}

/** `messagesNote` is the caller-specific retry hint for the JSONL compatibility path. */
export function prepareGeneratedInput(
  input: { messages?: unknown; express?: unknown },
  messagesNote: string,
): GeneratedInputResult {
  const hasMessages = nonEmptyString(input.messages);
  const hasExpress = nonEmptyString(input.express);
  if (hasMessages === hasExpress) {
    return { ok: false, failure: { ok: false, error: "messages 和 express 必须且只能传一个", retryable: true } };
  }

  if (hasExpress) {
    const compiled = compileExpressMessages(input.express);
    if ("error" in compiled) return failure(compiled.error, EXPRESS_RETRY_NOTE, compiled.errors);
    return { ok: true, messages: compiled.messages, source: "express" };
  }

  const parsed = parseGeneratedMessages(input.messages);
  if ("error" in parsed) return failure(parsed.error, messagesNote);
  const checked = validateGeneratedMessages(parsed.messages);
  if (!checked.ok) return failure("xCard A2UI 校验失败", messagesNote, checked.errors);
  return { ok: true, messages: parsed.messages, source: "messages" };
}
