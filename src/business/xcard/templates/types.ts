/**
 * xCard template contract.
 *
 * A template turns model-supplied data into A2UI v1.0 messages: the model never writes
 * components. It only sees `fields` (a small schema DSL, also what `get_template` returns),
 * `example` and `events`; the plugin validates data against `fields`, runs `check` for
 * cross-field rules, then `components` + `dataModel` produce the card.
 *
 * Conventions shared by every template (enforced by builder.ts):
 * - `components(data)` returns the card body; its top component has id `body`. The builder wraps
 *   it in Card → Column[body, result line] and binds `body.enabled` to `not(/ui/closed)`.
 * - `dataModel` must not use the `/ui` key (owned by the builder: closed flag + result text).
 * - Event names in `events` are the only ones accepted from the renderer; `decideAction` maps an
 *   event's context to the trusted summary/context forwarded to the model, or rejects it.
 */

import type { SurfaceMode, XCardActionResult } from "../registry.js";

interface FieldBase {
  description: string;
  required?: boolean;
}

export interface StringField extends FieldBase {
  type: "string";
  maxLength?: number;
  enum?: readonly string[];
  /** id = `[A-Za-z0-9_-]{1,32}`; url = http(s) URL */
  format?: "id" | "url";
  default?: string;
}

export interface NumberField extends FieldBase {
  type: "number";
  min?: number;
  max?: number;
  integer?: boolean;
  default?: number;
}

export interface BooleanField extends FieldBase {
  type: "boolean";
  default?: boolean;
}

export interface ArrayField extends FieldBase {
  type: "array";
  items: FieldSpec;
  minItems?: number;
  maxItems?: number;
}

export interface ObjectField extends FieldBase {
  type: "object";
  fields: Record<string, FieldSpec>;
}

export type FieldSpec = StringField | NumberField | BooleanField | ArrayField | ObjectField;

export type TemplateData = Record<string, unknown>;
export type A2uiComponent = Record<string, unknown>;

export interface TemplateRenderState {
  closed: boolean;
  /** Last accepted operation (drives "selected" marks and the result line) */
  last?: XCardActionResult;
}

export interface TemplateEventSpec {
  description: string;
  /** context key → meaning, as forwarded to the model after `decideAction` */
  context: Record<string, string>;
}

export type ActionDecision =
  | {
    summary: string;
    /** Trusted context forwarded to the model (replaces the renderer's raw context) */
    context: Record<string, unknown>;
    /** Accept and forward, but keep a once-mode card open (e.g. form submitted with missing fields) */
    keepOpen?: boolean;
  }
  | { reject: string };

export interface XCardTemplate {
  key: string;
  name: string;
  /** One line, shown by list_templates */
  description: string;
  /** When to use it and authoring notes, shown by get_template */
  usage: string;
  fields: Record<string, FieldSpec>;
  example: TemplateData;
  events: Record<string, TemplateEventSpec>;
  /** once = first accepted operation closes the card; perRevision = one accepted operation per revision */
  mode: SurfaceMode;
  /** Cross-field rules after schema validation; may fill defaults in place. Returns error messages. */
  check?(data: TemplateData): string[];
  components(data: TemplateData): A2uiComponent[];
  dataModel(data: TemplateData, state: TemplateRenderState): Record<string, unknown>;
  title(data: TemplateData): string;
  fallbackText(data: TemplateData): string;
  decideAction(data: TemplateData, name: string, context: Record<string, unknown>): ActionDecision;
  /** Result line shown once the card is closed ("" → generic "卡片已关闭") */
  resultText(data: TemplateData, state: TemplateRenderState): string;
}
