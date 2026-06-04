/**
 * Unit tests for infra/reply-classify.ts — the off/self/all/first ordering
 * (POLICY-008 decision tree). Pure function, no mocks.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { classifyReplyMode } from "./reply-classify.js";

void test("no refMsgId → 'no' regardless of mode", () => {
  assert.equal(classifyReplyMode({ mode: "all", refMsgId: undefined }), "no");
  assert.equal(classifyReplyMode({ mode: "first", refMsgId: null }), "no");
  assert.equal(classifyReplyMode({ mode: "first", refMsgId: "" }), "no");
});

void test("mode 'off' → 'no' even with a refMsgId", () => {
  assert.equal(classifyReplyMode({ mode: "off", refMsgId: "m-1" }), "no");
});

void test("self-quote (refFromAccount === botYuanbaoUid) → 'no'", () => {
  assert.equal(
    classifyReplyMode({ mode: "all", refMsgId: "m-1", refFromAccount: "bot", botYuanbaoUid: "bot" }),
    "no",
  );
});

void test("self-quote guard skipped when uid missing or differs", () => {
  assert.equal(classifyReplyMode({ mode: "all", refMsgId: "m-1", refFromAccount: "bot", botYuanbaoUid: null }), "yes");
  assert.equal(classifyReplyMode({ mode: "all", refMsgId: "m-1", refFromAccount: "u-1", botYuanbaoUid: "bot" }), "yes");
});

void test("mode 'all' → 'yes'; mode 'first' → 'first'", () => {
  assert.equal(classifyReplyMode({ mode: "all", refMsgId: "m-1" }), "yes");
  assert.equal(classifyReplyMode({ mode: "first", refMsgId: "m-1" }), "first");
});
