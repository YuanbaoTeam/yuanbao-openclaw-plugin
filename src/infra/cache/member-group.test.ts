/**
 * Unit tests for the GroupMember (WS API) layer of infra/cache/member.ts:
 * getMembers (fetch + cache + SessionMember sync), queryGroupInfo / queryGroupOwner,
 * queryYuanbaoUserId, and the not-connected / error fallbacks.
 *
 * A fake WS client is injected via setActiveWsClient.
 */

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { getMember, removeMember } from "./member.js";
import { setActiveWsClient } from "../../access/ws/runtime.js";
import type { YuanbaoWsClient } from "../../access/ws/client.js";

function fakeWs(opts: {
  connected?: boolean;
  members?: Array<{ user_id: string; nick_name: string; user_type?: number }>;
  memberCode?: number;
  groupInfo?: Record<string, unknown> | null;
} = {}) {
  return {
    getState: () => (opts.connected === false ? "disconnected" : "connected"),
    getGroupMemberList: async () => ({ code: opts.memberCode ?? 0, message: "", member_list: opts.members ?? [] }),
    queryGroupInfo: async () => ({ code: 0, msg: "", group_info: opts.groupInfo === undefined
      ? { group_name: "G", group_owner_user_id: "owner-1", group_owner_nickname: "Owner", group_size: 3 }
      : opts.groupInfo }),
  } as unknown as YuanbaoWsClient;
}

const accounts: string[] = [];
function acct(ws: YuanbaoWsClient): string {
  const id = `mg-${accounts.length}-${Math.random().toString(36).slice(2)}`;
  accounts.push(id);
  setActiveWsClient(id, ws);
  return id;
}

afterEach(() => {
  for (const id of accounts) { setActiveWsClient(id, null); removeMember(id); }
  accounts.length = 0;
});

void test("getMembers fetches from API, caches, and syncs to SessionMember", async () => {
  const id = acct(fakeWs({ members: [{ user_id: "u-1", nick_name: "Alice", user_type: 1 }] }));
  const m = getMember(id);
  const first = await m.group.getMembers("g-1");
  assert.equal(first.length, 1);
  assert.equal(first[0].nickName, "Alice");
  assert.equal(m.group.hasCachedData("g-1"), true);
  // synced into session layer
  assert.equal(m.session.lookupUserById("g-1", "u-1")?.nickName, "Alice");
});

void test("getMembers returns [] when wsClient is not connected", async () => {
  const id = acct(fakeWs({ connected: false }));
  assert.deepEqual(await getMember(id).group.getMembers("g-1"), []);
});

void test("getMembers returns [] on a non-zero API code", async () => {
  const id = acct(fakeWs({ memberCode: 500 }));
  assert.deepEqual(await getMember(id).group.getMembers("g-1"), []);
});

void test("getMembers returns [] when there is no active wsClient", async () => {
  const id = `mg-nows-${Math.random().toString(36).slice(2)}`;
  accounts.push(id); // ensure cleanup
  assert.deepEqual(await getMember(id).group.getMembers("g-1"), []);
});

void test("queryGroupInfo maps the response into GroupInfoData and caches it", async () => {
  const id = acct(fakeWs());
  const info = await getMember(id).queryGroupInfo("g-1");
  assert.equal(info?.groupName, "G");
  assert.equal(info?.ownerUserId, "owner-1");
  assert.equal(info?.groupSize, 3);
});

void test("queryGroupOwner returns the owner info", async () => {
  const id = acct(fakeWs());
  const owner = await getMember(id).queryGroupOwner("g-1");
  assert.equal(owner?.userId, "owner-1");
  assert.equal(owner?.nickName, "Owner");
});

void test("queryYuanbaoUserId finds the userType=2 member", async () => {
  const id = acct(fakeWs({ members: [
    { user_id: "u-1", nick_name: "Alice", user_type: 1 },
    { user_id: "yb-1", nick_name: "Yuanbao", user_type: 2 },
  ] }));
  const uid = await getMember(id).queryYuanbaoUserId("g-1");
  assert.equal(uid, "yb-1");
});

void test("getMembers second call hits the cache (no second fetch)", async () => {
  let fetches = 0;
  const ws = {
    getState: () => "connected",
    getGroupMemberList: async () => { fetches++; return { code: 0, message: "", member_list: [{ user_id: "u", nick_name: "N", user_type: 1 }] }; },
  } as unknown as YuanbaoWsClient;
  const id = acct(ws);
  await getMember(id).group.getMembers("g-1");
  await getMember(id).group.getMembers("g-1");
  assert.equal(fetches, 1);
});

void test("queryGroupInfo / queryGroupOwner return null when not connected", async () => {
  const id = acct(fakeWs({ connected: false }));
  assert.equal(await getMember(id).queryGroupInfo("g-1"), null);
  assert.equal(await getMember(id).queryGroupOwner("g-1"), null);
});

void test("queryYuanbaoUserId returns null with no groupCode and no cache", async () => {
  const id = acct(fakeWs());
  assert.equal(await getMember(id).queryYuanbaoUserId(), null);
});

void test("queryYuanbaoUserId returns null when no yuanbao/bot member exists", async () => {
  const id = acct(fakeWs({ members: [{ user_id: "u-1", nick_name: "Alice", user_type: 1 }] }));
  assert.equal(await getMember(id).queryYuanbaoUserId("g-1"), null);
});

void test("queryYuanbaoUserId caches the resolved uid (second call no groupCode)", async () => {
  const id = acct(fakeWs({ members: [{ user_id: "yb", nick_name: "Y", user_type: 2 }] }));
  const m = getMember(id);
  assert.equal(await m.queryYuanbaoUserId("g-1"), "yb");
  assert.equal(await m.queryYuanbaoUserId(), "yb"); // cached, no groupCode needed
});
