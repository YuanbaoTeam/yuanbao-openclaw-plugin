/**
 * Unit tests for tools/member-memory.ts — member_memory tool: factory guard,
 * remember/recall/list/forget actions, target resolution (userId | self sender),
 * and the core "派不记人" bug scenario (two senders must not cross-contaminate).
 *
 * Also asserts the resolveTarget error message does NOT advertise `nickname` as
 * a lookup target (per ai-coding-kb BadCase: error copy must match the
 * "nickname is display only" implementation semantics).
 */

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginToolContext } from "../utils/utils.js";
import { removeMember } from "../../infra/cache/member.js";
import { removeMemberMemory } from "../../infra/cache/member-memory.js";
import { registerMemberMemoryTools } from "./member-memory.js";

type Tool = {
  execute: (
    id: string,
    p: Record<string, unknown>,
  ) => Promise<{
    details?: {
      success?: boolean;
      msg?: string;
      members?: unknown[];
      userId?: string;
      nickname?: string;
      facts?: Array<{ content: string; updatedAt: string }>;
    };
  }>;
} | null;
type Factory = (ctx: OpenClawPluginToolContext) => Tool;

function captureFactory(): Factory {
  let factory: Factory | undefined;
  const api = { registerTool: (f: Factory) => { factory = f; } } as unknown as OpenClawPluginApi;
  registerMemberMemoryTools(api);
  return factory!;
}

const ctx = (over: Record<string, unknown>) => over as unknown as OpenClawPluginToolContext;

/** Track accounts so each test cleans up both Member and MemberMemory singletons. */
const accounts: string[] = [];
function acct(): string {
  const id = `mt-${accounts.length}-${Math.random().toString(36).slice(2)}`;
  accounts.push(id);
  return id;
}

afterEach(() => {
  for (const id of accounts) {
    removeMember(id);
    removeMemberMemory(id);
  }
  accounts.length = 0;
});

/** Group-scoped sessionKey helper. */
function groupSessionKey(groupCode: string): string {
  return `agent:a:yuanbao:group:${groupCode}`;
}

void test("factory returns null for non-yuanbao channels", () => {
  assert.equal(captureFactory()(ctx({ messageChannel: "slack" })), null);
});

void test("no group context -> success:false", async () => {
  const id = acct();
  const tool = captureFactory()(ctx({
    messageChannel: "yuanbao",
    sessionKey: "agent:a:yuanbao:direct:u-1",
    agentAccountId: id,
    requesterSenderId: "u-1",
  }));
  const res = await tool!.execute("t", { action: "list" });
  assert.equal(res.details?.success, false);
  assert.match(res.details!.msg!, /No group context/);
});

void test("remember requires a non-empty fact", async () => {
  const id = acct();
  const tool = captureFactory()(ctx({
    messageChannel: "yuanbao",
    sessionKey: groupSessionKey("g-rem"),
    agentAccountId: id,
    requesterSenderId: "u-a",
  }));
  const res = await tool!.execute("t", { action: "remember", fact: "   " });
  assert.equal(res.details?.success, false);
  assert.match(res.details!.msg!, /requires a non-empty/);
});

void test("remember + recall roundtrips, defaulting to the current sender", async () => {
  const id = acct();
  const tool = captureFactory()(ctx({
    messageChannel: "yuanbao",
    sessionKey: groupSessionKey("g-round"),
    agentAccountId: id,
    requesterSenderId: "u-a",
  }));
  await tool!.execute("t", { action: "remember", fact: "我叫小明" });
  const res = await tool!.execute("t", { action: "recall" });
  assert.equal(res.details?.success, true);
  assert.equal(res.details?.userId, "u-a");
  assert.equal(res.details?.facts?.length, 1);
  assert.equal(res.details?.facts?.[0]?.content, "我叫小明");
});

void test("two senders in the same group do not cross-contaminate (core bug scenario)", async () => {
  const id = acct();
  const factory = captureFactory();
  const sk = groupSessionKey("g-cross");

  // sender a remembers "我叫小明"
  const toolA = factory(ctx({
    messageChannel: "yuanbao",
    sessionKey: sk,
    agentAccountId: id,
    requesterSenderId: "user-a",
  }));
  await toolA!.execute("t", { action: "remember", fact: "我叫小明" });

  // sender b remembers "我叫小张"
  const toolB = factory(ctx({
    messageChannel: "yuanbao",
    sessionKey: sk,
    agentAccountId: id,
    requesterSenderId: "user-b",
  }));
  await toolB!.execute("t", { action: "remember", fact: "我叫小张" });

  // a asks "我叫什么" -> should get 小明, not 小张
  const resA = await toolA!.execute("t", { action: "recall" });
  const aContents = (resA.details?.facts ?? []).map(f => f.content);
  assert.ok(aContents.includes("我叫小明"), "a should recall 小明");
  assert.ok(!aContents.includes("我叫小张"), "a must not recall 小张");

  // b asks "我叫什么" -> should get 小张, not 小明
  const resB = await toolB!.execute("t", { action: "recall" });
  const bContents = (resB.details?.facts ?? []).map(f => f.content);
  assert.ok(bContents.includes("我叫小张"), "b should recall 小张");
  assert.ok(!bContents.includes("我叫小明"), "b must not recall 小明");
});

void test("recall with explicit userId targets that member (not the sender)", async () => {
  const id = acct();
  const factory = captureFactory();
  const sk = groupSessionKey("g-explicit");

  // a remembers something
  const toolA = factory(ctx({
    messageChannel: "yuanbao",
    sessionKey: sk,
    agentAccountId: id,
    requesterSenderId: "user-a",
  }));
  await toolA!.execute("t", { action: "remember", fact: "a-only-fact" });

  // b recalls a's facts by passing userId=user-a
  const toolB = factory(ctx({
    messageChannel: "yuanbao",
    sessionKey: sk,
    agentAccountId: id,
    requesterSenderId: "user-b",
  }));
  const res = await toolB!.execute("t", { action: "recall", userId: "user-a" });
  assert.equal(res.details?.success, true);
  assert.equal(res.details?.userId, "user-a");
  assert.equal(res.details?.facts?.[0]?.content, "a-only-fact");
});

void test("list returns all members with stored facts in the group", async () => {
  const id = acct();
  const factory = captureFactory();
  const sk = groupSessionKey("g-list");

  const toolA = factory(ctx({
    messageChannel: "yuanbao",
    sessionKey: sk,
    agentAccountId: id,
    requesterSenderId: "user-a",
  }));
  await toolA!.execute("t", { action: "remember", fact: "a-fact" });

  const toolB = factory(ctx({
    messageChannel: "yuanbao",
    sessionKey: sk,
    agentAccountId: id,
    requesterSenderId: "user-b",
  }));
  await toolB!.execute("t", { action: "remember", fact: "b-fact" });

  const res = await toolB!.execute("t", { action: "list" });
  assert.equal(res.details?.success, true);
  assert.equal(res.details?.members?.length, 2);
  const userIds = (res.details?.members as Array<{ userId: string }>).map(m => m.userId).sort();
  assert.deepEqual(userIds, ["user-a", "user-b"]);
});

void test("list on an empty group returns success with empty members", async () => {
  const id = acct();
  const tool = captureFactory()(ctx({
    messageChannel: "yuanbao",
    sessionKey: groupSessionKey("g-empty-list"),
    agentAccountId: id,
    requesterSenderId: "u-a",
  }));
  const res = await tool!.execute("t", { action: "list" });
  assert.equal(res.details?.success, true);
  assert.deepEqual(res.details?.members, []);
});

void test("forget clears the caller's stored facts", async () => {
  const id = acct();
  const tool = captureFactory()(ctx({
    messageChannel: "yuanbao",
    sessionKey: groupSessionKey("g-forget"),
    agentAccountId: id,
    requesterSenderId: "u-a",
  }));
  await tool!.execute("t", { action: "remember", fact: "tmp" });
  const removed = await tool!.execute("t", { action: "forget" });
  assert.equal(removed.details?.success, true);
  // recall now reports nothing
  const rec = await tool!.execute("t", { action: "recall" });
  assert.equal(rec.details?.success, false);
  assert.equal(rec.details?.facts?.length, 0);
});

void test("forget with no prior facts returns success:false", async () => {
  const id = acct();
  const tool = captureFactory()(ctx({
    messageChannel: "yuanbao",
    sessionKey: groupSessionKey("g-forget-empty"),
    agentAccountId: id,
    requesterSenderId: "u-a",
  }));
  const res = await tool!.execute("t", { action: "forget" });
  assert.equal(res.details?.success, false);
});

void test("unsupported action returns an error", async () => {
  const id = acct();
  const tool = captureFactory()(ctx({
    messageChannel: "yuanbao",
    sessionKey: groupSessionKey("g-bad"),
    agentAccountId: id,
    requesterSenderId: "u-a",
  }));
  const res = await tool!.execute("t", { action: "nonsense" });
  assert.equal(res.details?.success, false);
  assert.match(res.details!.msg!, /Unsupported action/);
});

void test("nickname is stored as enrichment but not used as a lookup target", async () => {
  const id = acct();
  const factory = captureFactory();
  const sk = groupSessionKey("g-nick");

  // a remembers with a nickname hint
  const toolA = factory(ctx({
    messageChannel: "yuanbao",
    sessionKey: sk,
    agentAccountId: id,
    requesterSenderId: "user-a",
  }));
  await toolA!.execute("t", { action: "remember", fact: "a-fact", nickname: "Alice" });

  // b passes only nickname (no userId, no sender) -> cannot resolve via nickname
  const toolB = factory(ctx({
    messageChannel: "yuanbao",
    sessionKey: sk,
    agentAccountId: id,
    requesterSenderId: undefined,
  }));
  const res = await toolB!.execute("t", { action: "recall", nickname: "Alice" });
  assert.equal(res.details?.success, false);
  // Error message must NOT advertise nickname as a lookup option
  assert.doesNotMatch(res.details!.msg!, /a known `nickname`/);
  assert.doesNotMatch(res.details!.msg!, /nickname.*look/i);
});

void test("resolveTarget failure message does not mention nickname as a lookup target", async () => {
  const id = acct();
  // No userId param, no sender -> resolveTarget returns null
  const tool = captureFactory()(ctx({
    messageChannel: "yuanbao",
    sessionKey: groupSessionKey("g-nomsg"),
    agentAccountId: id,
    requesterSenderId: undefined,
  }));
  const res = await tool!.execute("t", { action: "recall" });
  assert.equal(res.details?.success, false);
  // The BadCase: copy must not list `nickname` as a way to find a target
  assert.doesNotMatch(res.details!.msg!, /a known `nickname`/);
  assert.match(res.details!.msg!, /Pass a `userId`/);
});

void test("nickname hint is refreshed on the stored record when supplied", async () => {
  const id = acct();
  const factory = captureFactory();
  const sk = groupSessionKey("g-nick-refresh");

  const toolA = factory(ctx({
    messageChannel: "yuanbao",
    sessionKey: sk,
    agentAccountId: id,
    requesterSenderId: "user-a",
  }));
  await toolA!.execute("t", { action: "remember", fact: "a-fact", nickname: "Alice" });
  await toolA!.execute("t", { action: "remember", fact: "a-fact-2", nickname: "Alice2" });

  // b recalls a's facts by userId; nickname should be the latest hint
  const toolB = factory(ctx({
    messageChannel: "yuanbao",
    sessionKey: sk,
    agentAccountId: id,
    requesterSenderId: "user-b",
  }));
  const res = await toolB!.execute("t", { action: "recall", userId: "user-a" });
  assert.equal(res.details?.nickname, "Alice2");
  assert.equal(res.details?.facts?.length, 2);
});
