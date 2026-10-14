/**
 * Turns a template + validated data into A2UI v1.0 messages, plus small component helpers.
 *
 * Every template card has the same outer frame (component ids prefixed `oc-`, never used by
 * templates):
 *
 *   root Card → oc-frame Column [ body, oc-result Visibility → oc-result-text ]
 *
 * `body.enabled` is bound to `not(/ui/closed)` so closing a card disables every control in it
 * (enabled cascades to children), and the result line ("已选择：X" / "卡片已关闭") appears below.
 * Only property shapes already accepted by the official validator are used here and in the
 * templates (Text variants h4/h5/body/caption, Button variants primary/default, color tokens
 * basic_text_*), plus `style.fillMaxWidth` on the root Card (read by the SDK and both native
 * renderers).
 */

import {
  A2UI_VERSION,
  OPENCLAW_EXTENSION_KEY,
  XCARD_CATALOG_ID,
} from "../constants.js";
import type { A2uiMessage } from "../validate.js";
import type { A2uiComponent, TemplateData, TemplateRenderState, XCardTemplate } from "./types.js";

export const BODY_ID = "body";

export const path = (p: string) => ({ path: p });
export const notPath = (p: string) => ({ call: "not", args: { value: { path: p } } });
export const format = (value: string) => ({ call: "formatString", args: { value } });

export function text(
  id: string,
  value: unknown,
  variant: "h4" | "h5" | "body" | "caption" = "body",
  color?: "basic_text_secondary" | "basic_text_tertiary" | "basic_text_brand",
): A2uiComponent {
  return { id, component: "Text", text: value, variant, ...(color ? { style: { color } } : {}) };
}

export function column(id: string, children: string[], spacing = 8): A2uiComponent {
  return { id, component: "Column", children, align: "stretch", style: { spacing } };
}

/** A Button with a Text label; returns both components. */
export function button(
  id: string,
  label: unknown,
  action: Record<string, unknown>,
  variant: "primary" | "default" = "default",
): A2uiComponent[] {
  return [
    { id, component: "Button", child: `${id}-label`, variant, action },
    { id: `${id}-label`, component: "Text", text: label },
  ];
}

export function event(name: string, context: Record<string, unknown> = {}, userMessage?: unknown): Record<string, unknown> {
  return { event: { name, context, ...(userMessage !== undefined ? { userMessage } : {}) } };
}

export function openUrl(url: string): Record<string, unknown> {
  return { functionCall: { call: "openUrl", args: { url } } };
}

/** `Visibility` shown when the boolean at `flagPath` is true. */
export function visibleIf(id: string, flagPath: string, child: string): A2uiComponent {
  return { id, component: "Visibility", value: { path: flagPath }, child };
}

export function buildTemplateMessages(
  tpl: XCardTemplate,
  data: TemplateData,
  state: TemplateRenderState,
  surfaceId: string,
  extension: Record<string, unknown>,
): A2uiMessage[] {
  const body = tpl.components(data).map((c) => (c.id === BODY_ID ? { ...c, enabled: notPath("/ui/closed") } : c));
  const components: A2uiComponent[] = [
    // A Card hugs its content; weighted Rows (flex-basis 0) would otherwise shrink it to nothing
    { id: "root", component: "Card", child: "oc-frame", style: { padding: 12, fillMaxWidth: 1 } },
    column("oc-frame", [BODY_ID, "oc-result"]),
    ...body,
    visibleIf("oc-result", "/ui/hasResult", "oc-result-text"),
    text("oc-result-text", path("/ui/resultText"), "caption", "basic_text_tertiary"),
  ];
  const resultText = state.closed ? tpl.resultText(data, state) || "卡片已关闭" : "";
  const model = {
    ...tpl.dataModel(data, state),
    ui: { closed: state.closed, hasResult: Boolean(resultText), resultText },
  };
  return [
    {
      version: A2UI_VERSION,
      createSurface: {
        surfaceId,
        catalogId: XCARD_CATALOG_ID,
        metadata: { extensions: { [OPENCLAW_EXTENSION_KEY]: extension } },
      },
    },
    { version: A2UI_VERSION, updateComponents: { surfaceId, components } },
    { version: A2UI_VERSION, updateDataModel: { surfaceId, path: "/", value: model } },
  ];
}

