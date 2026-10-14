/**
 * Built-in xCard template library (hard-coded for now).
 *
 * Tool flow: list_templates (key + one-line description) → get_template (fields / events /
 * example) → create with template key + data. `prepareTemplateData` is the single entry that
 * validates data (schema + template rules) for both create and update.
 */

import { choiceTemplate } from "./choice.js";
import { confirmTemplate } from "./confirm.js";
import { formTemplate } from "./form.js";
import { infoTemplate } from "./info.js";
import { itemListTemplate } from "./item-list.js";
import { validateTemplateData, type FieldError } from "./schema.js";
import type { TemplateData, XCardTemplate } from "./types.js";

export const TEMPLATES: readonly XCardTemplate[] = [
  choiceTemplate,
  formTemplate,
  itemListTemplate,
  confirmTemplate,
  infoTemplate,
];

const byKey = new Map(TEMPLATES.map((t) => [t.key, t]));

export function getTemplate(key: string): XCardTemplate | undefined {
  return byKey.get(key);
}

export function listTemplates(): Array<{ key: string; name: string; description: string }> {
  return TEMPLATES.map((t) => ({ key: t.key, name: t.name, description: t.description }));
}

/** What get_template returns: everything the model needs to fill `data`. */
export function describeTemplate(t: XCardTemplate) {
  return {
    key: t.key,
    name: t.name,
    description: t.description,
    usage: t.usage,
    closesAfterAction: t.mode === "once",
    fields: t.fields,
    events: t.events,
    example: t.example,
  };
}

export type PreparedData =
  | { ok: true; data: TemplateData; warnings: string[] }
  | { ok: false; errors: FieldError[]; warnings: string[] };

export function prepareTemplateData(t: XCardTemplate, input: Record<string, unknown>): PreparedData {
  const v = validateTemplateData(t.fields, input);
  if (!v.ok) return v;
  const errors = (t.check?.(v.data) ?? []).map((msg) => {
    const i = msg.indexOf(": ");
    return i > 0 ? { path: msg.slice(0, i), message: msg.slice(i + 2) } : { path: "", message: msg };
  });
  return errors.length ? { ok: false, errors, warnings: v.warnings } : v;
}

export type { FieldError } from "./schema.js";
export type { TemplateData, XCardTemplate } from "./types.js";
