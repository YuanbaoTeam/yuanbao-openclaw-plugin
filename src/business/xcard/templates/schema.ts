/**
 * Validation of model-supplied template data against a template's `fields`.
 *
 * Errors carry a JSON-ish path (`options[2].label`) so the tool can tell the model exactly which
 * field to fix. Light coercion only where models commonly slip: numbers/booleans given as strings,
 * numbers given for strings. Strings are trimmed; empty strings count as missing. Unknown keys are
 * dropped with a warning rather than failing the card. Over-long text is an error (never silently
 * truncated) so the model learns the limit.
 */

import type { FieldSpec, TemplateData } from "./types.js";

export interface FieldError {
  path: string;
  message: string;
}

export type DataValidation =
  | { ok: true; data: TemplateData; warnings: string[] }
  | { ok: false; errors: FieldError[]; warnings: string[] };

const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const URL_RE = /^https?:\/\/\S+$/i;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Accept an object, or a JSON object string (the tool passes `data` as a string). */
export function parseTemplateData(input: unknown): { data: Record<string, unknown> } | { error: string } {
  let v = input;
  if (typeof input === "string") {
    const text = input.trim();
    if (!text) return { error: "data 为空" };
    try {
      v = JSON.parse(text);
    } catch (e) {
      return { error: `data 不是合法的 JSON: ${(e as Error).message}` };
    }
  }
  if (!isObj(v)) return { error: "data 必须是 JSON 对象" };
  return { data: v };
}

function isMissing(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

function checkValue(spec: FieldSpec, value: unknown, path: string, errors: FieldError[], warnings: string[]): unknown {
  const fail = (message: string) => {
    errors.push({ path, message });
    return undefined;
  };
  if (isMissing(value)) {
    if (spec.required) return fail("必填");
    return "default" in spec ? spec.default : undefined;
  }
  switch (spec.type) {
    case "string": {
      const s = typeof value === "number" || typeof value === "boolean" ? String(value) : value;
      if (typeof s !== "string") return fail("必须是字符串");
      const t = s.trim();
      if (spec.maxLength !== undefined && t.length > spec.maxLength) {
        return fail(`不能超过 ${spec.maxLength} 字（当前 ${t.length} 字）`);
      }
      if (spec.enum && !spec.enum.includes(t)) return fail(`只能是 ${spec.enum.join(" / ")} 之一`);
      if (spec.format === "id" && !ID_RE.test(t)) return fail("只能包含字母、数字、下划线、横线，且不超过 32 个字符");
      if (spec.format === "url" && !URL_RE.test(t)) return fail("必须是 http(s) 链接");
      return t;
    }
    case "number": {
      const n = typeof value === "string" ? Number(value.trim()) : value;
      if (typeof n !== "number" || !Number.isFinite(n)) return fail("必须是数字");
      if (spec.integer && !Number.isInteger(n)) return fail("必须是整数");
      if (spec.min !== undefined && n < spec.min) return fail(`不能小于 ${spec.min}`);
      if (spec.max !== undefined && n > spec.max) return fail(`不能大于 ${spec.max}`);
      return n;
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "false") return value === "true";
      return fail("必须是 true 或 false");
    }
    case "array": {
      if (!Array.isArray(value)) return fail("必须是数组");
      if (spec.minItems !== undefined && value.length < spec.minItems) return fail(`至少 ${spec.minItems} 项（当前 ${value.length} 项）`);
      if (spec.maxItems !== undefined && value.length > spec.maxItems) return fail(`最多 ${spec.maxItems} 项（当前 ${value.length} 项）`);
      return value.map((item, i) => checkValue(spec.items, item, `${path}[${i}]`, errors, warnings));
    }
    case "object": {
      if (!isObj(value)) return fail("必须是对象");
      return checkObject(spec.fields, value, path, errors, warnings);
    }
  }
}

function checkObject(
  fields: Record<string, FieldSpec>,
  value: Record<string, unknown>,
  path: string,
  errors: FieldError[],
  warnings: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, spec] of Object.entries(fields)) {
    const v = checkValue(spec, value[key], path ? `${path}.${key}` : key, errors, warnings);
    if (v !== undefined) out[key] = v;
  }
  for (const key of Object.keys(value)) {
    if (!(key in fields)) warnings.push(`${path ? `${path}.` : ""}${key} 不是模板字段，已忽略`);
  }
  return out;
}

export function validateTemplateData(fields: Record<string, FieldSpec>, input: Record<string, unknown>): DataValidation {
  const errors: FieldError[] = [];
  const warnings: string[] = [];
  const data = checkObject(fields, input, "", errors, warnings);
  return errors.length ? { ok: false, errors, warnings } : { ok: true, data, warnings };
}

/** Fill missing `id`s as `${prefix}${index+1}` and report duplicates (path-style messages). */
export function fillIds(list: Array<Record<string, unknown>>, listPath: string, prefix: string): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  list.forEach((item, i) => {
    if (typeof item.id !== "string" || !item.id) item.id = `${prefix}${i + 1}`;
    const id = item.id as string;
    if (seen.has(id)) errors.push(`${listPath}[${i}].id: 与前面的项重复（${id}）`);
    seen.add(id);
  });
  return errors;
}
