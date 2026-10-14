/**
 * Template `form`: collect 1–10 typed fields and submit them in one `submit` event.
 *
 * Field types map to official input components: text/number → TextField (with a label line),
 * select/multiselect → ChoicePicker chips, checkbox → CheckBox, date/datetime → DateTimeInput.
 * Every control binds `/state/values/<key>`; the submit button's context carries one entry per
 * key. The plugin normalizes the submitted values by type (ChoicePicker values arrive as arrays,
 * numbers as strings). A submission missing required fields is forwarded to the model with
 * `missing` but keeps the card open so the user can fill them in; a complete one closes the card
 * and the closed card shows the submitted values.
 */

import { BODY_ID, button, column, event, path, text } from "./builder.js";
import type { A2uiComponent, TemplateData, TemplateRenderState, XCardTemplate } from "./types.js";

const FIELD_TYPES = ["text", "number", "select", "multiselect", "checkbox", "date", "datetime"] as const;
type FieldType = (typeof FIELD_TYPES)[number];

interface FormOption {
  value: string;
  label: string;
}

interface FormField {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  placeholder?: string;
  options?: FormOption[];
  defaultValue?: string;
}

interface FormData {
  title: string;
  description?: string;
  fields: FormField[];
  submitLabel: string;
}

const asData = (d: TemplateData) => d as unknown as FormData;

/** Value shape the renderer control holds for a field. */
function controlValue(f: FormField, v: unknown): unknown {
  switch (f.type) {
    case "checkbox":
      return v === true || v === "true";
    case "select":
      return typeof v === "string" && v ? [v] : [];
    case "multiselect":
      if (Array.isArray(v)) return v;
      return typeof v === "string" && v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
    case "number":
      return typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
    default:
      return typeof v === "string" ? v : "";
  }
}

/** Submitted renderer value → model-facing value (undefined = empty). */
function submittedValue(f: FormField, v: unknown): unknown {
  switch (f.type) {
    case "checkbox":
      return v === true || v === "true";
    case "select": {
      const s = Array.isArray(v) ? v[0] : v;
      return typeof s === "string" && s ? s : undefined;
    }
    case "multiselect": {
      const list = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
      return list.length ? list : undefined;
    }
    case "number": {
      const s = typeof v === "number" ? String(v) : typeof v === "string" ? v.trim() : "";
      if (!s) return undefined;
      const n = Number(s);
      return Number.isFinite(n) ? n : s;
    }
    default: {
      const s = typeof v === "string" ? v.trim() : "";
      return s || undefined;
    }
  }
}

function displayValue(f: FormField, v: unknown): string {
  if (f.type === "checkbox") return v ? "是" : "否";
  const labelOf = (x: string) => f.options?.find((o) => o.value === x)?.label ?? x;
  if (Array.isArray(v)) return v.map((x) => labelOf(String(x))).join("、");
  return f.type === "select" ? labelOf(String(v)) : String(v);
}

function submittedValues(state: TemplateRenderState): Record<string, unknown> {
  const v = state.last?.context?.values;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export const formTemplate: XCardTemplate = {
  key: "form",
  name: "表单收集",
  description: "让用户填写 1~10 项信息后一次提交（报名、预约、问卷、收集参数等）",
  usage: "需要用户一次性提供多项结构化信息时使用。每个字段用 key 标识，提交事件按 key 返回值；缺少必填项的提交也会转交给你（missing 列出缺项），卡片保持打开。",
  mode: "once",
  fields: {
    title: { type: "string", required: true, maxLength: 40, description: "卡片标题" },
    description: { type: "string", maxLength: 300, description: "表单说明（可选）" },
    fields: {
      type: "array",
      required: true,
      minItems: 1,
      maxItems: 10,
      description: "表单字段",
      items: {
        type: "object",
        description: "一个字段",
        fields: {
          key: { type: "string", required: true, format: "id", description: "字段标识，提交结果按它返回" },
          label: { type: "string", required: true, maxLength: 20, description: "字段名" },
          type: {
            type: "string",
            enum: FIELD_TYPES,
            default: "text",
            description: "text=文本 number=数字 select=单选 multiselect=多选 checkbox=勾选 date=日期 datetime=日期时间",
          },
          required: { type: "boolean", default: false, description: "是否必填" },
          placeholder: { type: "string", maxLength: 40, description: "输入提示（text/number）" },
          options: {
            type: "array",
            maxItems: 10,
            description: "select/multiselect 的选项（必填）",
            items: {
              type: "object",
              description: "一个选项",
              fields: {
                value: { type: "string", required: true, format: "id", description: "选项值" },
                label: { type: "string", required: true, maxLength: 20, description: "选项文字" },
              },
            },
          },
          defaultValue: {
            type: "string",
            maxLength: 100,
            description: "默认值（文本形式）：checkbox 填 true/false；select 填选项 value；multiselect 用英文逗号分隔多个 value；date 形如 2026-10-12；datetime 形如 2026-10-12T20:00",
          },
        },
      },
    },
    submitLabel: { type: "string", maxLength: 10, default: "提交", description: "提交按钮文字" },
  },
  example: {
    title: "活动报名",
    description: "周六上午 10 点开始，请填写报名信息",
    fields: [
      { key: "name", label: "姓名", type: "text", required: true, placeholder: "请输入姓名" },
      { key: "people", label: "人数", type: "number", defaultValue: "1" },
      {
        key: "session",
        label: "场次",
        type: "select",
        required: true,
        options: [{ value: "am", label: "上午" }, { value: "pm", label: "下午" }],
      },
      { key: "date", label: "日期", type: "date" },
      { key: "agree", label: "同意活动须知", type: "checkbox" },
    ],
  },
  events: {
    submit: {
      description: "用户点了提交",
      context: {
        values: "按字段 key 组织的提交值：text/date/datetime 为字符串，number 为数字，select 为选项 value，multiselect 为 value 数组，checkbox 为布尔",
        missing: "（仅缺必填项时）缺少的字段 key 数组，此时卡片保持打开",
      },
    },
  },

  check(data) {
    const d = asData(data);
    const errors: string[] = [];
    const keys = new Set<string>();
    d.fields.forEach((f, i) => {
      const at = `fields[${i}]`;
      if (keys.has(f.key)) errors.push(`${at}.key: 与前面的字段重复（${f.key}）`);
      keys.add(f.key);
      const choice = f.type === "select" || f.type === "multiselect";
      if (choice && !f.options?.length) errors.push(`${at}.options: ${f.type} 类型必须提供选项`);
      if (!choice && f.options?.length) delete f.options;
      const values = new Set<string>();
      for (const [j, o] of (f.options ?? []).entries()) {
        if (values.has(o.value)) errors.push(`${at}.options[${j}].value: 与前面的选项重复（${o.value}）`);
        values.add(o.value);
      }
      if (f.defaultValue === undefined) return;
      const dv = f.defaultValue;
      if (f.type === "number" && !Number.isFinite(Number(dv))) errors.push(`${at}.defaultValue: number 类型的默认值必须是数字`);
      if (f.type === "checkbox" && dv !== "true" && dv !== "false") errors.push(`${at}.defaultValue: checkbox 默认值只能是 true / false`);
      const parts = f.type === "multiselect" ? dv.split(",").map((s) => s.trim()) : f.type === "select" ? [dv] : [];
      for (const p of parts) if (p && !values.has(p)) errors.push(`${at}.defaultValue: ${p} 不在 options 的 value 中`);
    });
    return errors;
  },

  components(data) {
    const d = asData(data);
    const children = ["title", ...(d.description ? ["desc"] : [])];
    const out: A2uiComponent[] = [text("title", path("/title"), "h4")];
    if (d.description) out.push(text("desc", path("/description"), "caption", "basic_text_secondary"));
    d.fields.forEach((f, i) => {
      const id = `f${i}`;
      const label = `${f.label}${f.required ? " *" : ""}`;
      const value = path(`/state/values/${f.key}`);
      children.push(id);
      switch (f.type) {
        case "text":
        case "number":
          out.push(
            column(id, [`${id}-label`, `${id}-input`], 4),
            text(`${id}-label`, label, "caption", "basic_text_secondary"),
            { id: `${id}-input`, component: "TextField", placeholder: f.placeholder ?? `请输入${f.label}`, value },
          );
          break;
        case "select":
        case "multiselect":
          out.push({
            id,
            component: "ChoicePicker",
            label,
            variant: f.type === "select" ? "mutuallyExclusive" : "multipleSelection",
            displayStyle: "chips",
            options: (f.options ?? []).map((o) => ({ label: o.label, value: o.value })),
            value,
          });
          break;
        case "checkbox":
          out.push({ id, component: "CheckBox", label, value });
          break;
        case "date":
        case "datetime":
          out.push({ id, component: "DateTimeInput", label, enableDate: true, enableTime: f.type === "datetime", value });
          break;
      }
    });
    children.push("submit");
    const context = Object.fromEntries(d.fields.map((f) => [f.key, path(`/state/values/${f.key}`)]));
    out.push(...button("submit", d.submitLabel, event("submit", context, `提交了「${d.title}」`), "primary"));
    out.unshift(column(BODY_ID, children, 10));
    return out;
  },

  dataModel(data, state) {
    const d = asData(data);
    const submitted = state.closed ? submittedValues(state) : {};
    const values = Object.fromEntries(
      d.fields.map((f) => [f.key, controlValue(f, f.key in submitted ? submitted[f.key] : f.defaultValue)]),
    );
    return { title: d.title, description: d.description ?? "", state: { values } };
  },

  title: (data) => asData(data).title,

  fallbackText(data) {
    const d = asData(data);
    const lines = d.fields.map((f, i) => {
      const opts = f.options?.length ? `：${f.options.map((o) => o.label).join(" / ")}` : "";
      return `${i + 1}. ${f.label}${f.required ? "（必填）" : ""}${opts}`;
    });
    return [d.title, ...(d.description ? [d.description] : []), "请直接回复以下信息：", ...lines].join("\n");
  },

  decideAction(data, name, context) {
    if (name !== "submit") return { reject: "invalid_action" };
    const d = asData(data);
    const values: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const f of d.fields) {
      const v = submittedValue(f, context[f.key]);
      if (v !== undefined) values[f.key] = v;
      if (f.required && (v === undefined || (f.type === "checkbox" && v === false))) missing.push(f.key);
    }
    const shown = d.fields
      .filter((f) => f.key in values)
      .map((f) => `${f.label}=${displayValue(f, values[f.key])}`)
      .join("；");
    if (missing.length) {
      const labels = missing.map((k) => d.fields.find((f) => f.key === k)?.label ?? k);
      return {
        summary: `提交了表单，但缺少必填项：${labels.join("、")}${shown ? `（已填：${shown}）` : ""}`,
        context: { values, missing },
        keepOpen: true,
      };
    }
    return { summary: `提交了表单${shown ? `：${shown}` : ""}`, context: { values } };
  },

  resultText: (_data, state) => (state.last ? "已提交" : ""),
};
