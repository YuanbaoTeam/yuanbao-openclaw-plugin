/**
 * Unit tests for tools/member-memory.ts — the member_memory tool: factory guard,
 * default-to-current-sender behavior, nickname resolution, and the
 * remember/recall/list/forget actions. Includes the core regression for the
 * "在派中的 bot 不记人" bug: two members each self-introduce, then each asks
 * their own name back.
 */

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginToolContext } from "../utils/utils.js";
import { getMember } from "../../infra/cache/member.js";
import { removeMemberMemory } from "../../infra/cache/member-memory.js";
import { registerMemberMemoryTools } from "./member-memory.js";

type Details = {
  success?: boolean;
  msg?: string;
  userId?: string;
  nickname?: string;
  facts?: Array<{ content: string; updatedAt: string }>;
  members?: Array<{ userId: string; nickname?: string; factCount: number }>;
};
type Tool = { execute: (id: string, p: Record<string, unknown>) => Promise<{ details?: Details }> } | null;
type Factory = (ctx: OpenClawPluginToolContext) => Tool;

function captureFactory(): Factory {
  let factory: Factory | undefined;
  const api = { registerTool: (f: Factory) => { factory = f; } } as unknown as OpenClawPluginApi;
  registerMemberMemoryTools(api);
  return factory!;
}

const ctx = (over: Record<string, unknown>) => over as unknown as OpenClawPluginToolContext;

/** Common yuanbao group session context for the current sender. */
const groupCtx = (senderId: string, accountId: string, groupCode = "g-tool") =>
  ctx({
    messageChannel: "yuanbao",
    sessionKey: `agent:a:yuanbao:group:${groupCode}`,
    agentAccountId: accountId,
    requesterSenderId: senderId,
  });

afterEach(() => {
  removeMemberMemory("acct-mm");
  removeMemberMemory("acct-mm2");
});

void test("factory returns null for non-yuanbao channels", () => {
  assert.equal(captureFactory()(ctx({ messageChannel: "slack" })), null);
});

void test("no group context -> success:false", async () => {
  const tool = captureFactory()(ctx({ messageChannel: "yuanbao", sessionKey: "agent:a:yuanbao:user:u", agentAccountId: "acct-mm", requesterSenderId: "u" }));
  const res = await tool!.execute("t", { action: "list" });
  assert.equal(res.details?.success, false);
  assert.match(res.details!.msg!, /No group context/);
});

void test("remember requires a non-empty fact", async () => {
  const tool = captureFactory()(groupCtx("u1", "acct-mm"));
  const res = await tool!.execute("t", { action: "remember", fact: "   " });
  assert.equal(res.details?.success, false);
  assert.match(res.details!.msg!, /requires a non-empty `fact`/);
});

void test("remember defaults to the current sender and recall returns it", async () => {
  const tool = captureFactory()(groupCtx("u1", "acct-mm"));
  const rem = await tool!.execute("t", { action: "remember", fact: "我叫小明" });
  assert.equal(rem.details?.success, true);
  assert.equal(rem.details?.userId, "u1");

  const rec = await tool!.execute("t", { action: "recall" });
  assert.equal(rec.details?.success, true);
  assert.equal(rec.details?.userId, "u1");
  assert.equal(rec.details?.facts?.length, 1);
  assert.equal(rec.details?.facts?.[0]?.content, "我叫小明");
});

void test("core regression: a and b each self-introduce, then each recalls their own name", async () => {
  // a @bot "我叫小明"
  const toolA = captureFactory()(groupCtx("a", "acct-mm"));
  await toolA!.execute("t", { action: "remember", fact: "我叫小明" });

  // b @bot "我叫小张" — same shared group session, different current sender
  const toolB = captureFactory()(groupCtx("b", "acct-mm"));
  await toolB!.execute("t", { action: "remember", fact: "我叫小张" });

  // a asks "我叫什么" -> should recall 小明, not 小张
  const aRecall = await toolA!.execute("t", { action: "recall" });
  assert.equal(aRecall.details?.success, true);
  assert.equal(aRecall.details?.userId, "a");
  assert.equal(aRecall.details?.facts?.[0]?.content, "我叫小明");

  // b asks -> should recall 小张
  const bRecall = await toolB!.execute("t", { action: "recall" });
  assert.equal(bRecall.details?.success, true);
  assert.equal(bRecall.details?.userId, "b");
  assert.equal(bRecall.details?.facts?.[0]?.content, "我叫小张");
});

void test("recall with no stored memory reports success:false", async () => {
  const tool = captureFactory()(groupCtx("u-new", "acct-mm"));
  const res = await tool!.execute("t", { action: "recall" });
  assert.equal(res.details?.success, false);
  assert.deepEqual(res.details?.facts, []);
});

void test("remember targeting another member by explicit userId", async () => {
  const tool = captureFactory()(groupCtx("a", "acct-mm"));
  await tool!.execute("t", { action: "remember", fact: "喜欢火锅", userId: "b", nickname: "小张" });

  const rec = await tool!.execute("t", { action: "recall", userId: "b" });
  assert.equal(rec.details?.success, true);
  assert.equal(rec.details?.userId, "b");
  assert.equal(rec.details?.nickname, "小张");
  assert.equal(rec.details?.facts?.[0]?.content, "喜欢火锅");
});

void test("recall resolves the current sender's nickname enrichment from the member cache", async () => {
  // Seed the member cache so the current sender's nickname is enrichable.
  getMember("acct-mm").session.upsertUser("g-tool", { userId: "a", nickName: "Alice", lastSeen: Date.now() });
  const tool = captureFactory()(groupCtx("a", "acct-mm"));
  await tool!.execute("t", { action: "remember", fact: "我叫Alice" });

  const rec = await tool!.execute("t", { action: "recall" });
  assert.equal(rec.details?.success, true);
  assert.equal(rec.details?.userId, "a");
  assert.equal(rec.details?.nickname, "Alice");
  assert.equal(rec.details?.facts?.[0]?.content, "我叫Alice");
});

void test("recall for a non-stored member reports success:false", async () => {
  const tool = captureFactory()(groupCtx("self", "acct-mm"));
  const res = await tool!.execute("t", { action: "recall", userId: "someone-else" });
  assert.equal(res.details?.success, false);
  assert.equal(res.details?.userId, "someone-else");
  assert.deepEqual(res.details?.facts, []);
});

void test("list returns all members with stored facts in the group", async () => {
  const tool = captureFactory()(groupCtx("a", "acct-mm"));
  await tool!.execute("t", { action: "remember", fact: "我叫小明", nickname: "小明" });
  await tool!.execute("t", { action: "remember", fact: "我叫小张", userId: "b", nickname: "小张" });

  const res = await tool!.execute("t", { action: "list" });
  assert.equal(res.details?.success, true);
  assert.equal(res.details?.members?.length, 2);
  const ids = res.details!.members!.map(m => m.userId).sort();
  assert.deepEqual(ids, ["a", "b"]);
});

void test("list on an empty group reports no memories", async () => {
  const tool = captureFactory()(groupCtx("a", "acct-mm"));
  const res = await tool!.execute("t", { action: "list" });
  assert.equal(res.details?.success, true);
  assert.deepEqual(res.details?.members, []);
});

void test("forget clears the current sender's facts", async () => {
  const tool = captureFactory()(groupCtx("a", "acct-mm"));
  await tool!.execute("t", { action: "remember", fact: "我叫小明" });
  const res = await tool!.execute("t", { action: "forget" });
  assert.equal(res.details?.success, true);

  const rec = await tool!.execute("t", { action: "recall" });
  assert.equal(rec.details?.success, false);
});

void test("forget with no prior memory returns success:false", async () => {
  const tool = captureFactory()(groupCtx("a", "acct-mm"));
  const res = await tool!.execute("t", { action: "forget" });
  assert.equal(res.details?.success, false);
});

void test("unsupported action is rejected", async () => {
  const tool = captureFactory()(groupCtx("a", "acct-mm"));
  const res = await tool!.execute("t", { action: "nonsense" });
  assert.equal(res.details?.success, false);
  assert.match(res.details!.msg!, /Unsupported action/);
});

void test("per-account isolation: same groupCode/userId in different accounts do not collide", async () => {
  const toolA = captureFactory()(groupCtx("u1", "acct-mm", "g-shared"));
  await toolA!.execute("t", { action: "remember", fact: "in acct-mm" });

  const toolB = captureFactory()(groupCtx("u1", "acct-mm2", "g-shared"));
  await toolB!.execute("t", { action: "remember", fact: "in acct-mm2" });

  const recA = await toolA!.execute("t", { action: "recall" });
  const recB = await toolB!.execute("t", { action: "recall" });
  assert.equal(recA.details?.facts?.[0]?.content, "in acct-mm");
  assert.equal(recB.details?.facts?.[0]?.content, "in acct-mm2");
});
