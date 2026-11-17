/**
 * Unit tests for yuanbao_xcard_update exposure, contract, and pre-transport validation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginToolContext } from "../utils/utils.js";
import { registerXCardUpdateTool } from "./xcard-update.js";

type ToolResult = { details?: Record<string, unknown> };
type Tool = {
  parameters?: { required?: readonly string[] };
  execute: (id: string, params: Record<string, unknown>) => Promise<ToolResult>;
} | null;
type Factory = (ctx: OpenClawPluginToolContext) => Tool;

function captureFactory(): Factory {
  let factory: Factory | undefined;
  const api = {
    registerTool: (candidate: Factory) => {
      factory = candidate;
    },
  } as unknown as OpenClawPluginApi;
  registerXCardUpdateTool(api);
  return factory!;
}

function context(overrides: Record<string, unknown> = {}): OpenClawPluginToolContext {
  return {
    messageChannel: "yuanbao",
    sessionKey: "agent:main:yuanbao:group:g1",
    agentAccountId: "default",
    config: { channels: { yuanbao: {} } },
    ...overrides,
  } as unknown as OpenClawPluginToolContext;
}

const VALID_MESSAGES = JSON.stringify([
  {
    version: "v1.0",
    createSurface: {
      surfaceId: "draft",
      catalogId: "https://yuanbao.tencent.com/specification/v1_0/catalogs/xcard/catalog.json",
    },
  },
  {
    version: "v1.0",
    updateComponents: {
      surfaceId: "draft",
      components: [{ id: "root", component: "Text", text: "updated" }],
    },
  },
]);

void test("xcard-update is exposed with an explicit update-only contract", () => {
  const factory = captureFactory();
  assert.equal(factory(context({ messageChannel: "slack" })), null);
  const tool = factory(context());
  assert.ok(tool);
  assert.ok(factory(context({
    sessionKey: "agent:main:yuanbao:direct:u1",
    requesterSenderId: "u1",
  })));
  // Default dmScope: direct turns arrive as agent:main:main; still exposed on Yuanbao.
  assert.ok(factory(context({
    sessionKey: "agent:main:main",
    requesterSenderId: "u1",
  })));
  assert.deepEqual(tool.parameters?.required, ["surfaceId"]);
});

void test("xcard-update rejects invalid inputs before transport", async () => {
  const tool = captureFactory()(context());
  assert.ok(tool);
  assert.match(String((await tool.execute("u1", {
    surfaceId: "",
    messages: VALID_MESSAGES,
  })).details?.error), /surfaceId/);
  assert.match(String((await tool.execute("u2", {
    surfaceId: "surface-1",
    messages: "{bad",
  })).details?.error), /JSON/);
  assert.match(String((await tool.execute("u2b", {
    surfaceId: "surface-1",
  })).details?.error), /messages 和 express/);
  assert.match(String((await tool.execute("u2c", {
    surfaceId: "surface-1",
    messages: VALID_MESSAGES,
    express: 'root = Text("hi")',
  })).details?.error), /messages 和 express/);
  const badExpress = await tool.execute("u2d", {
    surfaceId: "surface-1",
    express: "$/items = [{label: \"A\"}]\nroot = List(children=[Text($/items[0].label)])",
  });
  assert.equal(badExpress.details?.retryable, true);
  assert.match(String(badExpress.details?.note), /再次调用本工具/);
  assert.match(String(badExpress.details?.note), /不要把 Express/);
  assert.ok(Array.isArray(badExpress.details?.errors));
  assert.ok((badExpress.details?.errors as string[]).some((hint) => hint.includes("_template") && hint.includes("数组下标")));
  assert.equal((await tool.execute("u3", {
    surfaceId: "surface-1",
    messages: JSON.stringify([{ version: "v1.0" }]),
  })).details?.error, "xCard A2UI 校验失败");
  assert.match(String((await tool.execute("u4", {
    surfaceId: "surface-1",
    messages: VALID_MESSAGES,
  })).details?.error), /连接不可用/);
});
