import assert from "node:assert/strict";
import test from "node:test";
import type { YuanbaoWsClient } from "../../access/ws/client.js";
import type { ResolvedYuanbaoAccount, YuanbaoMsgBodyElement } from "../../types.js";
import { MAX_CARD_CONTENT_BYTES } from "./constants.js";
import { extractA2uiReplyPart, mayBecomeA2uiReply, sendA2uiReplyPart } from "./reply-part.js";
import { getSurface, listSurfaces } from "./registry.js";

void test("extractA2uiReplyPart reads structured a2ui payloads", () => {
  assert.deepEqual(extractA2uiReplyPart({
    type: "a2ui",
    content: 'root = Text("hi")',
    metadata: { title: "问候", mode: "perRevision", audience: "anyone", surfaceId: "s1" },
  }), {
    content: 'root = Text("hi")',
    title: "问候",
    mode: "perRevision",
    audience: "anyone",
    surfaceId: "s1",
  });
});

void test("extractA2uiReplyPart reads a whole-reply a2ui block", () => {
  assert.deepEqual(extractA2uiReplyPart({ text: '\n<a2ui>root = Text("hi")</a2ui>\n' }), {
    content: 'root = Text("hi")',
    mode: "once",
    audience: "requester",
  });
});

void test("extractA2uiReplyPart preserves text before and after the card", () => {
  assert.deepEqual(extractA2uiReplyPart({ text: '[bot] 前文\n<a2ui>root = Text("hi")</a2ui>\n后文' }), {
    content: 'root = Text("hi")',
    mode: "once",
    audience: "requester",
    textBefore: "[bot] 前文",
    textAfter: "后文",
  });
});

void test("extractA2uiReplyPart ignores incomplete blocks", () => {
  assert.equal(extractA2uiReplyPart({ text: 'prefix\n<a2ui>root = Text("hi")' }), undefined);
  assert.equal(extractA2uiReplyPart({ text: "普通文本 <a2ui 是一个标签" }), undefined);
});

void test("extractA2uiReplyPart tolerates markdown fences around the a2ui block", () => {
  assert.deepEqual(extractA2uiReplyPart({ text: '```html\n<a2ui>\nroot = Text("hi")\n</a2ui>\n```' }), {
    content: 'root = Text("hi")',
    mode: "once",
    audience: "requester",
  });
});

void test("extractA2uiReplyPart strips an inner markdown fence but preserves prose", () => {
  assert.deepEqual(extractA2uiReplyPart({
    text: [
      "以下生成的是一个 todo list 的 A2UI Express 卡片内容：",
      "",
      "```text",
      "<a2ui>",
      'root = Text("hi")',
      "</a2ui>",
      "```",
      "",
      "这是一个简单清晰的多项待办列表模板。",
    ].join("\n"),
  }), {
    content: 'root = Text("hi")',
    mode: "once",
    audience: "requester",
    textBefore: "以下生成的是一个 todo list 的 A2UI Express 卡片内容：",
    textAfter: "这是一个简单清晰的多项待办列表模板。",
  });
});

void test("extractA2uiReplyPart does not treat code fences as a card", () => {
  assert.equal(extractA2uiReplyPart({
    text: [
      "下面是卡片：",
      "```text",
      '$/title = "任务清单"',
      "root = Card(Column(children=[Text($/title)]))",
      "```",
    ].join("\n"),
  }), undefined);
  assert.equal(extractA2uiReplyPart({ text: '```ts\nconst root = Text("x");\n```' }), undefined);
});

void test("mayBecomeA2uiReply holds only partials that can still become a whole a2ui reply", () => {
  for (const text of ["<", "<a2", "<a2ui>\nroot = Te", "  <A2UI>", "`", "```", "```html", "```html\n", "```html\n<a2ui>"]) {
    assert.equal(mayBecomeA2uiReply(text), true, text);
  }
  for (const text of ["", "你好", "<div>", "`code`", "```ts\nconst a = 1;", "prefix <a2ui>"]) {
    assert.equal(mayBecomeA2uiReply(text), false, text);
  }
});

function wireClient(rejectCard = false) {
  const calls: Array<{ method: string; msgBody: YuanbaoMsgBodyElement[] }> = [];
  const send = async (method: string, request: { msg_body: YuanbaoMsgBodyElement[] }) => {
    calls.push({ method, msgBody: request.msg_body });
    const isCard = request.msg_body.some(element => element.msg_type === "TIMCustomElem");
    return { code: rejectCard && isCard ? 10002 : 0, message: "", msgId: "test-msg" };
  };
  const client = {
    sendGroupMessage: (request: { msg_body: YuanbaoMsgBodyElement[] }) => send("group", request),
    sendC2CMessage: (request: { msg_body: YuanbaoMsgBodyElement[] }) => send("direct", request),
  } as unknown as YuanbaoWsClient;
  return { client, calls };
}

function sendParams(accountId: string, client: YuanbaoWsClient, isGroup = true) {
  return {
    account: { accountId, botId: "bot" } as ResolvedYuanbaoAccount,
    wsClient: client,
    isGroup,
    targetId: "peer",
    sessionKey: `agent:main:yuanbao:${accountId}`,
    ownerUserId: "requester",
  };
}

void test("sendA2uiReplyPart sends text/card/text in one group or direct request", async () => {
  for (const isGroup of [true, false]) {
    const { client, calls } = wireClient();
    const part = extractA2uiReplyPart({
      text: `[bot] ${"前".repeat(700)}\n<a2ui>root = Card(Text("hi"))</a2ui>\n后文`,
    })!;
    const result = await sendA2uiReplyPart({ ...sendParams(`mixed-${isGroup}`, client, isGroup), part });
    assert.deepEqual(result, { ok: true, updated: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, isGroup ? "group" : "direct");
    const body = calls[0].msgBody;
    assert.deepEqual(body.map(element => element.msg_type), ["TIMTextElem", "TIMCustomElem", "TIMTextElem"]);
    assert.equal(body[0].msg_content.text, part.textBefore);
    assert.equal(body[2].msg_content.text, part.textAfter);
    const envelope = JSON.parse(JSON.parse(body[1].msg_content.data!).text);
    assert.equal(envelope.extend_type, 101);
    assert.ok(envelope.content.some((message: { updateComponents?: unknown }) => message.updateComponents));
  }
});

void test("sendA2uiReplyPart omits missing or whitespace-only surrounding text", async () => {
  for (const surrounding of [
    {},
    { textBefore: "  ", textAfter: "\n" },
    { textBefore: "前文" },
    { textAfter: "后文" },
  ]) {
    const { client, calls } = wireClient();
    const result = await sendA2uiReplyPart({
      ...sendParams("optional-text", client),
      part: { content: 'root = Card(Text("hi"))', ...surrounding },
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].msgBody.map(element => element.msg_type), [
      ...(surrounding.textBefore?.trim() ? ["TIMTextElem"] : []),
      "TIMCustomElem",
      ...(surrounding.textAfter?.trim() ? ["TIMTextElem"] : []),
    ]);
  }
});

void test("sendA2uiReplyPart preserves surrounding text in one refusal fallback", async () => {
  const { client, calls } = wireClient(true);
  const result = await sendA2uiReplyPart({
    ...sendParams("mixed-fallback", client),
    part: { content: 'root = Card(Text("hi"))', textBefore: "前文", textAfter: "后文" },
  });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 2, "one rejected card attempt and one text fallback");
  assert.deepEqual(calls[1].msgBody, [{ msg_type: "TIMTextElem", msg_content: { text: "前文\n交互卡片\n后文" } }]);
  assert.equal(listSurfaces("mixed-fallback").length, 0);
});

void test("sendA2uiReplyPart size-checks text and card together without splitting", async () => {
  const { client, calls } = wireClient();
  const result = await sendA2uiReplyPart({
    ...sendParams("mixed-too-large", client),
    part: { content: 'root = Card(Text("hi"))', textBefore: "前".repeat(MAX_CARD_CONTENT_BYTES / 2) },
  });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 0);
});

void test("sendA2uiReplyPart includes surrounding text in the single update request", async () => {
  const { client, calls } = wireClient();
  const params = sendParams("mixed-update", client);
  const initial = await sendA2uiReplyPart({ ...params, part: { content: 'root = Card(Text("hi"))' } });
  assert.equal(initial.ok, true);
  const rec = listSurfaces("mixed-update")[0];
  rec.cardMessageId = "original-card";
  calls.length = 0;
  const result = await sendA2uiReplyPart({
    ...params,
    part: { content: 'root = Card(Text("updated"))', surfaceId: rec.surfaceId, textBefore: "前文", textAfter: "后文" },
  });
  assert.deepEqual(result, { ok: true, updated: true });
  assert.equal(calls.length, 1);
  const body = calls[0].msgBody;
  assert.deepEqual(body.map(element => element.msg_type), ["TIMTextElem", "TIMCustomElem", "TIMTextElem"]);
  assert.equal(body[0].msg_content.text, "前文");
  assert.equal(body[2].msg_content.text, "后文");
  const envelope = JSON.parse(JSON.parse(body[1].msg_content.data!).text);
  assert.equal(envelope.extend_type, 103);
  assert.equal(envelope.content.card_message_id, "original-card");
  assert.equal(getSurface(rec.surfaceId)?.revision, 2);
});

void test("extractA2uiReplyPart reads nested parts", () => {
  assert.deepEqual(extractA2uiReplyPart({
    parts: [
      { type: "text", text: "hello" },
      { kind: "a2ui-express", content: 'root = Text("card")' },
    ],
  }), {
    content: 'root = Text("card")',
    mode: "once",
    audience: "requester",
  });
});
