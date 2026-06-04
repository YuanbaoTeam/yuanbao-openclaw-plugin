/**
 * Unit tests for tools/group.ts — the query_group_info tool factory + execute
 * guard paths (non-yuanbao channel, no group context, query failure).
 */

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginToolContext } from "../utils/utils.js";
import { registerGroupTools } from "./group.js";
import { removeMember } from "../../infra/cache/member.js";
import { setActiveWsClient } from "../../access/ws/runtime.js";
import type { YuanbaoWsClient } from "../../access/ws/client.js";

type ToolFactory = (ctx: OpenClawPluginToolContext) => { execute: (id: string, p: Record<string, unknown>) => Promise<{ details?: { success?: boolean; msg?: string } }> } | null;

/** Capture the tool factory registered via the plugin api. */
function captureFactory(): ToolFactory {
  let factory: ToolFactory | undefined;
  const api = { registerTool: (f: ToolFactory) => { factory = f; } } as unknown as OpenClawPluginApi;
  registerGroupTools(api);
  return factory!;
}

const ctx = (over: Record<string, unknown>) => over as unknown as OpenClawPluginToolContext;

void test("factory returns null for non-yuanbao channels", () => {
  const factory = captureFactory();
  assert.equal(factory(ctx({ messageChannel: "telegram" })), null);
});

void test("execute reports no group context when sessionKey has no group", async () => {
  const factory = captureFactory();
  const tool = factory(ctx({ messageChannel: "yuanbao", sessionKey: "agent:a:yuanbao:user:u1", agentAccountId: "acct-g1" }));
  const res = await tool!.execute("t", {});
  assert.equal(res.details?.success, false);
  assert.match(res.details!.msg!, /No group context/);
});

void test("execute reports failure when group info is unavailable (no WS client)", async () => {
  const factory = captureFactory();
  const tool = factory(ctx({ messageChannel: "yuanbao", sessionKey: "agent:a:yuanbao:group:585", agentAccountId: "acct-g2" }));
  const res = await tool!.execute("t", {});
  assert.equal(res.details?.success, false);
  assert.match(res.details!.msg!, /Failed to query group info/);
});

void test("execute returns group info on a successful query", async () => {
  setActiveWsClient("acct-g3", {
    getState: () => "connected",
    queryGroupInfo: async () => ({ code: 0, msg: "", group_info: { group_name: "派对", group_owner_user_id: "o", group_owner_nickname: "Owner", group_size: 8 } }),
  } as unknown as YuanbaoWsClient);
  const tool = captureFactory()(ctx({ messageChannel: "yuanbao", sessionKey: "x:yuanbao:group:585", agentAccountId: "acct-g3" }));
  const res = await tool!.execute("t", {}) as { details?: { success?: boolean; groupInfo?: { groupName?: string; groupSize?: number } } };
  assert.equal(res.details?.success, true);
  assert.equal(res.details?.groupInfo?.groupName, "派对");
  assert.equal(res.details?.groupInfo?.groupSize, 8);
});

afterEach(() => { setActiveWsClient("acct-g3", null); removeMember("acct-g3"); });
