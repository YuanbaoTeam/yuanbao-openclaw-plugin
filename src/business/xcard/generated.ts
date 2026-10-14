/**
 * AI-authored xCard preparation.
 *
 * The xcard-generator Skill produces JSONL (or a JSON array) containing an Inline Surface.
 * This module parses it, applies the plugin-owned surface id and binding metadata, extracts the
 * renderer events the card may emit, and enforces the self-contained runtime subset.
 */

import { OPENCLAW_EXTENSION_KEY } from "./constants.js";
import { validateA2uiMessages, type A2uiMessage, type ValidateResult } from "./validate.js";

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseGeneratedMessages(input: unknown): { messages: A2uiMessage[] } | { error: string } {
  if (typeof input !== "string" || !input.trim()) return { error: "messages 必须是非空 JSONL 或 JSON 数组文本" };
  try {
    const trimmed = input.trim();
    const raw: unknown = trimmed.startsWith("[")
      ? JSON.parse(trimmed)
      : trimmed.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every(isObj)) {
      return { error: "messages 必须包含至少一条 JSON object 消息" };
    }
    return { messages: raw as A2uiMessage[] };
  } catch (err) {
    return { error: `messages 不是合法 JSONL/JSON 数组: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function scanForbidden(v: unknown, at: string, errors: string[]): void {
  if (Array.isArray(v)) {
    v.forEach((item, i) => scanForbidden(item, `${at}[${i}]`, errors));
    return;
  }
  if (!isObj(v)) return;
  if (v.component === "WebCard" || v.component === "xCardTemplate") {
    errors.push(`${at}.component: 自由发送只接受自包含卡片，不支持 ${String(v.component)}`);
  }
  for (const [key, value] of Object.entries(v)) {
    if (key === "tracking") errors.push(`${at}.tracking: 未配置宿主埋点口径，不能发送 tracking`);
    if (key === "call" && typeof value === "string" && value.startsWith("@hostEnv")) {
      errors.push(`${at}.call: 自由发送不允许依赖宿主环境变量`);
    }
    scanForbidden(value, `${at}.${key}`, errors);
  }
}

/** Runtime validation is intentionally stricter than the shared template validator. */
export function validateGeneratedMessages(messages: A2uiMessage[]): ValidateResult {
  const base = validateA2uiMessages(messages);
  const errors = [...base.errors];
  scanForbidden(messages, "messages", errors);
  // Unknown catalog functions are warnings in the shared validator because a controlled
  // template may target a registered host extension. AI-authored cards must be self-contained.
  errors.push(...base.warnings.map((warning) => `${warning}（自由发送不允许未登记宿主函数）`));
  return { ok: errors.length === 0, errors, warnings: [] };
}

/** Event allowlist from component actions, including events nested inside sequence/switch. */
export function extractGeneratedActions(messages: A2uiMessage[]): string[] {
  const names = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (!isObj(v)) return;
    const event = isObj(v.event) ? v.event : undefined;
    if (typeof event?.name === "string" && event.name.trim()) names.add(event.name.trim());
    Object.values(v).forEach(visit);
  };
  for (const message of messages) {
    const update = isObj(message.updateComponents) ? message.updateComponents : undefined;
    if (Array.isArray(update?.components)) visit(update.components);
  }
  return [...names];
}

interface GeneratedRenderState {
  state: string;
  revision: number;
  lastResult?: {
    action: string;
    context: Record<string, unknown>;
    summary?: string;
    userMessage?: string;
  };
}

function generatedResultText(state: GeneratedRenderState): string {
  const fromContext = state.lastResult?.context.resultText;
  if (typeof fromContext === "string" && fromContext.trim()) return fromContext.trim();
  if (state.lastResult?.userMessage?.trim()) return state.lastResult.userMessage.trim();
  if (state.lastResult?.summary?.trim()) return state.lastResult.summary.trim();
  return state.state === "active" ? "" : "操作已完成";
}

/**
 * Clone generated messages for one render, replacing every message surfaceId and merging the
 * plugin extension into createSurface metadata. The AI cannot choose routing identifiers.
 *
 * The plugin-owned `/__openclaw` projection gives generated cards a stable contract for visible
 * post-action feedback. Closed cards also disable the root as a fallback when an authored card
 * omitted the recommended binding.
 */
export function renderGeneratedMessages(
  source: A2uiMessage[],
  surfaceId: string,
  extension: Record<string, unknown>,
  renderState?: GeneratedRenderState,
): A2uiMessage[] {
  const messages = structuredClone(source);
  for (const message of messages) {
    for (const kind of ["createSurface", "updateComponents", "updateDataModel"] as const) {
      const body = isObj(message[kind]) ? message[kind] : undefined;
      if (body) body.surfaceId = surfaceId;
    }
    const create = isObj(message.createSurface) ? message.createSurface : undefined;
    if (!create) continue;
    const metadata = isObj(create.metadata) ? create.metadata : {};
    const extensions = isObj(metadata.extensions) ? metadata.extensions : {};
    create.metadata = {
      ...metadata,
      extensions: { ...extensions, [OPENCLAW_EXTENSION_KEY]: extension },
    };
  }
  if (renderState) {
    if (renderState.state !== "active") {
      for (const message of messages) {
        const update = isObj(message.updateComponents) ? message.updateComponents : undefined;
        if (!Array.isArray(update?.components)) continue;
        const root = update.components.find((component) => isObj(component) && component.id === "root");
        if (isObj(root)) root.enabled = false;
      }
    }
    messages.push({
      version: "v1.0",
      updateDataModel: {
        surfaceId,
        path: "/__openclaw",
        value: {
          state: renderState.state,
          completed: renderState.state !== "active",
          revision: renderState.revision,
          action: renderState.lastResult?.action ?? "",
          context: renderState.lastResult?.context ?? {},
          resultText: generatedResultText(renderState),
        },
      },
    });
  }
  return messages;
}
