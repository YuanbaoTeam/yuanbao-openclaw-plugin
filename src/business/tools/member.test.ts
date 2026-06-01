/**
 * Unit tests for tools/member.ts — query_session_members tool: guard paths and
 * the find / list_bots / list_all actions over a populated member cache.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginToolContext } from "../utils/utils.js";
import { getMember, removeMember } from "../../infra/cache/member.js";
import { registerMemberTools } from "./member.js";

type Tool = { execute: (id: string, p: Record<string, unknown>) => Promise<{ details?: { success?: boolean; msg?: string; members?: unknown[]; mentionHint?: string } }> } | null;
type Factory = (ctx: OpenClawPluginToolContext) => Tool;

function captureFactory(): Factory {
  let factory: Factory | undefined;
  const api = { registerTool: (f: Factory) => { factory = f; } } as unknown as OpenClawPluginApi;
  registerMemberTools(api);
  return factory!;
}

const ctx = (over: Record<string, unknown>) => over as unknown as OpenClawPluginToolContext;

/** Seed the session member cache (incl. userType for bot filtering). */
function seed(accountId: string, groupCode: string) {
  const m = getMember(accountId);
  m.session.upsertUser(groupCode, { userId: "u-1", nickName: "Alice", lastSeen: Date.now(), userType: 1 });
  m.session.upsertUser(groupCode, { userId: "bot-2", nickName: "YuanbaoBot", lastSeen: Date.now(), userType: 2 });
}

void test("factory returns null for non-yuanbao channels", () => {
  assert.equal(captureFactory()(ctx({ messageChannel: "slack" })), null);
});

void test("no group context → success:false", async () => {
  const tool = captureFactory()(ctx({ messageChannel: "yuanbao", sessionKey: "agent:a:yuanbao:user:u", agentAccountId: "acct-m0" }));
  const res = await tool!.execute("t", { action: "list_all", mention: false });
  assert.equal(res.details?.success, false);
});

void test("no members recorded → success:false", async () => {
  const tool = captureFactory()(ctx({ messageChannel: "yuanbao", sessionKey: "agent:a:yuanbao:group:m-empty", agentAccountId: "acct-m1" }));
  const res = await tool!.execute("t", { action: "list_all", mention: false });
  assert.equal(res.details?.success, false);
  assert.match(res.details!.msg!, /No members recorded/);
  removeMember("acct-m1");
});

void test("list_all returns all seeded members with a mention hint when asked", async () => {
  seed("acct-m2", "m-all");
  const tool = captureFactory()(ctx({ messageChannel: "yuanbao", sessionKey: "x:yuanbao:group:m-all", agentAccountId: "acct-m2" }));
  const res = await tool!.execute("t", { action: "list_all", mention: true });
  assert.equal(res.details?.success, true);
  assert.equal(res.details?.members?.length, 2);
  assert.ok(res.details?.mentionHint);
  removeMember("acct-m2");
});

void test("find matches by nickname; no match returns all with success:false", async () => {
  seed("acct-m3", "m-find");
  const tool = captureFactory()(ctx({ messageChannel: "yuanbao", sessionKey: "x:yuanbao:group:m-find", agentAccountId: "acct-m3" }));
  const hit = await tool!.execute("t", { action: "find", name: "alice", mention: false });
  assert.equal(hit.details?.success, true);
  assert.equal(hit.details?.members?.length, 1);
  const miss = await tool!.execute("t", { action: "find", name: "nobody", mention: false });
  assert.equal(miss.details?.success, false);
  assert.equal(miss.details?.members?.length, 2);
  removeMember("acct-m3");
});

void test("list_bots filters yuanbao/bot user types", async () => {
  seed("acct-m4", "m-bots");
  const tool = captureFactory()(ctx({ messageChannel: "yuanbao", sessionKey: "x:yuanbao:group:m-bots", agentAccountId: "acct-m4" }));
  const res = await tool!.execute("t", { action: "list_bots", mention: false });
  assert.equal(res.details?.success, true);
  assert.equal(res.details?.members?.length, 1); // only the userType=2 bot
  removeMember("acct-m4");
});
