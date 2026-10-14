/**
 * Template `confirm`: content + optional key/value details + confirm / cancel buttons.
 * Either button closes the card; the event name (`confirm` / `cancel`) is the answer.
 */

import { BODY_ID, button, column, event, path, text } from "./builder.js";
import type { A2uiComponent, TemplateData, TemplateRenderState, XCardTemplate } from "./types.js";

interface ConfirmData {
  title: string;
  content: string;
  details?: Array<{ label: string; value: string }>;
  confirmLabel: string;
  cancelLabel: string;
}

const asData = (d: TemplateData) => d as unknown as ConfirmData;

export const confirmTemplate: XCardTemplate = {
  key: "confirm",
  name: "确认卡",
  description: "请用户确认或取消一件事（下单、执行操作、提交前确认等），可附带明细",
  usage: "执行有影响的操作前需要用户明确同意时使用。用户点确认或取消后卡片关闭，事件名就是用户的答复。",
  mode: "once",
  fields: {
    title: { type: "string", required: true, maxLength: 40, description: "卡片标题" },
    content: { type: "string", required: true, maxLength: 500, description: "需要用户确认的内容" },
    details: {
      type: "array",
      maxItems: 10,
      description: "明细（可选），逐行展示「名称：值」",
      items: {
        type: "object",
        description: "一行明细",
        fields: {
          label: { type: "string", required: true, maxLength: 20, description: "名称" },
          value: { type: "string", required: true, maxLength: 100, description: "值" },
        },
      },
    },
    confirmLabel: { type: "string", maxLength: 8, default: "确认", description: "确认按钮文字" },
    cancelLabel: { type: "string", maxLength: 8, default: "取消", description: "取消按钮文字" },
  },
  example: {
    title: "确认下单",
    content: "将为你下单以下商品，确认后立即支付。",
    details: [
      { label: "商品", value: "生椰拿铁（大杯 / 少冰）" },
      { label: "门店", value: "科兴科学园店" },
      { label: "金额", value: "¥18.00" },
    ],
    confirmLabel: "确认下单",
  },
  events: {
    confirm: { description: "用户点了确认（卡片随即关闭）", context: {} },
    cancel: { description: "用户点了取消（卡片随即关闭）", context: {} },
  },

  components(data) {
    const d = asData(data);
    const details = d.details ?? [];
    const out: A2uiComponent[] = [
      column(BODY_ID, ["title", "content", ...details.map((_, i) => `d${i}`), "buttons"], 10),
      text("title", path("/title"), "h4"),
      text("content", path("/content")),
    ];
    details.forEach((row, i) => {
      out.push(
        { id: `d${i}`, component: "Row", children: [`d${i}-label`, `d${i}-value`], align: "center", style: { spacing: 8 } },
        text(`d${i}-label`, row.label, "caption", "basic_text_secondary"),
        { ...text(`d${i}-value`, row.value), weight: 1 },
      );
    });
    out.push(
      { id: "buttons", component: "Row", children: ["cancel", "confirm"], style: { spacing: 8 } },
      ...button("cancel", d.cancelLabel, event("cancel", {}, d.cancelLabel)),
      ...button("confirm", d.confirmLabel, event("confirm", {}, d.confirmLabel), "primary"),
    );
    return out;
  },

  dataModel(data) {
    const d = asData(data);
    return { title: d.title, content: d.content };
  },

  title: (data) => asData(data).title,

  fallbackText(data) {
    const d = asData(data);
    const rows = (d.details ?? []).map((r) => `${r.label}：${r.value}`);
    return [d.title, d.content, ...rows, `（请回复「${d.confirmLabel}」或「${d.cancelLabel}」）`].join("\n");
  },

  decideAction(data, name) {
    const d = asData(data);
    const said = (label: string, meaning: string) => `点了「${label}」${label === meaning ? "" : `（${meaning}）`}`;
    if (name === "confirm") return { summary: said(d.confirmLabel, "确认"), context: {} };
    if (name === "cancel") return { summary: said(d.cancelLabel, "取消"), context: {} };
    return { reject: "invalid_action" };
  },

  resultText(data, state: TemplateRenderState) {
    const d = asData(data);
    if (state.last?.action === "confirm") return `已${d.confirmLabel}`;
    if (state.last?.action === "cancel") return `已${d.cancelLabel}`;
    return "";
  },
};
