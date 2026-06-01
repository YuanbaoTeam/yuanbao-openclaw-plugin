/**
 * Unit tests for messaging/mention.ts — target-mention extraction (custom elem
 * + text regex) and implicit-mention detection. All pure functions.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { detectImplicitMention, extractTargetMentions, extractTargetMentionsFromText } from "./mention.js";
import type { YuanbaoMsgBodyElement } from "../../types.js";

function customMention(userId: string, text: string): YuanbaoMsgBodyElement {
  return { msg_type: "TIMCustomElem", msg_content: { data: JSON.stringify({ elem_type: 1002, user_id: userId, text }) } };
}

void test("extractTargetMentions parses TIMCustomElem 1002 mentions, excluding the bot", () => {
  const body = [customMention("u-1", "@Alice"), customMention("bot-1", "@Bot")];
  const r = extractTargetMentions(body, { botId: "bot-1" });
  assert.equal(r.length, 1);
  assert.equal(r[0].platformId, "u-1");
  assert.equal(r[0].displayName, "Alice");
});

void test("extractTargetMentions ignores non-custom elems and malformed json", () => {
  const body: YuanbaoMsgBodyElement[] = [
    { msg_type: "TIMTextElem", msg_content: { text: "hi" } },
    { msg_type: "TIMCustomElem", msg_content: { data: "not-json" } },
    { msg_type: "TIMCustomElem", msg_content: { data: JSON.stringify({ elem_type: 999 }) } },
  ];
  assert.deepEqual(extractTargetMentions(body, {}), []);
  assert.deepEqual(extractTargetMentions(undefined, {}), []);
});

void test("extractTargetMentionsFromText extracts handles and skips the bot", () => {
  const r = extractTargetMentionsFromText("hi @alice and @bot", { botUsername: "bot" });
  assert.equal(r.length, 1);
  assert.equal(r[0].displayName, "alice");
});

void test("detectImplicitMention: reply to bot in group is implicit mention", () => {
  assert.equal(detectImplicitMention("bot-1", "bot-1", false), true);
  assert.equal(detectImplicitMention("u-1", "bot-1", false), false);
  assert.equal(detectImplicitMention("bot-1", "bot-1", true), false); // DM never implicit
  assert.equal(detectImplicitMention(undefined, "bot-1", false), false);
});
