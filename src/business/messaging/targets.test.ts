/**
 * targets.ts unit tests.
 *
 * Test scope: looksLikeYuanbaoId, parseTarget
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildMessageToolHints, looksLikeYuanbaoId, normalizeTarget, parseTarget } from "./targets.js";

void test("normalizeTarget strips the yuanbao: prefix and trims, undefined for empty", () => {
  assert.equal(normalizeTarget("  yuanbao:123  "), "123");
  assert.equal(normalizeTarget("YUANBAO:abc"), "abc");
  assert.equal(normalizeTarget("plain"), "plain");
  assert.equal(normalizeTarget("   "), undefined);
});

void test("buildMessageToolHints returns the agent prompt hint lines", () => {
  const hints = buildMessageToolHints();
  assert.ok(Array.isArray(hints));
  assert.ok(hints.length >= 1);
  assert.ok(hints.some(h => h.includes("sticker")));
  assert.ok(hints.some(h => h.includes("Visual-first in Yuanbao") && h.includes("categorized recommendation") && h.includes("3+ structured items") && h.includes("MUST use an A2UI xCard")));
  assert.ok(hints.some(h => h.includes("xCard trigger examples") && h.includes("有哪些") && h.includes("travel spots") && h.includes("do not answer as plain Markdown bullets")));
  assert.ok(hints.some(h => h.includes("to visualize the answer") && h.includes("embed exactly one raw <a2ui>...</a2ui>") && h.includes("Plain prose may appear before/after") && h.includes("never wrap")));
  assert.ok(hints.some(h => h.includes("Express quick syntax") && h.includes("not JSON") && h.includes("_template($/items,item)")));
  assert.ok(hints.some(h => h.includes("xCard few-shot") && h.includes("西安有哪些景点") && h.includes("<a2ui>") && h.includes("Do not output the same content as Markdown bullets")));
  assert.ok(hints.some(h => h.includes("root is required") && h.includes("Text.variant only") && h.includes("xcard-generator")));
  assert.ok(hints.some(h => h.includes("invented type/items schemas") && h.includes("ListItem") && h.includes("Checkbox") && h.includes("body2")));
  assert.ok(hints.some(h => h.includes("yuanbao_xcard_send/update") && h.includes("yuanbao_xcard_template")));
  assert.ok(hints.some(h => h.includes(".json/.jsonl")));
  assert.ok(hints.some(h => h.includes("createSurface") && h.includes("components")));
});

void test("looksLikeYuanbaoId recognizes valid Base64 format IDs", () => {
  // Length >= 16, length is multiple of 4, Base64 charset only
  assert.equal(looksLikeYuanbaoId("YWJjZGVmZ2hpamts"), true);
  assert.equal(looksLikeYuanbaoId("YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4"), true);
  assert.equal(looksLikeYuanbaoId("Ab1Cd2Ef3Gh4Ij5K"), true);
});

void test("looksLikeYuanbaoId rejects invalid IDs", () => {
  // Too short
  assert.equal(looksLikeYuanbaoId("abc123"), false);
  assert.equal(looksLikeYuanbaoId(""), false);

  // Length not multiple of 4
  assert.equal(looksLikeYuanbaoId("abcdefghijklmnopq"), false);

  // Contains illegal characters
  assert.equal(looksLikeYuanbaoId("ABCDEFghijklmn!@"), false);
});

void test("parseTarget parses group chat target", () => {
  const result = parseTarget("group:test-group-123");
  assert.equal(result.target, "test-group-123");
  assert.equal(result.sessionKey, "group:test-group-123");
});

void test("parseTarget parses C2C target", () => {
  // Valid Base64 format ID (length 16, multiple of 4)
  const validId = "YWJjZGVmZ2hpamts";
  const result = parseTarget(validId);
  assert.equal(result.target, validId);
  assert.equal(result.sessionKey, `direct:${validId}`);
});

void test("parseTarget removes yuanbao: prefix", () => {
  const result = parseTarget("yuanbao:group:my-group");
  assert.equal(result.target, "my-group");
});

void test("parseTarget removes user: and direct: prefixes", () => {
  const validId = "YWJjZGVmZ2hpamts";
  const result1 = parseTarget(`user:${validId}`);
  assert.equal(result1.target, validId);

  const result2 = parseTarget(`direct:${validId}`);
  assert.equal(result2.target, validId);
});
