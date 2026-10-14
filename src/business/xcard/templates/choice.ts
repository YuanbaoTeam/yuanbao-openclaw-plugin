/**
 * Template `choice`: a question with 2–10 options.
 *
 * - Single choice (default): every option is a button; one click submits (`select`) and closes
 *   the card, marking the chosen option with ✓.
 * - Multiple choice (`multiple: true`): chips (ChoicePicker multipleSelection) plus a submit
 *   button (`submit`); an empty submission is forwarded but keeps the card open.
 * Option ids travel through the DataModel and come back in the event context; unknown ids are
 * rejected (`invalid_context`).
 */

import { BODY_ID, button, column, event, format, path, text, visibleIf } from "./builder.js";
import { fillIds } from "./schema.js";
import type { A2uiComponent, TemplateData, TemplateRenderState, XCardTemplate } from "./types.js";

interface ChoiceOption {
  id: string;
  label: string;
  description?: string;
}

interface ChoiceData {
  title: string;
  question: string;
  options: ChoiceOption[];
  multiple: boolean;
  submitLabel: string;
}

const asData = (d: TemplateData) => d as unknown as ChoiceData;

function selectedIds(state: TemplateRenderState): string[] {
  const ctx = state.last?.context ?? {};
  if (typeof ctx.optionId === "string") return [ctx.optionId];
  return Array.isArray(ctx.optionIds) ? ctx.optionIds.filter((x): x is string => typeof x === "string") : [];
}

function labelsOf(d: ChoiceData, ids: string[]): string[] {
  return ids.map((id) => d.options.find((o) => o.id === id)?.label ?? id);
}

export const choiceTemplate: XCardTemplate = {
  key: "choice",
  name: "选择 / 投票",
  description: "向用户提一个问题，给出 2~10 个选项让其单选或多选（方案选择、是否继续、偏好调查等）",
  usage: "需要用户在有限选项中做决定时使用。单选时用户点一个选项即提交并关卡；multiple=true 时用户勾选多个后点提交。卡片发出后不要再用文字重复罗列选项。",
  mode: "once",
  fields: {
    title: { type: "string", required: true, maxLength: 40, description: "卡片标题" },
    question: { type: "string", required: true, maxLength: 300, description: "向用户提出的问题" },
    options: {
      type: "array",
      required: true,
      minItems: 2,
      maxItems: 10,
      description: "选项列表",
      items: {
        type: "object",
        description: "一个选项",
        fields: {
          id: { type: "string", format: "id", description: "选项标识（字母数字下划线横线），省略时自动生成 opt1、opt2…" },
          label: { type: "string", required: true, maxLength: 40, description: "选项文字" },
          description: { type: "string", maxLength: 80, description: "选项补充说明（仅单选模式展示）" },
        },
      },
    },
    multiple: { type: "boolean", default: false, description: "是否多选" },
    submitLabel: { type: "string", maxLength: 10, default: "提交", description: "多选模式的提交按钮文字" },
  },
  example: {
    title: "周五团建",
    question: "这周五团建去哪儿？",
    options: [
      { id: "hotpot", label: "火锅", description: "人均 120" },
      { id: "bbq", label: "烧烤", description: "人均 90" },
      { id: "ktv", label: "KTV" },
    ],
  },
  events: {
    select: {
      description: "单选模式：用户点了一个选项（卡片随即关闭）",
      context: { optionId: "选项 id", optionLabel: "选项文字" },
    },
    submit: {
      description: "多选模式：用户点了提交（未选任何项时卡片保持打开）",
      context: { optionIds: "选中的选项 id 数组", optionLabels: "选中的选项文字数组" },
    },
  },

  check(data) {
    return fillIds(asData(data).options as unknown as Array<Record<string, unknown>>, "options", "opt");
  },

  components(data) {
    const d = asData(data);
    const out: A2uiComponent[] = [
      text("title", path("/title"), "h4"),
      text("question", path("/question"), "body", "basic_text_secondary"),
    ];
    if (!d.multiple) {
      out.unshift(column(BODY_ID, ["title", "question", "options"]));
      out.push(
        { id: "options", component: "List", children: { path: "/options", componentId: "option" }, style: { spacing: 8 } },
        {
          id: "option",
          component: "Button",
          child: "option-body",
          variant: "default",
          action: event("select", { optionId: path("id") }, format("我选了：${label}")),
        },
        column("option-body", ["option-label", "option-desc-vis"], 2),
        text("option-label", {
          call: "select",
          args: {
            condition: { call: "equalsString", args: { a: path("id"), b: path("/state/selectedId") } },
            then: format("✓ ${label}"),
            else: path("label"),
          },
        }),
        visibleIf("option-desc-vis", "hasDescription", "option-desc"),
        text("option-desc", path("description"), "caption", "basic_text_tertiary"),
      );
      return out;
    }
    out.unshift(column(BODY_ID, ["title", "question", "picker", "submit"]));
    out.push(
      {
        id: "picker",
        component: "ChoicePicker",
        label: "可多选",
        variant: "multipleSelection",
        displayStyle: "chips",
        options: d.options.map((o) => ({ label: o.label, value: o.id })),
        value: path("/state/selected"),
      },
      ...button("submit", d.submitLabel, event("submit", { optionIds: path("/state/selected") }, "提交了选择"), "primary"),
    );
    return out;
  },

  dataModel(data, state) {
    const d = asData(data);
    const ids = state.closed ? selectedIds(state) : [];
    return {
      title: d.title,
      question: d.question,
      options: d.options.map((o) => ({
        id: o.id,
        label: o.label,
        description: o.description ?? "",
        hasDescription: Boolean(o.description),
      })),
      state: { selectedId: d.multiple ? "" : (ids[0] ?? ""), selected: d.multiple ? ids : [] },
    };
  },

  title: (data) => asData(data).title,

  fallbackText(data) {
    const d = asData(data);
    const lines = d.options.map((o, i) => `${i + 1}. ${o.label}${o.description ? `（${o.description}）` : ""}`);
    return [d.question, ...lines, d.multiple ? "（可多选，请回复序号）" : "（请回复序号）"].join("\n");
  },

  decideAction(data, name, context) {
    const d = asData(data);
    if (name === "select" && !d.multiple) {
      const option = d.options.find((o) => o.id === context.optionId);
      if (!option) return { reject: "invalid_context" };
      return { summary: `选择了「${option.label}」`, context: { optionId: option.id, optionLabel: option.label } };
    }
    if (name === "submit" && d.multiple) {
      const raw = Array.isArray(context.optionIds) ? context.optionIds : [];
      const ids = raw.filter((x): x is string => typeof x === "string");
      if (ids.some((id) => !d.options.some((o) => o.id === id))) return { reject: "invalid_context" };
      if (ids.length === 0) {
        return { summary: "没有勾选任何选项就点了提交", context: { optionIds: [], optionLabels: [] }, keepOpen: true };
      }
      const labels = labelsOf(d, ids);
      return { summary: `选择了${labels.map((l) => `「${l}」`).join("")}`, context: { optionIds: ids, optionLabels: labels } };
    }
    return { reject: "invalid_action" };
  },

  resultText(data, state) {
    const ids = selectedIds(state);
    return ids.length ? `已选择：${labelsOf(asData(data), ids).join("、")}` : "";
  },
};
