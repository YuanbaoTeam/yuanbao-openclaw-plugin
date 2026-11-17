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
  description?: string;
  parameters?: {
    properties?: Record<string, { description?: string }>;
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
        yuanbao: {},
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

void test("xcard-send is exposed by default in Yuanbao group and direct sessions", () => {
  const factory = captureFactory();
  assert.equal(factory(context({ messageChannel: "slack" })), null);
  assert.ok(factory(context({ sessionKey: "agent:main:yuanbao:direct:u1" })));
  assert.equal(factory(context({ config: undefined })), null);
  const tool = factory(context({ workspaceDir: "/workspace-without-skills" }));
  assert.ok(tool);
  assert.match(tool.description ?? "", /express 参数/);
  assert.match(tool.description ?? "", /不要创建、保存或提到 \.json\/\.jsonl/);
  assert.match(tool.description ?? "", /List\(_template/);
  assert.match(tool.description ?? "", /ListItem/);
  assert.match(tool.description ?? "", /style="title"/);
  assert.match(tool.parameters?.properties?.express?.description ?? "", /首选/);
  assert.match(tool.parameters?.properties?.messages?.description ?? "", /兼容路径/);
  assert.ok(tool.parameters?.required?.includes("mode"));
  assert.equal(tool.parameters?.required?.includes("messages"), false);
});

void test("xcard-send is exposed in a direct session under the default dmScope", () => {
  const factory = captureFactory();
  // Default dmScope collapses direct keys to agent:main:main (shared with other
  // channels); exposure is decided by messageChannel, so the same key on another
  // channel must not expose the tool. Key-shape variants live in utils.test.ts.
  assert.ok(factory(context({ sessionKey: "agent:main:main" })));
  assert.equal(factory(context({ sessionKey: "agent:main:main", messageChannel: "telegram" })), null);
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
  assert.match(String((await tool.execute("t3b", {
    title: "card",
    mode: "once",
  })).details?.error), /messages 和 express/);
  assert.match(String((await tool.execute("t3c", {
    title: "card",
    messages: VALID_MESSAGES,
    express: 'root = Text("hi")',
    mode: "once",
  })).details?.error), /messages 和 express/);
  const badExpress = await tool.execute("t3d", {
    title: "card",
    express: "$/items = [{label: \"A\"}]\nroot = List(children=[Text($/items[0].label)])",
    mode: "once",
  });
  assert.equal(badExpress.details?.retryable, true);
  assert.match(String(badExpress.details?.note), /再次调用本工具/);
  assert.match(String(badExpress.details?.note), /不要把 Express/);
  assert.ok(Array.isArray(badExpress.details?.errors));
  assert.ok((badExpress.details?.errors as string[]).some((hint) => hint.includes("_template") && hint.includes("数组下标")));
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
