/**
 * Template `item_list`: 1–10 product / store / result rows, optionally selectable.
 *
 * Rows render through a `List` bound to `/items`: optional thumbnail, title, subtitle,
 * description and a meta line (price + tags joined, precomputed in the DataModel). Optional
 * parts are wrapped in `Visibility` driven by precomputed `has*` flags, so empty fields leave no
 * blank lines. With `selectable` (default) each row has a button firing `select` with
 * `context.itemId`; the first accepted pick closes the card and marks the row ✓.
 */

import { BODY_ID, column, event, format, path, text, visibleIf } from "./builder.js";
import { fillIds } from "./schema.js";
import type { A2uiComponent, TemplateData, TemplateRenderState, XCardTemplate } from "./types.js";

interface ListItem {
  id: string;
  title: string;
  subtitle?: string;
  description?: string;
  imageUrl?: string;
  price?: string;
  tags?: string[];
}

interface ListData {
  title: string;
  subtitle?: string;
  items: ListItem[];
  actionLabel: string;
  selectable: boolean;
}

const asData = (d: TemplateData) => d as unknown as ListData;

function selectedId(state: TemplateRenderState): string {
  const id = state.last?.context?.itemId;
  return typeof id === "string" ? id : "";
}

function metaText(item: ListItem): string {
  return [item.price, ...(item.tags ?? [])].filter(Boolean).join(" · ");
}

export const itemListTemplate: XCardTemplate = {
  key: "item_list",
  name: "商品 / 门店列表",
  description: "展示 1~10 个商品、门店或搜索结果（图片、标题、副标题、价格、标签），可让用户点选其中一个",
  usage: "给用户看一组候选对象并让其挑一个时使用（selectable=false 时仅展示）。图片必须是可公开访问的 http(s) 链接，没有就省略 imageUrl。",
  mode: "once",
  fields: {
    title: { type: "string", required: true, maxLength: 40, description: "卡片标题" },
    subtitle: { type: "string", maxLength: 60, description: "标题下的说明（可选）" },
    items: {
      type: "array",
      required: true,
      minItems: 1,
      maxItems: 10,
      description: "列表项",
      items: {
        type: "object",
        description: "一项",
        fields: {
          id: { type: "string", format: "id", description: "项标识，省略时自动生成 item1、item2…" },
          title: { type: "string", required: true, maxLength: 40, description: "名称" },
          subtitle: { type: "string", maxLength: 60, description: "副标题，如地址、规格" },
          description: { type: "string", maxLength: 120, description: "补充描述，如距离、营业时间" },
          imageUrl: { type: "string", format: "url", description: "缩略图链接" },
          price: { type: "string", maxLength: 20, description: "价格文本，如 ¥18、¥32 起" },
          tags: {
            type: "array",
            maxItems: 3,
            description: "标签",
            items: { type: "string", required: true, maxLength: 10, description: "标签文字" },
          },
        },
      },
    },
    actionLabel: { type: "string", maxLength: 8, default: "选择", description: "每项按钮文字" },
    selectable: { type: "boolean", default: true, description: "是否可点选；false 时只展示" },
  },
  example: {
    title: "附近门店",
    subtitle: "按距离排序",
    items: [
      { id: "s1", title: "科兴科学园店", subtitle: "南山区科苑路 15 号", description: "距你 350m · 营业至 22:00", tags: ["可自提"] },
      { id: "s2", title: "腾讯滨海大厦店", subtitle: "南山区后海大道 33 号", description: "距你 1.2km", tags: ["可外送", "人少"] },
    ],
    actionLabel: "去这家",
  },
  events: {
    select: {
      description: "用户点选了某一项（卡片随即关闭）",
      context: { itemId: "项 id", itemTitle: "项名称" },
    },
  },

  check(data) {
    return fillIds(asData(data).items as unknown as Array<Record<string, unknown>>, "items", "item");
  },

  components(data) {
    const d = asData(data);
    const out: A2uiComponent[] = [
      column(BODY_ID, ["title", ...(d.subtitle ? ["subtitle"] : []), "items"]),
      text("title", path("/title"), "h4"),
      { id: "items", component: "List", children: { path: "/items", componentId: "item" }, style: { spacing: 10 } },
      {
        id: "item",
        component: "Row",
        // The button sits under the text, not beside it: on a ~220px mobile card a side
        // button plus thumbnail leaves the weighted text column almost no width.
        children: ["item-img-vis", "item-main"],
        align: "start",
        style: { spacing: 10 },
      },
      visibleIf("item-img-vis", "hasImage", "item-img"),
      {
        id: "item-img",
        component: "Image",
        url: path("imageUrl"),
        description: "图片",
        fit: "cover",
        style: { width: 56, height: 56, shape: 8 },
      },
      {
        ...column(
          "item-main",
          ["item-title", "item-sub-vis", "item-desc-vis", "item-meta-vis", ...(d.selectable ? ["item-btn"] : [])],
          4,
        ),
        align: "start",
        weight: 1,
      },
      text("item-title", path("title"), "h5"),
      visibleIf("item-sub-vis", "hasSubtitle", "item-sub"),
      text("item-sub", path("subtitle"), "caption", "basic_text_secondary"),
      visibleIf("item-desc-vis", "hasDescription", "item-desc"),
      text("item-desc", path("description"), "caption", "basic_text_tertiary"),
      visibleIf("item-meta-vis", "hasMeta", "item-meta"),
      text("item-meta", path("metaText"), "caption", "basic_text_brand"),
    ];
    if (d.subtitle) out.push(text("subtitle", path("/subtitle"), "caption", "basic_text_secondary"));
    if (d.selectable) {
      out.push(
        {
          id: "item-btn",
          component: "Button",
          child: "item-btn-label",
          variant: "default",
          action: event("select", { itemId: path("id") }, format("我选了：${title}")),
        },
        text("item-btn-label", {
          call: "select",
          args: {
            condition: { call: "equalsString", args: { a: path("id"), b: path("/state/selectedId") } },
            then: "✓ 已选",
            else: d.actionLabel,
          },
        }),
      );
    }
    return out;
  },

  dataModel(data, state) {
    const d = asData(data);
    return {
      title: d.title,
      subtitle: d.subtitle ?? "",
      items: d.items.map((it) => {
        const meta = metaText(it);
        return {
          id: it.id,
          title: it.title,
          subtitle: it.subtitle ?? "",
          description: it.description ?? "",
          imageUrl: it.imageUrl ?? "",
          metaText: meta,
          hasImage: Boolean(it.imageUrl),
          hasSubtitle: Boolean(it.subtitle),
          hasDescription: Boolean(it.description),
          hasMeta: Boolean(meta),
        };
      }),
      state: { selectedId: state.closed ? selectedId(state) : "" },
    };
  },

  title: (data) => asData(data).title,

  fallbackText(data) {
    const d = asData(data);
    const lines = d.items.map((it, i) => {
      const extra = [it.subtitle, it.description, metaText(it)].filter(Boolean).join("，");
      return `${i + 1}. ${it.title}${extra ? `（${extra}）` : ""}`;
    });
    return [d.title, ...(d.subtitle ? [d.subtitle] : []), ...lines, ...(d.selectable ? ["（请回复序号选择）"] : [])].join("\n");
  },

  decideAction(data, name, context) {
    const d = asData(data);
    if (name !== "select" || !d.selectable) return { reject: "invalid_action" };
    const item = d.items.find((it) => it.id === context.itemId);
    if (!item) return { reject: "invalid_context" };
    return { summary: `选择了「${item.title}」`, context: { itemId: item.id, itemTitle: item.title } };
  },

  resultText(data, state) {
    const id = selectedId(state);
    const item = asData(data).items.find((it) => it.id === id);
    return item ? `已选择：${item.title}` : "";
  },
};
