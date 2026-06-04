/**
 * Unit tests for messaging/chat-history.ts — chat-key derivation and the media
 * history LRU (skip-empty, append, eviction over capacity).
 */

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { chatMediaHistories, deriveChatKey, recordMediaHistory } from "./chat-history.js";

afterEach(() => chatMediaHistories.clear());

void test("deriveChatKey formats group vs direct keys", () => {
  assert.equal(deriveChatKey(true, "g-1"), "group:g-1");
  assert.equal(deriveChatKey(false, undefined, "u-1"), "direct:u-1");
  assert.equal(deriveChatKey(false), "direct:unknown");
  assert.equal(deriveChatKey(true, undefined, "u-1"), "direct:u-1"); // group flag but no code → direct
});

void test("recordMediaHistory skips entries with no media", () => {
  recordMediaHistory("group:g-1", { sender: "u", timestamp: 1, medias: [] });
  assert.equal(chatMediaHistories.has("group:g-1"), false);
});

void test("recordMediaHistory appends entries", () => {
  recordMediaHistory("group:g-1", { sender: "u", timestamp: 1, medias: [{ url: "http://a" }] });
  recordMediaHistory("group:g-1", { sender: "u", timestamp: 2, medias: [{ url: "http://b" }] });
  assert.equal(chatMediaHistories.get("group:g-1")!.length, 2);
});

void test("recordMediaHistory evicts oldest beyond the per-chat cap (50)", () => {
  for (let i = 0; i < 55; i++) {
    recordMediaHistory("group:g-1", { sender: "u", timestamp: i, medias: [{ url: `http://${i}` }] });
  }
  const list = chatMediaHistories.get("group:g-1")!;
  assert.equal(list.length, 50);
  assert.equal(list[0].timestamp, 5); // first 5 evicted
});
