/**
 * Unit tests for quote.ts: parseQuoteFromCloudCustomData, resolveMediaQuoteDesc, formatQuoteContext.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { chatMediaHistories } from "./chat-history.js";
import { parseQuoteFromCloudCustomData, resolveMediaQuoteDesc, formatQuoteContext } from "./quote.js";

void test("parseQuoteFromCloudCustomData 解析有效引用", () => {
  const data = JSON.stringify({
    quote: {
      desc: "这是被引用的消息",
      sender_nickname: "张三",
      sender_id: "user-123",
    },
  });

  const result = parseQuoteFromCloudCustomData(data);
  assert.ok(result);
  assert.equal(result.desc, "这是被引用的消息");
  assert.equal(result.sender_nickname, "张三");
  assert.equal(result.sender_id, "user-123");
});

void test("parseQuoteFromCloudCustomData 空输入返回 undefined", () => {
  assert.equal(parseQuoteFromCloudCustomData(undefined), undefined);
  assert.equal(parseQuoteFromCloudCustomData(""), undefined);
});

void test("parseQuoteFromCloudCustomData 无 quote 字段返回 undefined", () => {
  assert.equal(parseQuoteFromCloudCustomData(JSON.stringify({})), undefined);
  assert.equal(parseQuoteFromCloudCustomData(JSON.stringify({ other: "data" })), undefined);
});

void test("parseQuoteFromCloudCustomData 空 desc 且非媒体类型返回 undefined", () => {
  const data = JSON.stringify({ quote: { desc: "", sender_id: "user-1" } });
  assert.equal(parseQuoteFromCloudCustomData(data), undefined);

  const data2 = JSON.stringify({ quote: { desc: "   ", sender_id: "user-1" } });
  assert.equal(parseQuoteFromCloudCustomData(data2), undefined);
});

void test("parseQuoteFromCloudCustomData 空 desc 的媒体类型引用不被丢弃且 desc 被兜底填充", () => {
  const expected: Record<number, string> = { 2: "[image]", 3: "[file]", 4: "[video]", 5: "[voice]" };
  for (const type of [2, 3, 4, 5]) {
    const data = JSON.stringify({ quote: { type, desc: "", sender_id: "user-1", id: "msg-1" } });
    const result = parseQuoteFromCloudCustomData(data);
    assert.ok(result, `type ${type} should not be dropped`);
    assert.equal(result.type, type);
    assert.equal(result.desc, expected[type], `type ${type} desc should be ${expected[type]}`);
  }
});

void test("parseQuoteFromCloudCustomData 有 desc 时保留原始 desc", () => {
  const data = JSON.stringify({
    quote: { type: 3, desc: "report.pdf", sender_id: "user-1" },
  });
  const result = parseQuoteFromCloudCustomData(data);
  assert.ok(result);
  assert.equal(result.desc, "report.pdf");
});

void test("parseQuoteFromCloudCustomData 非法 JSON 返回 undefined", () => {
  assert.equal(parseQuoteFromCloudCustomData("{invalid json}"), undefined);
});

// ---------------------------------------------------------------------------
// resolveMediaQuoteDesc
// ---------------------------------------------------------------------------

void test("resolveMediaQuoteDesc 从 LRU 获取多图文件名", () => {
  chatMediaHistories.set("test-session", [
    {
      sender: "u1", messageId: "msg-1", timestamp: Date.now(),
      medias: [
        { url: "https://a.com/1.jpg", mediaName: "a_720_1793.jpeg" },
        { url: "https://a.com/2.jpg", mediaName: "b_400_300.png" },
      ],
    },
  ]);
  const result = resolveMediaQuoteDesc(2, "msg-1", "test-session");
  assert.equal(result, "[image:a_720_1793.jpeg][image:b_400_300.png]");
  chatMediaHistories.delete("test-session");
});

void test("resolveMediaQuoteDesc LRU 无数据时降级为通用标签", () => {
  assert.equal(resolveMediaQuoteDesc(2, "nonexistent", "empty-session"), "[image]");
  assert.equal(resolveMediaQuoteDesc(3, undefined, "any"), "[file]");
  assert.equal(resolveMediaQuoteDesc(4, "x", "y"), "[video]");
  assert.equal(resolveMediaQuoteDesc(5, "x", "y"), "[voice]");
});

void test("resolveMediaQuoteDesc 未知类型返回 [media] 兜底", () => {
  assert.equal(resolveMediaQuoteDesc(99, "msg-1", "session"), "[media]");
});

void test("parseQuoteFromCloudCustomData chatKey=undefined 时媒体引用 desc 兜底到 [label]", () => {
  const data = JSON.stringify({ quote: { type: 2, desc: "", sender_id: "user-1", id: "msg-1" } });
  const result = parseQuoteFromCloudCustomData(data, undefined);
  assert.ok(result);
  assert.equal(result.desc, "[image]");
});

// ---------------------------------------------------------------------------
// formatQuoteContext
// ---------------------------------------------------------------------------

void test("formatQuoteContext 格式化引用消息", () => {
  const result = formatQuoteContext({
    desc: "被引用的消息内容",
    sender_nickname: "张三",
  });
  assert.ok(result.includes("[Quoted message from 张三]"));
  assert.ok(result.includes("被引用的消息内容"));
});

void test("formatQuoteContext 使用 sender_id 当 nickname 缺失", () => {
  const result = formatQuoteContext({
    desc: "消息内容",
    sender_id: "user-456",
  });
  assert.ok(result.includes("from user-456"));
});

void test("formatQuoteContext 无发送者信息", () => {
  const result = formatQuoteContext({ desc: "消息内容" });
  assert.ok(result.includes("[Quoted message]"));
  assert.ok(!result.includes("from"));
});

void test("formatQuoteContext 超长引用截断", () => {
  const longDesc = "A".repeat(600);
  const result = formatQuoteContext({ desc: longDesc });
  assert.ok(result.includes("...(truncated)"));
  // Truncated result should not contain the full 600 characters
  assert.ok(result.length < 600);
});
