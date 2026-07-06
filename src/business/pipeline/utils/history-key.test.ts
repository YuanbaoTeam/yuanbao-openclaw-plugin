import assert from "node:assert/strict";
import test from "node:test";
import { deriveHistoryKey } from "./history-key.js";

void test("deriveHistoryKey: plain groupCode when no topicId", () => {
  assert.equal(deriveHistoryKey("g-1"), "g-1");
});

void test("deriveHistoryKey: undefined topicId behaves like missing arg", () => {
  assert.equal(deriveHistoryKey("g-1", undefined), "g-1");
});

void test("deriveHistoryKey: topicId appends :topic:<id> suffix", () => {
  assert.equal(deriveHistoryKey("g-1", "t-42"), "g-1:topic:t-42");
});

void test("deriveHistoryKey: different topicIds produce different keys", () => {
  const a = deriveHistoryKey("g-1", "t-1");
  const b = deriveHistoryKey("g-1", "t-2");
  assert.notEqual(a, b);
});

void test("deriveHistoryKey: empty-string topicId falls back to plain (truthy check)", () => {
  // Empty string is intentionally treated as "no topic" — parseTopicMeta only
  // returns non-empty strings anyway, but this locks in the behavior.
  assert.equal(deriveHistoryKey("g-1", ""), "g-1");
});
