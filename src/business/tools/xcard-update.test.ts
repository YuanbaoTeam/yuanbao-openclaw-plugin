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
  description: string;
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
    config: { channels: { yuanbao: { xcardEnabled: true } } },
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
  assert.deepEqual(tool.parameters?.required, ["surfaceId", "messages"]);
  assert.match(tool.description, /103/);
  assert.match(tool.description, /不要再次调用 yuanbao_xcard_send/);
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
  assert.equal((await tool.execute("u3", {
    surfaceId: "surface-1",
    messages: JSON.stringify([{ version: "v1.0" }]),
  })).details?.error, "xCard A2UI 校验失败");
  assert.match(String((await tool.execute("u4", {
    surfaceId: "surface-1",
    messages: VALID_MESSAGES,
  })).details?.error), /连接不可用/);
});
