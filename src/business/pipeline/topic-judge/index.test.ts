/**
 * Unit tests for topic-judge/index.ts: shouldBotReplyInTopic.
 *
 * Covers the four scenarios called out in the plan (hit / miss / no soul /
 * broken soul) plus a few boundary cases: prefix vs. substring, mixed
 * English/Chinese commas, invalid regex tolerance, and the "rules section
 * exists but is empty" edge.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { shouldBotReplyInTopic } from "./index.js";

const soulWithRules = `# Bot Soul

## Persona
Friendly assistant.

## Reply Rules
- keyword: 报名, 参加, 帮我
- prefix: bot, 助手
- regex: /打卡|签到/

## Other
Ignored.
`;

void test("shouldBotReplyInTopic 命中 keyword", async () => {
  const r = await shouldBotReplyInTopic({
    topicId: "t1",
    rawBody: "我想报名活动",
    soul: soulWithRules,
  });
  assert.equal(r.shouldReply, true);
  assert.match(r.reason, /keyword:报名/);
});

void test("shouldBotReplyInTopic 命中 prefix（大小写不敏感 + 前导空格容忍）", async () => {
  const r = await shouldBotReplyInTopic({
    topicId: "t1",
    rawBody: "  Bot 帮个忙",
    soul: soulWithRules,
  });
  assert.equal(r.shouldReply, true);
  assert.match(r.reason, /prefix:bot/i);
});

void test("shouldBotReplyInTopic 命中 regex", async () => {
  const r = await shouldBotReplyInTopic({
    topicId: "t1",
    rawBody: "今天打卡了",
    soul: soulWithRules,
  });
  assert.equal(r.shouldReply, true);
  assert.match(r.reason, /regex:/);
});

void test("shouldBotReplyInTopic 未命中任何规则 → 不回", async () => {
  const r = await shouldBotReplyInTopic({
    topicId: "t1",
    rawBody: "今天天气不错",
    soul: soulWithRules,
  });
  assert.equal(r.shouldReply, false);
  assert.equal(r.reason, "no rule matched");
});

void test("shouldBotReplyInTopic 无 soul 内容 → no soul rules", async () => {
  const r = await shouldBotReplyInTopic({ topicId: "t1", rawBody: "帮我", soul: "" });
  assert.equal(r.shouldReply, false);
  assert.equal(r.reason, "no soul rules");
});

void test("shouldBotReplyInTopic soul 有内容但无 Reply Rules 段 → no soul rules", async () => {
  const soul = `# Persona\nJust a persona, no rules section here.`;
  const r = await shouldBotReplyInTopic({ topicId: "t1", rawBody: "报名", soul });
  assert.equal(r.shouldReply, false);
  assert.equal(r.reason, "no soul rules");
});

void test("shouldBotReplyInTopic Reply Rules 段为空 → no soul rules", async () => {
  const soul = `## Reply Rules\n\n## Next Section\nstuff`;
  const r = await shouldBotReplyInTopic({ topicId: "t1", rawBody: "报名", soul });
  assert.equal(r.shouldReply, false);
  assert.equal(r.reason, "no soul rules");
});

void test("shouldBotReplyInTopic 损坏的 regex 不影响其他规则", async () => {
  const soul = `## Reply Rules
- regex: [unterminated
- keyword: 打卡
`;
  const warned: unknown[] = [];
  const r = await shouldBotReplyInTopic({
    topicId: "t1",
    rawBody: "今天打卡完成",
    soul,
    log: {
      info: () => {},
      warn: (_msg, data) => warned.push(data),
      error: () => {},
      debug: () => {},
    },
  });
  assert.equal(r.shouldReply, true);
  assert.match(r.reason, /keyword:打卡/);
  assert.equal(warned.length, 1);
});

void test("shouldBotReplyInTopic 中文全角逗号也能拆分", async () => {
  const soul = `## Reply Rules\n- keyword: 报名，参加\n`;
  const r = await shouldBotReplyInTopic({ topicId: "t1", rawBody: "我要参加", soul });
  assert.equal(r.shouldReply, true);
  assert.match(r.reason, /keyword:参加/);
});

void test("shouldBotReplyInTopic prefix 只匹配开头，不匹配中间", async () => {
  const soul = `## Reply Rules\n- prefix: bot\n`;
  const r = await shouldBotReplyInTopic({
    topicId: "t1",
    rawBody: "hey bot are you there",
    soul,
  });
  assert.equal(r.shouldReply, false);
});

void test("shouldBotReplyInTopic 完全损坏的 soul 也不抛错", async () => {
  // 用一段完全不像 markdown 的乱码 —— 应该走 "no soul rules" 分支
  const r = await shouldBotReplyInTopic({
    topicId: "t1",
    rawBody: "报名",
    soul: "\x00\x01\x02 not a markdown 🎉🎉🎉",
  });
  assert.equal(r.shouldReply, false);
  assert.equal(r.reason, "no soul rules");
});
