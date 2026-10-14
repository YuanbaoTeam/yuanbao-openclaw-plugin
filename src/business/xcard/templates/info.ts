/**
 * Template `info`: a display card (title, subtitle, image, text, key/value fields, footer) with
 * up to 4 buttons. A button with `url` opens the link on the client (`openUrl`, no event reaches
 * the plugin); one without `url` fires `click` with `context.buttonId`. The card stays open
 * (mode=perRevision): every click is forwarded and the card is re-sent at the next revision so it
 * can be clicked again; the model closes or updates it when done.
 */

import { BODY_ID, button, column, event, openUrl, path, text } from "./builder.js";
import { fillIds } from "./schema.js";
import type { A2uiComponent, TemplateData, XCardTemplate } from "./types.js";

interface InfoButton {
  id: string;
  label: string;
  url?: string;
}

interface InfoData {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  content?: string;
  fields?: Array<{ label: string; value: string }>;
  buttons?: InfoButton[];
  footer?: string;
}

const asData = (d: TemplateData) => d as unknown as InfoData;

export const infoTemplate: XCardTemplate = {
  key: "info",
  name: "信息展示卡",
  description: "结构化展示一段信息（摘要、通知、详情、天气、行程等），可带图片、字段列表和链接/操作按钮",
  usage: "需要把信息排版得比纯文字更清晰时使用。按钮带 url 时点击直接打开链接；不带 url 时点击会以 click 事件转交给你。卡片不会因点击关闭，处理完可以 close 或 update。",
  mode: "perRevision",
  fields: {
    title: { type: "string", required: true, maxLength: 40, description: "卡片标题" },
    subtitle: { type: "string", maxLength: 60, description: "副标题（可选）" },
    imageUrl: { type: "string", format: "url", description: "头图链接（可选，16:9 展示）" },
    content: { type: "string", maxLength: 1000, description: "正文（可选）" },
    fields: {
      type: "array",
      maxItems: 12,
      description: "字段列表（可选），逐行展示「名称：值」",
      items: {
        type: "object",
        description: "一行",
        fields: {
          label: { type: "string", required: true, maxLength: 20, description: "名称" },
          value: { type: "string", required: true, maxLength: 200, description: "值" },
        },
      },
    },
    buttons: {
      type: "array",
      maxItems: 4,
      description: "按钮（可选）",
      items: {
        type: "object",
        description: "一个按钮",
        fields: {
          id: { type: "string", format: "id", description: "按钮标识，省略时自动生成 btn1、btn2…" },
          label: { type: "string", required: true, maxLength: 10, description: "按钮文字" },
          url: { type: "string", format: "url", description: "点击打开的链接；省略则点击回传 click 事件" },
        },
      },
    },
    footer: { type: "string", maxLength: 100, description: "底部注释（可选），如数据来源、更新时间" },
  },
  example: {
    title: "深圳今日天气",
    subtitle: "10 月 12 日 周一",
    content: "多云转晴，午后有短时阵雨，出门记得带伞。",
    fields: [
      { label: "温度", value: "24~31℃" },
      { label: "湿度", value: "78%" },
      { label: "空气质量", value: "良" },
    ],
    buttons: [{ id: "week", label: "看未来一周" }, { label: "气象台", url: "https://weather.cma.cn" }],
    footer: "数据来源：中国气象局",
  },
  events: {
    click: {
      description: "用户点了一个不带 url 的按钮（卡片保持打开）",
      context: { buttonId: "按钮 id", buttonLabel: "按钮文字" },
    },
  },

  check(data) {
    const buttons = asData(data).buttons;
    return buttons ? fillIds(buttons as unknown as Array<Record<string, unknown>>, "buttons", "btn") : [];
  },

  components(data) {
    const d = asData(data);
    const fields = d.fields ?? [];
    const buttons = d.buttons ?? [];
    const children = ["title"];
    const out: A2uiComponent[] = [text("title", path("/title"), "h4")];
    if (d.subtitle) {
      children.push("subtitle");
      out.push(text("subtitle", path("/subtitle"), "caption", "basic_text_secondary"));
    }
    if (d.imageUrl) {
      children.push("image");
      out.push({
        id: "image",
        component: "Image",
        url: d.imageUrl,
        description: d.title,
        fit: "cover",
        style: { fillMaxWidth: 1, aspectRatio: 1.78, shape: 8 },
      });
    }
    if (d.content) {
      children.push("content");
      out.push(text("content", path("/content")));
    }
    fields.forEach((row, i) => {
      children.push(`f${i}`);
      out.push(
        { id: `f${i}`, component: "Row", children: [`f${i}-label`, `f${i}-value`], align: "center", style: { spacing: 8 } },
        text(`f${i}-label`, row.label, "caption", "basic_text_secondary"),
        { ...text(`f${i}-value`, row.value), weight: 1 },
      );
    });
    if (buttons.length) {
      children.push("buttons");
      out.push({ id: "buttons", component: "Row", children: buttons.map((_, i) => `b${i}`), style: { spacing: 8 } });
      buttons.forEach((b, i) => {
        const action = b.url ? openUrl(b.url) : event("click", { buttonId: b.id }, b.label);
        out.push(...button(`b${i}`, b.label, action, i === 0 ? "primary" : "default"));
      });
    }
    if (d.footer) {
      children.push("footer");
      out.push(text("footer", path("/footer"), "caption", "basic_text_tertiary"));
    }
    out.unshift(column(BODY_ID, children, 8));
    return out;
  },

  dataModel(data) {
    const d = asData(data);
    return { title: d.title, subtitle: d.subtitle ?? "", content: d.content ?? "", footer: d.footer ?? "" };
  },

  title: (data) => asData(data).title,

  fallbackText(data) {
    const d = asData(data);
    return [
      d.title,
      ...(d.subtitle ? [d.subtitle] : []),
      ...(d.content ? [d.content] : []),
      ...(d.fields ?? []).map((r) => `${r.label}：${r.value}`),
      ...(d.buttons ?? []).filter((b) => b.url).map((b) => `${b.label}：${b.url}`),
      ...(d.footer ? [d.footer] : []),
    ].join("\n");
  },

  decideAction(data, name, context) {
    if (name !== "click") return { reject: "invalid_action" };
    const b = (asData(data).buttons ?? []).find((x) => x.id === context.buttonId && !x.url);
    if (!b) return { reject: "invalid_context" };
    return { summary: `点了按钮「${b.label}」`, context: { buttonId: b.id, buttonLabel: b.label } };
  },

  resultText: () => "",
};
