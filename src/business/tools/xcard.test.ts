/**
 * Unit tests for yuanbao_xcard_template exposure and pre-transport validation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { OpenClawPluginToolContext } from "../utils/utils.js";
import { registerXCardTools } from "./xcard.js";

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
  registerXCardTools(api);
  return factory!;
}

function context(overrides: Record<string, unknown> = {}): OpenClawPluginToolContext {
  return {
    messageChannel: "yuanbao",
    sessionKey: "agent:main:yuanbao:group:g1",
    requesterSenderId: "u1",
    agentAccountId: "default",
    config: { channels: { yuanbao: {} } },
    ...overrides,
  } as unknown as OpenClawPluginToolContext;
}

void test("xcard-template is exposed in Yuanbao group and direct sessions", () => {
  const factory = captureFactory();
  assert.equal(factory(context({ messageChannel: "slack" })), null);
  assert.equal(factory(context({ config: undefined })), null);
  assert.ok(factory(context()));
  assert.ok(factory(context({ sessionKey: "agent:main:yuanbao:direct:u1" })));
  assert.ok(factory(context({ sessionKey: "agent:main:main" })));
  assert.equal(factory(context({ sessionKey: "agent:main:main", requesterSenderId: "" })), null);

  const tool = factory(context());
  assert.ok(tool);
  assert.match(tool.description ?? "", /内置模板/);
  assert.match(tool.description ?? "", /群聊或私聊/);
  assert.deepEqual(tool.parameters?.required, ["action"]);
});

void test("xcard-template lists and describes templates without transport", async () => {
  const tool = captureFactory()(context());
  assert.ok(tool);

  const listed = await tool.execute("t1", { action: "list_templates" });
  assert.equal(listed.details?.ok, true);
  assert.ok(Array.isArray(listed.details?.templates));

  const described = await tool.execute("t2", { action: "get_template", template: "item_list" });
  assert.equal(described.details?.ok, true);
  assert.equal(described.details?.key, "item_list");
  assert.ok(described.details?.fields);
  assert.ok(described.details?.example);
});

void test("xcard-template rejects invalid data before transport", async () => {
  const tool = captureFactory()(context());
  assert.ok(tool);

  assert.match(String((await tool.execute("t1", {
    action: "get_template",
    template: "missing",
  })).details?.error), /未知模板/);

  assert.match(String((await tool.execute("t2", {
    action: "create",
    template: "item_list",
    data: "{bad",
  })).details?.error), /JSON/);

  const invalid = await tool.execute("t3", {
    action: "create",
    template: "item_list",
    data: "{}",
  });
  assert.equal(invalid.details?.ok, false);
  assert.equal(invalid.details?.retryable, true);
  assert.ok(Array.isArray(invalid.details?.errors));

  const validNoTransport = await tool.execute("t4", {
    action: "create",
    template: "item_list",
    data: JSON.stringify({
      title: "待办",
      items: [{ title: "写文档" }],
    }),
  });
  assert.match(String(validNoTransport.details?.error), /连接不可用/);
});
