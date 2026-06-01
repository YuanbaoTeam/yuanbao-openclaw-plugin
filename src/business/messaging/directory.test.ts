/**
 * Unit tests for messaging/directory.ts — username → userId resolution backed by
 * the member cache, plus listKnownPeers dedup. Each test uses a unique accountId
 * and unique names to avoid cross-test pollution of the module-level caches.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { listKnownPeers, resolveUsername } from "./directory.js";
import { getMember, removeMember } from "../../infra/cache/member.js";

void test("resolveUsername returns null for blank input", () => {
  assert.equal(resolveUsername("   ", "acct-blank"), null);
});

void test("resolveUsername resolves a recorded nickname to its userId, then hits cache", () => {
  const acct = "acct-dir-1";
  getMember(acct).recordUser("gdir-1", "uid-alice-1", "AliceUnique1");

  const first = resolveUsername("AliceUnique1", acct, "gdir-1");
  assert.ok(first);
  assert.equal(first!.userId, "uid-alice-1");

  // Second call is served from the directory cache (still correct).
  const second = resolveUsername("AliceUnique1", acct, "gdir-1");
  assert.equal(second!.userId, "uid-alice-1");

  removeMember(acct);
});

void test("resolveUsername searches all groups when no groupCode is given", () => {
  const acct = "acct-dir-2";
  getMember(acct).recordUser("gdir-2", "uid-bob-2", "BobUnique2");
  const r = resolveUsername("BobUnique2", acct);
  assert.ok(r);
  assert.equal(r!.userId, "uid-bob-2");
  removeMember(acct);
});

void test("resolveUsername returns null when the name is unknown", () => {
  const acct = "acct-dir-3";
  getMember(acct).recordUser("gdir-3", "uid-x", "SomeoneElse3");
  assert.equal(resolveUsername("NoSuchPerson3", acct, "gdir-3"), null);
  removeMember(acct);
});

void test("listKnownPeers dedups users across groups by userId", () => {
  const acct = "acct-dir-4";
  const m = getMember(acct);
  m.recordUser("g-a", "uid-shared-4", "SharedUser4");
  m.recordUser("g-b", "uid-shared-4", "SharedUser4"); // same user in another group
  m.recordUser("g-b", "uid-other-4", "OtherUser4");

  const peers = listKnownPeers(acct);
  const ids = peers.map(p => p.userId).sort();
  assert.deepEqual(ids, ["uid-other-4", "uid-shared-4"]);
  assert.ok(peers.every(p => p.kind === "user"));
  removeMember(acct);
});
