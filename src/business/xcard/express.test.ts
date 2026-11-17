import assert from "node:assert/strict";
import test from "node:test";
import { compileExpressMessages, normalizeExpressMessages } from "./express.js";
import { validateGeneratedMessages } from "./generated.js";

void test("compileExpressMessages compiles Express into Yuanbao generated xCard messages", () => {
  const res = compileExpressMessages('$/title = "航班"\nroot = Card(Text($/title))');
  assert.ok("messages" in res, "compile should succeed");
  assert.equal(res.messages.length, 3);
  assert.deepEqual(res.messages[0], {
    version: "v1.0",
    createSurface: {
      surfaceId: "main",
      catalogId: "https://yuanbao.tencent.com/specification/v1_0/catalogs/xcard/catalog.json",
    },
  });
  assert.deepEqual(res.messages[1]?.updateComponents, {
    surfaceId: "main",
    components: [
      { id: "root", component: "Card", child: "root_child" },
      { id: "root_child", component: "Text", text: { path: "/title" } },
    ],
  });
  assert.equal(validateGeneratedMessages(res.messages).ok, true);
});

void test("compileExpressMessages repairs common root formatting noise", () => {
  const upperRoot = compileExpressMessages('$/title = "任务"\nRoot = Card(Text($/title))');
  assert.ok("messages" in upperRoot, "Root should be normalized to root");

  const bareRoot = compileExpressMessages('$/title = "任务"\nCard(Text($/title))');
  assert.ok("messages" in bareRoot, "bare root component should be assigned to root");

  const namedRoot = compileExpressMessages('$/title = "任务"\ncard = Card(Text($/title))');
  assert.ok("messages" in namedRoot, "obvious card variable should be renamed to root");
});

void test("compileExpressMessages strips diff-style addition prefixes", () => {
  const res = compileExpressMessages([
    '+ $/title = "任务"',
    "+ root = Card(",
    "+   Text($/title)",
    "+ )",
  ].join("\n"));
  assert.ok("messages" in res, "diff addition prefixes should be ignored");
});

void test("compileExpressMessages tolerates markdown and a2ui wrappers", () => {
  const res = compileExpressMessages("<a2ui>\nroot = Text(\"hi\")\n</a2ui>");
  assert.ok("messages" in res, "compile should succeed");
  const fenced = compileExpressMessages("```markdown\n<a2ui>\nroot = Text(\"hi\")\n</a2ui>\n```");
  assert.ok("messages" in fenced, "compile should strip fences and a2ui tags");
});

void test("compileExpressMessages rejects invented list JSON schema", () => {
  const res = compileExpressMessages(JSON.stringify({
    type: "list",
    title: "Todo List",
    items: [
      { label: "1. Complete project proposal", value: "High Priority", complete: false },
      { label: "2. Team meeting preparation", value: "Medium Priority", complete: false },
    ],
  }, null, 2));
  assert.ok("error" in res, "invented JSON schema should not be accepted");
  assert.ok(res.errors?.some(hint => hint.includes('{"type":"list"')));
  assert.ok(res.errors?.some(hint => hint.includes("root = Card")));
});

void test("compileExpressMessages rejects JS-style array indexing in bindings", () => {
  const res = compileExpressMessages([
    '$/todo/items = [{label: "完善项目需求文档", done: false}]',
    "root = Card(List(children=[Text($/todo/items[0].label)]))",
  ].join("\n"));
  assert.ok("error" in res);
  assert.match(res.error, /Failed to parse expression|mismatched input/);
  assert.ok(res.errors?.some((hint) => hint.includes("_template($/todo/items")));
});

void test("compileExpressMessages provides hints for invented components and text style", () => {
  const res = compileExpressMessages([
    'root = Card(Column(children=[Text("任务", style="title"), List(children=[',
    "  ListItem(Text(\"A\"), icon=Checkbox(false))",
    "])]))",
  ].join("\n"));
  assert.ok("error" in res);
  assert.ok(res.errors?.some((hint) => hint.includes("没有 ListItem")));
  assert.ok(res.errors?.some((hint) => hint.includes("没有 Checkbox")));
});

void test("compileExpressMessages reports indexed todo-list output instead of rewriting it", () => {
  const res = compileExpressMessages([
    '$/todo/title = "任务清单"',
    '$/todo/items = [{"label": "整理团队沟通记录", "done": true}]',
    "root = Card(Column(children=[",
    'Text($/todo/title, style="title"),',
    "List(items=[ListItem(Text($/todo/items[0].label), icon=Checkbox($/todo/items[0].done))]),",
    'Button(Text("提交"), action=Event("submit", {resultText: "已提交"}))',
    "]))",
  ].join("\n"));
  assert.ok("error" in res, "structural mistakes must not be silently rewritten");
  assert.ok(res.errors?.some((hint) => hint.includes("数组下标")));
  assert.ok(res.errors?.some((hint) => hint.includes("List 没有 items 参数")));
});

void test("compileExpressMessages rejects Text style and suggests variant", () => {
  const res = compileExpressMessages('root = Card(Text("任务", style="title"))');
  assert.ok("error" in res);
  assert.ok(res.errors?.some(hint => hint.includes('variant="h4"')));
});

void test("compileExpressMessages normalizes common Text variant aliases", () => {
  const res = compileExpressMessages([
    '$/title = "7日天气预报"',
    '$/days = [{date: "11月17日", weather: "晴", temp: "12°C ~ 18°C"}]',
    "dayBlock = Row(children=[",
    '  Text($date, variant="body2"),',
    '  Text($weather, variant="caption"),',
    '  Text($temp, variant="caption")',
    "])",
    "root = Card(Column(children=[",
    '  Text($/title, variant="title"),',
    "  Column(_template($/days, dayBlock))",
    "]))",
  ].join("\n"));
  assert.ok("messages" in res, "variant aliases should compile");
  const texts = res.messages[1]?.updateComponents?.components?.filter(component => component.component === "Text") ?? [];
  assert.ok(texts.some(component => component.variant === "body"));
  assert.ok(texts.some(component => component.variant === "h4"));
  assert.equal(validateGeneratedMessages(res.messages).ok, true);
});

void test("compileExpressMessages suggests removing unsupported plus syntax", () => {
  const res = compileExpressMessages('root = Card(Text("任务" + "清单"))');
  assert.ok("error" in res);
  assert.ok(res.errors?.some(hint => hint.includes("字符串拼接")));
});

void test("compileExpressMessages preserves style-like text literals and business values", () => {
  const literal = "Use style='title' literally";
  const inline = compileExpressMessages(`root = Card(Text(${JSON.stringify(literal)}))`);
  assert.ok("messages" in inline);
  const text = inline.messages[1]?.updateComponents?.components?.find(component => component.component === "Text");
  assert.equal(text?.text, literal);

  const bound = compileExpressMessages(`$/message = ${JSON.stringify(literal)}\nroot = Card(Text($/message))`);
  assert.ok("messages" in bound);
  assert.deepEqual(bound.messages[2]?.updateDataModel?.value, { message: literal });
});

void test("compileExpressMessages compiles List with _template", () => {
  const res = compileExpressMessages([
    '$/todo/title = "我的待办事项"',
    '$/todo/items = [{label: "完善项目需求文档", done: false}, {label: "代码审查", done: true}]',
    "item = Text($label)",
    "root = Card(Column(children=[Text($/todo/title), List(_template($/todo/items, item))]))",
  ].join("\n"));
  assert.ok("messages" in res, "compile should succeed");
  const list = res.messages[1]?.updateComponents?.components?.find((component) => component.component === "List");
  assert.deepEqual(list?.children, { path: "/todo/items", componentId: "item" });
  assert.equal(validateGeneratedMessages(res.messages).ok, true);
});

void test("normalizeExpressMessages splits v1 createSurface payload and normalizes @path", () => {
  const res = normalizeExpressMessages([
    {
      version: "1.0",
      createSurface: {
        surfaceId: "draft",
        catalogId: "https://yuanbao.tencent.com/specification/v1_0/catalogs/xcard/catalog.json",
        components: [
          { id: "root", component: "Card", child: "label" },
          { id: "label", component: "Text", text: { "@path": "/title" } },
        ],
        dataModel: { title: "hello", meta: { "@path": "user-value" } },
      },
    },
  ]);
  assert.ok("messages" in res);
  assert.deepEqual(res.messages[1]?.updateComponents, {
    surfaceId: "draft",
    components: [
      { id: "root", component: "Card", child: "label" },
      { id: "label", component: "Text", text: { path: "/title" } },
    ],
  });
  assert.deepEqual(res.messages[2]?.updateDataModel?.value, { title: "hello", meta: { "@path": "user-value" } });
  assert.equal(validateGeneratedMessages(res.messages).ok, true);
});
