/**
 * Shared Yuanbao xCard prompt guidance.
 *
 * This must reach both explicit message-tool turns and automatic source replies;
 * automatic replies do not see messageToolHints when the message tool is filtered.
 */
export function buildA2uiReplyHints(): string[] {
  return [
    "Visual-first in Yuanbao: when the answer is a categorized recommendation/list or has 3+ structured items, comparisons, steps, options, status/progress, forms, confirmations, votes, or actions, you MUST use an A2UI xCard by default instead of Markdown tables or long bullet lists. Use plain text only when the user asks for text-only or the answer is short/simple.",
    "xCard trigger examples: for prompts like \"有哪些\", \"推荐\", \"列出\", \"排行\", \"对比\", \"行程\", travel spots/restaurants/routes/plans, or any categorized result list, return a concise intro plus <a2ui>...</a2ui>; do not answer as plain Markdown bullets.",
    "xCard: to visualize the answer, embed exactly one raw <a2ui>...</a2ui> block directly in final text. Plain prose may appear before/after it when useful, but never wrap the block in Markdown/code fences or .json/.jsonl.",
    "xCard Express quick syntax: the <a2ui> body is not JSON. Use data lines plus one root: $/items=[{label:\"...\",value:\"...\"}]; item=Column(children=[Text($label),Text($value,variant=\"caption\")]); root=Card(Column(children=[List(_template($/items,item))])).",
    "xCard few-shot: User asks \"西安有哪些景点\" => reply with <a2ui>$/title=\"西安景点推荐\"; root=Card(Column(children=[Text($/title,variant=\"h4\"),Text(\"必去经典\",variant=\"h5\"),Text(\"秦始皇兵马俑：西安王牌景点，建议留半天。\"),Text(\"西安城墙：适合骑行或傍晚散步。\"),Text(\"大雁塔/大慈恩寺：唐文化地标，晚上可看北广场音乐喷泉。\"),Text(\"钟楼/鼓楼：市中心地标，适合夜景拍照。\")]))</a2ui>. Do not output the same content as Markdown bullets.",
    "xCard Express bounds: root is required; repeated data uses List(_template($/items,item)) with relative bindings like $label; Text.variant only h1/h2/h3/h4/h5/caption/footnote/body. Full examples live in xcard-generator.",
    "xCard forbidden: no JSON/JSONL, invented type/items schemas, createSurface/updateComponents/surfaceId/components, $/items[0], List(items=[...]), ListItem, Checkbox, Text(..., style=\"title\"), body1/body2/title/subtitle/headline variants.",
  ];
}
