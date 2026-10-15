/**
 * Unit tests for yuanbao_xcard_send tool exposure and input-validation guards.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginToolContext } from "../utils/utils.js";
import { registerXCardSendTool } from "./xcard-send.js";

type ToolResult = { details?: Record<string, unknown> };
type Tool = {
  parameters?: {
    required?: readonly string[];
  };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<ToolResult>;
} | null;
type Factory = (ctx: OpenClawPluginToolContext) => Tool;

function captureFactory(): Factory {
  let factory: Factory | undefined;
  const api = {
    registerTool: (candidate: Factory) => {
      factory = candidate;
    },
  } as unknown as OpenClawPluginApi;
  registerXCardSendTool(api);
  return factory!;
}

function context(overrides: Record<string, unknown> = {}): OpenClawPluginToolContext {
  return {
    messageChannel: "yuanbao",
    sessionKey: "agent:main:yuanbao:group:g1",
    requesterSenderId: "u1",
    agentAccountId: "default",
    config: {
      channels: {
        yuanbao: {
          xcardEnabled: true,
        },
      },
    },
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
      components: [{ id: "root", component: "Text", text: "hello" }],
    },
  },
]);

void test("xcard-send factory is exposed by channel/config, not workspace skill paths", () => {
  const factory = captureFactory();
  assert.equal(factory(context({ messageChannel: "slack" })), null);
  assert.equal(factory(context({ sessionKey: "agent:main:yuanbao:direct:u1" })), null);
  assert.equal(factory(context({ config: undefined })), null);
  assert.equal(factory(context({
    config: { channels: { yuanbao: { xcardEnabled: false } } },
  })), null);
  const tool = factory(context({ workspaceDir: "/workspace-without-skills" }));
  assert.ok(tool);
  assert.ok(tool.parameters?.required?.includes("mode"));
});

void test("xcard-send rejects invalid inputs before transport", async () => {
  const tool = captureFactory()(context());
  assert.ok(tool);

  assert.match(String((await tool.execute("t0", {
    title: "card",
    messages: VALID_MESSAGES,
  })).details?.error), /mode 必须显式指定/);
  assert.match(String((await tool.execute("t1", {
    title: "",
    messages: "[]",
    mode: "once",
  })).details?.error), /title/);
  assert.match(String((await tool.execute("t2", {
    title: "card",
    fallbackText: "x".repeat(2001),
    messages: "[]",
    mode: "once",
  })).details?.error), /fallbackText/);
  assert.match(String((await tool.execute("t3", {
    title: "card",
    messages: "{bad",
    mode: "once",
  })).details?.error), /JSON/);
  assert.equal((await tool.execute("t4", {
    title: "card",
    messages: JSON.stringify([{ version: "v1.0" }]),
    mode: "once",
  })).details?.error, "xCard A2UI 校验失败");
  assert.match(String((await tool.execute("t5", {
    title: "card",
    messages: VALID_MESSAGES,
    mode: "perRevision",
  })).details?.error), /连接不可用/);
});
