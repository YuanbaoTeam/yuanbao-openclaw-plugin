/**
 * Unit tests for utils.ts.
 *
 * Coverage: textDesensitization, msgBodyDesensitization
 */

import assert from "node:assert/strict";
import test from "node:test";
import { extractGroupCode, isYbGroupChat, json, msgBodyDesensitization, resolveYuanbaoConversation, text, textDesensitization } from "./utils.js";
import type { OpenClawPluginToolContext } from "./utils.js";

void test("isYbGroupChat true only for yuanbao group sessionKey", () => {
  const ctx = (over: Record<string, unknown>) => over as unknown as OpenClawPluginToolContext;
  assert.equal(isYbGroupChat(ctx({ messageChannel: "yuanbao", sessionKey: "agent:a:yuanbao:group:g1" })), true);
  assert.equal(isYbGroupChat(ctx({ messageChannel: "yuanbao", sessionKey: "agent:a:yuanbao:user:u1" })), false);
  assert.equal(isYbGroupChat(ctx({ messageChannel: "telegram", sessionKey: "yuanbao:group:g1" })), false);
  assert.equal(isYbGroupChat(ctx({ messageChannel: "yuanbao" })), false);
});

void test("resolveYuanbaoConversation resolves groups and every direct session-key shape", () => {
  assert.deepEqual(
    resolveYuanbaoConversation("agent:main:yuanbao:group:g1", "u1"),
    { isGroup: true, targetId: "g1" },
  );
  // Direct keys vary with the host dmScope; the trusted requester id is the target in
  // every shape, including the default main scope where the key carries no peer at all.
  for (const sessionKey of ["agent:main:yuanbao:direct:u1", "agent:main:main"]) {
    assert.deepEqual(
      resolveYuanbaoConversation(sessionKey, "U1"),
      { isGroup: false, targetId: "U1" },
      sessionKey,
    );
  }
  // No authenticated requester → no direct target; derived sessions never resolve.
  assert.equal(resolveYuanbaoConversation("agent:main:main", undefined), null);
  assert.equal(resolveYuanbaoConversation("agent:main:cron:job-1:run:r1", "u1"), null);
});

void test("extractGroupCode pulls the trailing group code", () => {
  assert.equal(extractGroupCode("agent:a:yuanbao:group:585003747"), "585003747");
  assert.equal(extractGroupCode("agent:a:yuanbao:user:u1"), "");
});

void test("text/json MCP response builders", () => {
  assert.deepEqual(text("hi"), { content: [{ type: "text", text: "hi" }] });
  const j = json({ a: 1 });
  assert.deepEqual(j.details, { a: 1 });
  assert.equal(j.content[0].text, JSON.stringify({ a: 1 }, null, 2));
});

void test("textDesensitization 短文本不脱敏", () => {
  assert.equal(textDesensitization("你好世界"), "你好世界");
  assert.equal(textDesensitization("hello"), "hello");
  assert.equal(textDesensitization("ab"), "ab");
});

void test("textDesensitization 长文本脱敏", () => {
  // Length > 5: keep first and last 2 chars
  const result = textDesensitization("这是一段测试文本");
  assert.equal(result, "这是***(4)***文本");

  const result2 = textDesensitization("abcdefgh");
  assert.equal(result2, "ab***(4)***gh");
});

void test("textDesensitization 边界长度（6 字符）", () => {
  const result = textDesensitization("abcdef");
  assert.equal(result, "ab***(2)***ef");
});

void test("msgBodyDesensitization 处理文本消息", () => {
  const result = msgBodyDesensitization([
    { msg_type: "TIMTextElem", msg_content: { text: "这是一段测试文本" } },
  ]);
  assert.equal(result, "[text:这是***(4)***文本]");
});

void test("msgBodyDesensitization 处理非文本消息", () => {
  const result = msgBodyDesensitization([
    { msg_type: "TIMImageElem", msg_content: { url: "https://example.com/img.png" } },
  ]);
  assert.equal(result, '[TIMImageElem:{"url":"https://example.com/img.png"}]');
});

void test("msgBodyDesensitization 处理混合消息", () => {
  const result = msgBodyDesensitization([
    { msg_type: "TIMTextElem", msg_content: { text: "hello" } },
    { msg_type: "TIMImageElem", msg_content: { url: "https://img.com/a.png" } },
  ]);
  assert.equal(result, '[text:hello][TIMImageElem:{"url":"https://img.com/a.png"}]');
});
