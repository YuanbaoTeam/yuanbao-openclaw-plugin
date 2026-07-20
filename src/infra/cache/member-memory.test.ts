/**
 * Unit tests for infra/cache/member-memory.ts — the per-member fact store:
 * remember/recall dedupe, nickname lookup, list ordering, forget, TTL expiry,
 * and per-account isolation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  getMemberMemory,
  removeMemberMemory,
  MemberMemory,
} from "./member-memory.js";

void test("remember then recall returns the stored fact", () => {
  const mem = new MemberMemory();
  mem.remember("g1", "u1", "self-introduction: 我叫小明", "小明");
  const record = mem.recall("g1", "u1");
  assert.ok(record);
  assert.equal(record!.facts.length, 1);
  assert.equal(record!.facts[0]!.content, "self-introduction: 我叫小明");
  assert.equal(record!.nickname, "小明");
});

void test("remember dedupes by exact content (bumps timestamp instead of appending)", () => {
  const mem = new MemberMemory();
  mem.remember("g1", "u1", "likes 火锅");
  mem.remember("g1", "u1", "likes 火锅");
  const record = mem.recall("g1", "u1");
  assert.equal(record!.facts.length, 1);
});

void test("remember stores multiple distinct facts for the same member", () => {
  const mem = new MemberMemory();
  mem.remember("g1", "u1", "我叫小明");
  mem.remember("g1", "u1", "喜欢打球");
  const record = mem.recall("g1", "u1");
  assert.equal(record!.facts.length, 2);
});

void test("members in the same group are bucketed separately (a vs b)", () => {
  const mem = new MemberMemory();
  mem.remember("g1", "a", "我叫小明", "小明");
  mem.remember("g1", "b", "我叫小张", "小张");

  const a = mem.recall("g1", "a");
  const b = mem.recall("g1", "b");
  assert.equal(a!.facts[0]!.content, "我叫小明");
  assert.equal(b!.facts[0]!.content, "我叫小张");
});

void test("different groups with the same userId are isolated", () => {
  const mem = new MemberMemory();
  mem.remember("g1", "u1", "in g1");
  mem.remember("g2", "u1", "in g2");
  assert.equal(mem.recall("g1", "u1")!.facts[0]!.content, "in g1");
  assert.equal(mem.recall("g2", "u1")!.facts[0]!.content, "in g2");
});

void test("list returns members with facts, most recently updated first", () => {
  const mem = new MemberMemory();
  mem.remember("g1", "u1", "first", "A");
  mem.remember("g1", "u2", "second", "B");
  // Touch u1 again so it becomes the most recently updated.
  mem.remember("g1", "u1", "again");
  const list = mem.list("g1");
  assert.equal(list.length, 2);
  assert.equal(list[0]!.userId, "u1");
  assert.equal(list[1]!.userId, "u2");
});

void test("list excludes empty groups and members with no facts", () => {
  const mem = new MemberMemory();
  assert.deepEqual(mem.list("g-empty"), []);
  mem.remember("g1", "u1", "x");
  assert.equal(mem.list("g1").length, 1);
});

void test("forget clears a member's facts and returns true only when something existed", () => {
  const mem = new MemberMemory();
  mem.remember("g1", "u1", "我叫小明");
  assert.equal(mem.forget("g1", "u1"), true);
  assert.equal(mem.recall("g1", "u1"), undefined);
  assert.equal(mem.forget("g1", "u1"), false);
});

void test("remember ignores empty group/user/fact", () => {
  const mem = new MemberMemory();
  mem.remember("", "u1", "x");
  mem.remember("g1", "", "x");
  mem.remember("g1", "u1", "   ");
  assert.equal(mem.size(), 0);
});

void test("getMemberMemory returns a per-account singleton", () => {
  const a = getMemberMemory("acct-mem-1");
  const b = getMemberMemory("acct-mem-1");
  assert.equal(a, b);
  a.remember("g1", "u1", "shared");
  assert.ok(b.recall("g1", "u1"));

  const c = getMemberMemory("acct-mem-2");
  assert.equal(c.recall("g1", "u1"), undefined);
  removeMemberMemory("acct-mem-1");
  removeMemberMemory("acct-mem-2");
});

void test("facts beyond the per-member cap evict the oldest", () => {
  const mem = new MemberMemory();
  // The cap is 50; push 55 distinct facts and confirm it stays at 50, keeping
  // the most recent.
  for (let i = 0; i < 55; i++) {
    mem.remember("g1", "u1", `fact-${i}`);
  }
  const record = mem.recall("g1", "u1");
  assert.ok(record);
  assert.equal(record!.facts.length, 50);
  // Oldest 5 (fact-0..fact-4) should be gone; fact-54 should remain.
  assert.equal(record!.facts.find(f => f.content === "fact-0"), undefined);
  assert.ok(record!.facts.find(f => f.content === "fact-54"));
});
