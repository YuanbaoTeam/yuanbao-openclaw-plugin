/**
 * A2UI Express support for AI-authored generated xCards.
 *
 * Two entries reach this module with a raw Express body: the `<a2ui>` reply-part path and the
 * tools' explicit `express` parameter. The SDK compiles that body into official A2UI v1.0
 * messages; this module then normalizes them back to the Yuanbao xCard wire dialect consumed by
 * the existing generated-card lifecycle.
 */

import { A2uiGenerator, CatalogConfig, ExpressFormatFactory } from "@a2ui/agent";
import { Catalog } from "@a2ui/web_core";
import { createLog } from "../../logger.js";
import agentCatalogJson from "./agent-catalog.json" with { type: "json" };
import { A2UI_VERSION, XCARD_CATALOG_ID } from "./constants.js";
import { validateGeneratedMessages } from "./generated.js";
import type { A2uiMessage } from "./validate.js";

type PlainObject = Record<string, unknown>;

const ALLOWED_MESSAGES = ["createSurface", "updateComponents", "updateDataModel"] as const;
const A2UI_TAG_RE = /<\/?a2ui\b/i;
const ARRAY_INDEX_BINDING_RE = /\$\/[A-Za-z0-9_/-]+\[\d+\]/;
const A2UI_WRAPPER_RE = /^<a2ui\b[^>]*>([\s\S]*?)<\/a2ui>$/i;
const MARKDOWN_CODE_FENCE_RE = /^```[^\r\n]*\r?\n([\s\S]*?)\r?\n```$/;
const ROOT_ASSIGN_RE = /^\s*root\s*=/m;
const ROOT_CASE_ASSIGN_RE = /^(\s*)Root\s*=/m;
const DIFF_PLUS_LINE_RE = /^(\s*)\+\s*(?=\s*(?:\$\/|root\s*=|Root\s*=|[A-Za-z_]\w*\s*=|(?:Card|Column|Row|List|Text|Button|Image|ChoiceGroup)\s*\(|[)\]}]))/gm;
const BARE_ROOT_COMPONENT_RE = /^(\s*)(Card|Column|Row|List|Text|Button|Image|ChoiceGroup)\s*\(/m;
const ROOT_CANDIDATE_ASSIGN_RE = /^(\s*)(card|content|surface|container|view|body|main)\s*=\s*(Card|Column|Row|List)\s*\(/im;
const log = createLog("xcard.express");
let generator: A2uiGenerator | undefined;

function isObj(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getGenerator(): A2uiGenerator {
  if (!generator) {
    const catalog = Catalog.fromJson(agentCatalogJson as unknown as PlainObject);
    generator = new A2uiGenerator(
      [new CatalogConfig(catalog)],
      undefined,
      new ExpressFormatFactory({ allowedMessages: [...ALLOWED_MESSAGES] }),
    );
  }
  return generator;
}

function messageKind(message: PlainObject): (typeof ALLOWED_MESSAGES)[number] | "deleteSurface" | undefined {
  const keys = ["createSurface", "updateComponents", "updateDataModel", "deleteSurface"] as const;
  const found = keys.filter((key) => key in message);
  return found.length === 1 ? found[0] : undefined;
}

function normalizeBindings(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeBindings);
  if (!isObj(value)) return value;

  const out: PlainObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "@path") continue;
    out[key] = normalizeBindings(item);
  }
  if ("@path" in value) {
    if ("path" in value && value.path !== value["@path"]) {
      throw new Error("binding object contains both path and @path with different values");
    }
    out.path = value["@path"];
  }
  return out;
}

function asObjectArray(value: unknown): PlainObject[] {
  return Array.isArray(value) ? value.filter(isObj) : [];
}

function bodySurfaceId(body: unknown): string | undefined {
  return isObj(body) && typeof body.surfaceId === "string" && body.surfaceId ? body.surfaceId : undefined;
}

function stripSourceWrapper(input: string): string {
  let source = input.trim();
  const fence = MARKDOWN_CODE_FENCE_RE.exec(source);
  if (fence?.[1]) source = fence[1].trim();
  const wrapped = A2UI_WRAPPER_RE.exec(source);
  if (wrapped?.[1]) source = wrapped[1].trim();
  return source;
}

function repairCommonSourceNoise(input: string): string {
  let source = input.replace(DIFF_PLUS_LINE_RE, "$1");
  source = source.replace(ROOT_CASE_ASSIGN_RE, "$1root =");
  if (!ROOT_ASSIGN_RE.test(source)) {
    source = source.replace(ROOT_CANDIDATE_ASSIGN_RE, "$1root = $3(");
  }
  if (!ROOT_ASSIGN_RE.test(source)) {
    source = source.replace(BARE_ROOT_COMPONENT_RE, "$1root = $2(");
  }
  source = source.replace(/\bColumn\s*\(\s*_template\s*\(/g, "List(_template(");
  return repairTextVariantAliases(source);
}

function repairTextVariantAliases(input: string): string {
  const aliases: Record<string, string> = {
    body1: "body",
    body2: "body",
    subtitle: "h5",
    title: "h4",
    headline: "h4",
    subhead: "h5",
  };
  return input.replace(/(\bText\s*\([^)]*\bvariant\s*=\s*["'])(body1|body2|subtitle|title|headline|subhead)(["'])/g, (
    _match,
    prefix: string,
    name: string,
    suffix: string,
  ) => `${prefix}${aliases[name] ?? "body"}${suffix}`);
}

function buildExpressRepairHints(source: string, error: string): string[] {
  const hints: string[] = [];
  const add = (hint: string) => {
    if (!hints.includes(hint)) hints.push(hint);
  };

  if (/Root target 'root' is not defined|root component 'root'/i.test(error) || !/\broot\s*=/.test(source)) {
    add("必须定义入口组件：添加一行 root = Card(...) / root = Column(...)，不要只写数据或组件变量。");
  }
  if (ARRAY_INDEX_BINDING_RE.test(source)) {
    add("A2UI Express 绑定不支持 JS 数组下标，例如 $/todo/items[0].label。动态列表请定义 item 模板，并使用 List(_template($/todo/items, item))；模板内部用相对绑定 $label。");
  }
  if (/\bList\s*\([^)]*\bitems\s*=/.test(source)) {
    add("List 没有 items 参数。动态列表写成 List(_template($/path, itemTemplate))，静态子项写成 List(children=[...])。");
  }
  if (/\bColumn\s*\(\s*_template\s*\(/.test(source) || /Component 'Column' is missing required property 'children'/i.test(error)) {
    add("动态数组不要写 Column(_template(...))；请写 List(_template($/path, itemTemplate))。");
  }
  if (/\bListItem\s*\(/.test(source)) {
    add("当前 xCard catalog 没有 ListItem 组件。请用 Row/Column/Text/Button/Image 等组件组合列表项，或用 List(_template(...)) 渲染数组。");
  }
  if (/\bCheckbox\s*\(/.test(source)) {
    add("当前 xCard catalog 没有 Checkbox 组件。选择/勾选类 UI 请用 ChoiceGroup，或用 Text/Label 表示状态。");
  }
  if (/\bText\s*\([^)]*\bstyle\s*=\s*["'](?:title|subtitle|body|caption)["']/.test(source)) {
    add("Text 的标题样式不要写 style=\"title\"；请使用 variant=\"h4\" / variant=\"h5\" / variant=\"body\" / variant=\"caption\"。");
  }
  if (/Value '[^']+' is not a valid enum choice for property 'variant' of component 'Text'/i.test(error)) {
    add("Text.variant 只允许 h1/h2/h3/h4/h5/caption/footnote/body；不要写 body2、subtitle 或 title。");
  }
  if (/"type"\s*:\s*"[^"]+"/.test(source) || /"layout"\s*:/.test(source)) {
    add("不要输出自造 JSON schema（如 {\"type\":\"list\"} 或 {\"type\":\"product_card\"}）。Express 必须是组件构造函数和数据赋值，例如 $/title = \"...\" 与 root = Card(...).");
  }
  if (/```|<a2ui\b/i.test(source)) {
    add("工具 express 参数只接收块内 Express 正文，不要包含 <a2ui> 标签或 Markdown 代码块。");
  }
  if (/(^|\n)\s*\+\s|\+\s*["'$]/.test(source) || /token recognition error at: '\+/.test(error)) {
    add("A2UI Express 不支持 diff 行首 + 或 JavaScript 字符串拼接。请去掉行首 +，把拼接结果预先写成一个完整字符串或数据字段。");
  }
  if (hints.length === 0) {
    add("请对照 express-prompt.md 的组件签名修正语法；保持纯 Express 正文，并再次调用同一工具。");
  }
  return hints;
}

export function normalizeExpressMessages(messages: A2uiMessage[]): { messages: A2uiMessage[] } | { error: string } {
  try {
    const surfaceIds = new Set<string>();
    const components = new Map<string, PlainObject>();
    const dataUpdates: A2uiMessage[] = [];
    let firstSurfaceId = "main";
    let sawCreateSurface = false;
    let rootDataModel: PlainObject | undefined;

    for (const raw of messages) {
      if (!isObj(raw)) return { error: "A2UI message must be an object" };
      const kind = messageKind(raw);
      if (!kind) return { error: `A2UI message must contain exactly one supported body: ${Object.keys(raw).join(", ")}` };
      if (kind === "deleteSurface") return { error: "deleteSurface is not supported for Yuanbao xCard" };

      const body = raw[kind];
      if (!isObj(body)) return { error: `${kind} body must be an object` };
      const sid = bodySurfaceId(body);
      if (sid) {
        surfaceIds.add(sid);
        if (firstSurfaceId === "main") firstSurfaceId = sid;
      }

      if (kind === "createSurface") {
        sawCreateSurface = true;
        for (const component of asObjectArray(body.components)) {
          if (typeof component.id === "string") components.set(component.id, normalizeBindings(component) as PlainObject);
        }
        // Data model holds business values, not bindings; keep user keys such as "@path" intact.
        if (isObj(body.dataModel)) rootDataModel = structuredClone(body.dataModel);
        continue;
      }

      if (kind === "updateComponents") {
        for (const component of asObjectArray(body.components)) {
          if (typeof component.id === "string") components.set(component.id, normalizeBindings(component) as PlainObject);
        }
        continue;
      }

      dataUpdates.push({
        version: A2UI_VERSION,
        updateDataModel: {
          ...structuredClone(body),
          surfaceId: firstSurfaceId,
        },
      });
    }

    if (!sawCreateSurface) return { error: "Express output must create a surface" };
    if (surfaceIds.size > 1) return { error: "Express output contains multiple surfaceIds" };

    const normalized: A2uiMessage[] = [
      {
        version: A2UI_VERSION,
        createSurface: {
          surfaceId: firstSurfaceId,
          catalogId: XCARD_CATALOG_ID,
        },
      },
      {
        version: A2UI_VERSION,
        updateComponents: {
          surfaceId: firstSurfaceId,
          components: [...components.values()],
        },
      },
      {
        version: A2UI_VERSION,
        updateDataModel: {
          surfaceId: firstSurfaceId,
          path: "/",
          value: rootDataModel ?? {},
        },
      },
      ...dataUpdates,
    ];
    return { messages: normalized };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export function compileExpressMessages(input: unknown): { messages: A2uiMessage[] } | { error: string; errors?: string[] } {
  if (typeof input !== "string" || !input.trim()) return { error: "express 必须是非空 A2UI Express 正文" };
  const rawSource = input.trim();
  const unwrapped = stripSourceWrapper(rawSource);
  const source = repairCommonSourceNoise(unwrapped);
  if (A2UI_TAG_RE.test(source)) {
    return { error: "express 只接受 <a2ui> 块内正文，不要包含 <a2ui> 标签" };
  }

  try {
    const processor = getGenerator().createProcessor({
      "1.0": { supportedCatalogIds: [XCARD_CATALOG_ID] },
    });
    const parts = processor.parseResponse(source, { wrapped: false });
    const compiled: A2uiMessage[] = [];
    for (const part of parts) {
      if (isObj(part) && part.type === "a2ui" && Array.isArray(part.a2ui)) {
        compiled.push(...(part.a2ui as A2uiMessage[]));
      }
    }
    log.debug("compiled", { sourceLength: source.length, messageCount: compiled.length });
    if (compiled.length === 0) return { error: "express 未编译出 A2UI 消息，请确认内容是纯 Express 正文" };
    const normalized = normalizeExpressMessages(compiled);
    if ("error" in normalized) return { ...normalized, errors: buildExpressRepairHints(rawSource, normalized.error) };
    const checked = validateGeneratedMessages(normalized.messages);
    if (!checked.ok) {
      return {
        error: "xCard A2UI 校验失败",
        errors: [...checked.errors, ...buildExpressRepairHints(rawSource, checked.errors.join("\n"))],
      };
    }
    return normalized;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { error, errors: buildExpressRepairHints(rawSource, error) };
  }
}
