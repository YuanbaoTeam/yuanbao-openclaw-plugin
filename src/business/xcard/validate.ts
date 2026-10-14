/**
 * Lightweight structural validation of A2UI v1.0 messages; the unit tests run every template's
 * output through it (open and closed state).
 *
 * This is a subset of the official xcard-generator `validate_xcard_bundle.py` checks, kept in
 * TypeScript so the plugin has no Python / internal-package dependency:
 * envelope + version, message order, a single consistent surfaceId, known component names,
 * resolvable child references and a `root` in the final component set, no Agent-RPC constructs,
 * and a size cap. Property-level schema checks are left to the official validator (dev-time)
 * and to the renderer, which skips unknown non-root components.
 */

import {
  A2UI_VERSION,
  MAX_CARD_CONTENT_BYTES,
  XCARD_CATALOG_ID,
} from "./constants.js";

export type A2uiMessage = Record<string, unknown>;

/** The 39 components of basic + xCard catalogs (v1.0). */
export const XCARD_COMPONENTS: ReadonlySet<string> = new Set([
  "AudioPlayer", "Box", "Button", "Card", "CheckBox", "ChoiceGroup", "ChoicePicker", "Clickable",
  "Column", "ConditionView", "DateTimeInput", "Divider", "DotIndicator", "FlowColumn", "FlowRow",
  "HorizontalGrid", "Icon", "IconButton", "Image", "ItemPicker", "Label", "List", "Modal", "Pager",
  "PlatformSwitch", "RichText", "Row", "Slider", "Stepper", "SvgView", "Switcher", "Tabs", "Text",
  "TextField", "VerticalGrid", "Video", "Visibility", "WebCard", "xCardTemplate",
]);

/** Functions declared by basic + xCard catalogs; `@...` built-ins (e.g. `@index`) are always allowed. */
const KNOWN_FUNCTIONS: ReadonlySet<string> = new Set([
  "add", "and", "closeModal", "contains", "copyContent", "email", "equalsNumber", "equalsString",
  "filter", "formatCurrency", "formatDate", "formatNumber", "formatString", "greaterThan",
  "greaterThanOrEqual", "isEmpty", "join", "length", "lessThan", "lessThanOrEqual", "map", "multiply",
  "not", "numeric", "openHostRoute", "openUrl", "openWechatMiniProgram", "or", "pluralize",
  "publishDataModel", "regex", "rendererVersionAtLeast", "repeatQuery", "required", "select",
  "sendQuery", "sequence", "setTimeout", "subtract", "switch", "toast", "updateData", "urlEncode",
  "yb_chat_repeat", "yb_chat_send_prompt", "yb_navigation_open_host_route", "yb_navigation_open_url",
]);

/** Agent-side function calling is not open for xCard business cards. */
const FORBIDDEN_KEYS = new Set(["callAgentFunction", "agentFunctionResponse"]);

const MESSAGE_KINDS = ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"] as const;
type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface ValidateResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function messageKind(m: A2uiMessage): MessageKind | undefined {
  const kinds = MESSAGE_KINDS.filter((k) => k in m);
  return kinds.length === 1 ? kinds[0] : undefined;
}

/** Component ids a component refers to (child slots only; data-driven templates included). */
function referencedIds(c: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === "string" && v) out.push(v);
  };
  add(c.child);
  if (Array.isArray(c.children)) c.children.forEach(add);
  else if (isObj(c.children)) add(c.children.componentId);
  switch (c.component) {
    case "Modal":
      add(c.trigger);
      add(c.content);
      break;
    case "Switcher":
      add(c.content);
      break;
    case "Tabs":
      if (Array.isArray(c.tabs)) for (const t of c.tabs) if (isObj(t)) add(t.child);
      break;
    case "ConditionView":
      if (Array.isArray(c.cases)) for (const k of c.cases) if (isObj(k)) add(k.child);
      add(c.default);
      break;
    case "PlatformSwitch":
      if (isObj(c.condition)) Object.values(c.condition).forEach(add);
      break;
    case "ChoiceGroup":
      if (isObj(c.options)) add(c.options.componentId);
      break;
  }
  return out;
}

/** Walk every value; report forbidden keys and unknown function calls. */
function scanCalls(v: unknown, at: string, errors: string[], warnings: string[]): void {
  if (Array.isArray(v)) {
    v.forEach((x, i) => scanCalls(x, `${at}[${i}]`, errors, warnings));
    return;
  }
  if (!isObj(v)) return;
  for (const [k, x] of Object.entries(v)) {
    if (FORBIDDEN_KEYS.has(k)) errors.push(`${at}.${k}: 不支持 Agent 函数调用`);
    if (k === "call" && typeof x === "string" && !x.startsWith("@") && !KNOWN_FUNCTIONS.has(x)) {
      warnings.push(`${at}.call: 函数 ${x} 不在官方 catalog 中，需宿主已注册`);
    }
    scanCalls(x, `${at}.${k}`, errors, warnings);
  }
}

export function validateA2uiMessages(messages: A2uiMessage[], maxBytes = MAX_CARD_CONTENT_BYTES): ValidateResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  let surfaceId: string | undefined;
  const components = new Map<string, Record<string, unknown>>();

  messages.forEach((m, i) => {
    const at = `messages[${i}]`;
    if (m.version !== A2UI_VERSION) errors.push(`${at}.version 必须为 "${A2UI_VERSION}"`);
    const kind = messageKind(m);
    if (!kind) {
      errors.push(
        `${at} 必须且只能包含 ${MESSAGE_KINDS.join(" / ")} 之一（实际顶层字段：${Object.keys(m).join(", ") || "无"}${typeof m.action === "string" ? `，action=${m.action}` : ""}）`,
      );
      return;
    }
    const body = m[kind];
    if (!isObj(body)) {
      errors.push(`${at}.${kind} 必须是对象`);
      return;
    }
    if (typeof body.surfaceId !== "string" || !body.surfaceId) {
      errors.push(`${at}.${kind}.surfaceId 必填`);
    } else if (surfaceId === undefined) {
      surfaceId = body.surfaceId;
    } else if (body.surfaceId !== surfaceId) {
      errors.push(`${at}.${kind}.surfaceId 与前面的消息不一致（一张卡只能有一个 surface）`);
    }

    if (kind === "createSurface") {
      if (i !== 0) errors.push(`${at}: createSurface 必须是第一条消息`);
      if (body.catalogId !== XCARD_CATALOG_ID) {
        errors.push(`${at}.createSurface.catalogId 必须为 xcard catalog（${XCARD_CATALOG_ID}）`);
      }
      if (Array.isArray(body.components)) collect(body.components, `${at}.createSurface.components`);
    } else if (kind === "updateComponents") {
      if (!Array.isArray(body.components)) errors.push(`${at}.updateComponents.components 必须是数组`);
      else collect(body.components, `${at}.updateComponents.components`);
    } else if (kind === "updateDataModel") {
      if (!("value" in body)) errors.push(`${at}.updateDataModel.value 必填（删除请传 null）`);
    } else if (kind === "deleteSurface") {
      errors.push(`${at}: 不支持 deleteSurface，关闭卡片请用 action=close`);
    }
  });
  if (messages[0] && messageKind(messages[0]) !== "createSurface") {
    errors.push("messages[0] 必须是 createSurface");
  }

  function collect(list: unknown[], at: string): void {
    list.forEach((raw, j) => {
      if (!isObj(raw)) {
        errors.push(`${at}[${j}] 必须是对象`);
        return;
      }
      if (typeof raw.id !== "string" || !raw.id) errors.push(`${at}[${j}].id 必填`);
      if (typeof raw.component !== "string") {
        errors.push(`${at}[${j}].component 必须是组件名字符串（v1.0 扁平格式，不要嵌套组件对象）`);
      } else if (!XCARD_COMPONENTS.has(raw.component)) {
        errors.push(`${at}[${j}].component 未知组件 ${raw.component}`);
      }
      if (typeof raw.id === "string") components.set(raw.id, raw);
    });
  }

  if (!components.has("root")) errors.push('最终组件集合缺少 id 为 "root" 的根组件');
  for (const c of components.values()) {
    for (const ref of referencedIds(c)) {
      if (!components.has(ref)) errors.push(`组件 ${String(c.id)} 引用的 ${ref} 不存在`);
    }
  }
  scanCalls(messages, "messages", errors, warnings);

  const bytes = Buffer.byteLength(JSON.stringify(messages), "utf8");
  if (bytes > maxBytes) errors.push(`卡片内容 ${bytes} 字节，超过上限 ${maxBytes} 字节`);

  return { ok: errors.length === 0, errors, warnings };
}
