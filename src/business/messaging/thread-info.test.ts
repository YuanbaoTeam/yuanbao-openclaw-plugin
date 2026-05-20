/**
 * Unit tests for thread-info.ts: parseThreadInfoFromCloudCustomData and formatThreadContext.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { parseThreadInfoFromCloudCustomData, formatThreadContext } from "./thread-info.js";

function makeRaw(threadInfo: unknown): string {
  return JSON.stringify({
    ext_map: {
      thread_info: JSON.stringify(threadInfo),
    },
  });
}

void test("parseThreadInfoFromCloudCustomData 解析有效话题信息", () => {
  const data = makeRaw({
    thread_conv_id: "group_abc",
    conv_type: 2,
    threads: [
      { thread_id: "thread_123", thread_title: "夸到拉大学测评" },
      { thread_id: "thread_456", thread_title: "校园生活讨论" },
    ],
  });

  const result = parseThreadInfoFromCloudCustomData(data);
  assert.ok(result);
  assert.equal(result.thread_conv_id, "group_abc");
  assert.equal(result.conv_type, 2);
  assert.equal(result.threads.length, 2);
  assert.equal(result.threads[0].thread_title, "夸到拉大学测评");
  assert.equal(result.threads[1].thread_id, "thread_456");
});

void test("parseThreadInfoFromCloudCustomData 空输入返回 undefined", () => {
  assert.equal(parseThreadInfoFromCloudCustomData(undefined), undefined);
  assert.equal(parseThreadInfoFromCloudCustomData(""), undefined);
});

void test("parseThreadInfoFromCloudCustomData 无 ext_map 返回 undefined", () => {
  assert.equal(parseThreadInfoFromCloudCustomData(JSON.stringify({})), undefined);
  assert.equal(parseThreadInfoFromCloudCustomData(JSON.stringify({ quote: {} })), undefined);
});

void test("parseThreadInfoFromCloudCustomData 无 thread_info 字段返回 undefined", () => {
  const data = JSON.stringify({ ext_map: {} });
  assert.equal(parseThreadInfoFromCloudCustomData(data), undefined);
});

void test("parseThreadInfoFromCloudCustomData thread_info 非法 JSON 返回 undefined", () => {
  const data = JSON.stringify({ ext_map: { thread_info: "{invalid json}" } });
  assert.equal(parseThreadInfoFromCloudCustomData(data), undefined);
});

void test("parseThreadInfoFromCloudCustomData 外层非法 JSON 返回 undefined", () => {
  assert.equal(parseThreadInfoFromCloudCustomData("{invalid json}"), undefined);
});

void test("parseThreadInfoFromCloudCustomData threads 为空数组返回 undefined", () => {
  const data = makeRaw({
    thread_conv_id: "group_abc",
    conv_type: 2,
    threads: [],
  });
  assert.equal(parseThreadInfoFromCloudCustomData(data), undefined);
});

void test("parseThreadInfoFromCloudCustomData 缺少 thread_conv_id 返回 undefined", () => {
  const data = makeRaw({
    conv_type: 2,
    threads: [{ thread_id: "t1", thread_title: "话题1" }],
  });
  assert.equal(parseThreadInfoFromCloudCustomData(data), undefined);
});

void test("formatThreadContext 格式化多个话题", () => {
  const result = formatThreadContext({
    thread_conv_id: "group_abc",
    conv_type: 2,
    threads: [
      { thread_id: "t1", thread_title: "夸到拉大学测评" },
      { thread_id: "t2", thread_title: "校园生活讨论" },
    ],
  });
  assert.ok(result.includes("[Current topics in this conversation]"));
  assert.ok(result.includes("夸到拉大学测评"));
  assert.ok(result.includes("校园生活讨论"));
});

void test("formatThreadContext 格式化单个话题", () => {
  const result = formatThreadContext({
    thread_conv_id: "group_abc",
    conv_type: 2,
    threads: [{ thread_id: "t1", thread_title: "技术讨论" }],
  });
  assert.ok(result.includes("> - 技术讨论"));
});

void test("formatThreadContext 话题标题全为空时返回空字符串", () => {
  const result = formatThreadContext({
    thread_conv_id: "group_abc",
    conv_type: 2,
    threads: [{ thread_id: "t1", thread_title: "" }],
  });
  assert.equal(result, "");
});
