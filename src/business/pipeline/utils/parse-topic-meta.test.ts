/**
 * Unit tests for parse-topic-meta.ts: parseTopicMeta.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseTopicMeta } from "./parse-topic-meta.js";

void test("parseTopicMeta 解析完整字段", () => {
  const data = JSON.stringify({ topicId: "topic-abc", botMuted: true });
  assert.deepEqual(parseTopicMeta(data), { topicId: "topic-abc", botMuted: true });
});

void test("parseTopicMeta 只有 topicId", () => {
  const data = JSON.stringify({ topicId: "topic-1" });
  assert.deepEqual(parseTopicMeta(data), { topicId: "topic-1" });
});

void test("parseTopicMeta 只有 botMuted=false", () => {
  const data = JSON.stringify({ botMuted: false });
  assert.deepEqual(parseTopicMeta(data), { botMuted: false });
});

void test("parseTopicMeta 空输入返回 {}", () => {
  assert.deepEqual(parseTopicMeta(undefined), {});
  assert.deepEqual(parseTopicMeta(""), {});
});

void test("parseTopicMeta JSON 损坏返回 {}", () => {
  assert.deepEqual(parseTopicMeta("{not-json"), {});
  assert.deepEqual(parseTopicMeta("null"), {});
});

void test("parseTopicMeta 字段类型不合法时忽略该字段", () => {
  // topicId 空串 / 非字符串 → 丢弃
  assert.deepEqual(parseTopicMeta(JSON.stringify({ topicId: "" })), {});
  assert.deepEqual(parseTopicMeta(JSON.stringify({ topicId: 123 })), {});
  // botMuted 非布尔 → 丢弃
  assert.deepEqual(parseTopicMeta(JSON.stringify({ botMuted: "true" })), {});
  assert.deepEqual(parseTopicMeta(JSON.stringify({ botMuted: 1 })), {});
});

void test("parseTopicMeta 忽略无关字段", () => {
  const data = JSON.stringify({
    topicId: "topic-x",
    env: "prod",
    quote: { desc: "irrelevant" },
    source_group: "g1",
  });
  assert.deepEqual(parseTopicMeta(data), { topicId: "topic-x" });
});
