/**
 * Unit tests for infra/cache/member-memory.ts — per-member fact store:
 * remember/recall/list/forget, dedup, capacity cap, and per-account/group/user
 * isolation. TTL expiry (7-day `cleanExpired`) is not fast-forwarded here.
 */

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { getMemberMemory, removeMemberMemory } from "./member-memory.js";

/** Unique account id per test for singleton isolation. */
const accounts: string[] = [];
function acct(): string {
  const id = `mm-${accounts.length}-${Math.random().toString(36).slice(2)}`;
  accounts.push(id);
  return id;
}

afterEach(() => {
  for (const id of accounts) removeMemberMemory(id);
  accounts.length = 0;
});

void test("remember then recall returns the fact under the same user", () => {
  const id = acct();
  const m = getMemberMemory(id);
  m.remember("g-1", "u-a", "我叫小明");
  const rec = m.recall("g-1", "u-a");
  assert.equal(rec?.facts.length, 1);
  assert.equal(rec?.facts[0]?.content, "我叫小明");
});

void test("recall returns undefined when nothing stored for the user", () => {
  const id = acct();
  const m = getMemberMemory(id);
  assert.equal(m.recall("g-1", "u-empty"), undefined);
});

void test("remember dedupes on exact content (bumps timestamp, no duplicate)", () => {
  const id = acct();
  const m = getMemberMemory(id);
  m.remember("g-1", "u-a", "dup");
  m.remember("g-1", "u-a", "dup");
  const rec = m.recall("g-1", "u-a");
  assert.equal(rec?.facts.length, 1);
});

void test("two members in the same group are isolated (no cross-contamination)", () => {
  const id = acct();
  const m = getMemberMemory(id);
  m.remember("g-1", "u-a", "我叫小明");
  m.remember("g-1", "u-b", "我叫小张");
  assert.equal(m.recall("g-1", "u-a")?.facts[0]?.content, "我叫小明");
  assert.equal(m.recall("g-1", "u-b")?.facts[0]?.content, "我叫小张");
});

void test("same userId in different groups is isolated", () => {
  const id = acct();
  const m = getMemberMemory(id);
  m.remember("g-1", "u-a", "in-g1");
  m.remember("g-2", "u-a", "in-g2");
  assert.equal(m.recall("g-1", "u-a")?.facts[0]?.content, "in-g1");
  assert.equal(m.recall("g-2", "u-a")?.facts[0]?.content, "in-g2");
});

void test("list returns members with stored facts, excluding empty buckets", () => {
  const id = acct();
  const m = getMemberMemory(id);
  m.remember("g-1", "u-a", "a-fact");
  m.remember("g-1", "u-b", "b-fact");
  // touch u-b again so it carries 2 facts
  m.remember("g-1", "u-b", "b-fact-2");
  const list = m.list("g-1");
  assert.equal(list.length, 2);
  // Order is driven by updatedAt; same-millisecond writes make it
  // non-deterministic, so assert membership + fact counts instead.
  const byId = new Map(list.map(r => [r.userId, r] as const));
  assert.equal(byId.get("u-a")?.facts.length, 1);
  assert.equal(byId.get("u-b")?.facts.length, 2);
});

void test("list returns [] for a group with no records", () => {
  const id = acct();
  assert.deepEqual(getMemberMemory(id).list("g-empty"), []);
});

void test("forget clears a member's facts and returns true; false when absent", () => {
  const id = acct();
  const m = getMemberMemory(id);
  m.remember("g-1", "u-a", "fact");
  assert.equal(m.forget("g-1", "u-a"), true);
  assert.equal(m.recall("g-1", "u-a"), undefined);
  // already cleared
  assert.equal(m.forget("g-1", "u-a"), false);
  // unknown group
  assert.equal(m.forget("g-nope", "u-a"), false);
});

void test("nickname is stored and refreshed on subsequent remember calls", () => {
  const id = acct();
  const m = getMemberMemory(id);
  m.remember("g-1", "u-a", "fact-1", "Alice");
  m.remember("g-1", "u-a", "fact-2", "Alice2");
  const rec = m.recall("g-1", "u-a");
  assert.equal(rec?.nickname, "Alice2");
  assert.equal(rec?.facts.length, 2);
});

void test("empty/whitespace fact is ignored", () => {
  const id = acct();
  const m = getMemberMemory(id);
  m.remember("g-1", "u-a", "   ");
  m.remember("g-1", "u-a", "");
  assert.equal(m.recall("g-1", "u-a"), undefined);
});

void test("missing groupCode/userId is a no-op", () => {
  const id = acct();
  const m = getMemberMemory(id);
  m.remember("", "u-a", "fact");
  m.remember("g-1", "", "fact");
  assert.equal(m.size(), 0);
});

void test("capacity cap evicts oldest beyond 50 facts per member", () => {
  const id = acct();
  const m = getMemberMemory(id);
  for (let i = 0; i < 51; i++) {
    m.remember("g-1", "u-a", `fact-${i}`);
  }
  const rec = m.recall("g-1", "u-a");
  assert.equal(rec?.facts.length, 50);
  // oldest (fact-0) evicted, fact-50 retained
  assert.equal(rec?.facts.find(f => f.content === "fact-0"), undefined);
  assert.ok(rec?.facts.find(f => f.content === "fact-50"));
});

void test("getMemberMemory returns a per-account singleton", () => {
  const id = acct();
  const a = getMemberMemory(id);
  const b = getMemberMemory(id);
  assert.equal(a, b);
});

void test("removeMemberMemory drops the account's instance", () => {
  const id = acct();
  const before = getMemberMemory(id);
  removeMemberMemory(id);
  const after = getMemberMemory(id);
  assert.notEqual(before, after);
});

void test("size counts members across all groups", () => {
  const id = acct();
  const m = getMemberMemory(id);
  m.remember("g-1", "u-a", "f");
  m.remember("g-1", "u-b", "f");
  m.remember("g-2", "u-c", "f");
  assert.equal(m.size(), 3);
});
