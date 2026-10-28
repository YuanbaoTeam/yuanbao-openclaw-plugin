import assert from "node:assert/strict";
import test from "node:test";

const config = {} as never;
let importSeq = 0;

async function importCompatWithModules(t: Parameters<Parameters<typeof test>[1]>[0], modules: Record<string, unknown>) {
  t.mock.module("node:module", {
    namedExports: {
      createRequire: () => (moduleName: string) => {
        if (moduleName in modules) {
          return modules[moduleName];
        }
        throw Object.assign(new Error(`Cannot find module '${moduleName}'`), { code: "MODULE_NOT_FOUND" });
      },
    },
  });

  return await import(`./openclaw-sdk-compat.js?case=${++importSeq}`);
}

void test("listChatCommandsForConfig prefers the legacy config-aware helper", async (t) => {
  const commands = [{ key: "new", description: "create", textAliases: ["/new"] }];
  const { listChatCommandsForConfig } = await importCompatWithModules(t, {
    "openclaw/plugin-sdk/command-auth": {
      listChatCommandsForConfig: (cfg: unknown) => {
        assert.equal(cfg, config);
        return commands;
      },
      listChatCommands: () => [{ key: "legacy", description: "legacy", textAliases: ["/legacy"] }],
    },
    "openclaw/plugin-sdk/command-auth-native": {
      listChatCommands: () => [{ key: "native", description: "native", textAliases: ["/native"] }],
    },
  });

  assert.deepEqual(listChatCommandsForConfig(config), commands);
});

void test("listChatCommandsForConfig uses native listChatCommands when legacy helper is unavailable", async (t) => {
  const commands = [{ key: "native", description: "native", textAliases: ["/native"] }];
  const { listChatCommandsForConfig } = await importCompatWithModules(t, {
    "openclaw/plugin-sdk/command-auth-native": {
      listChatCommands: (cfg: unknown) => {
        assert.equal(cfg, config);
        return commands;
      },
    },
  });

  assert.deepEqual(listChatCommandsForConfig(config), commands);
});

void test("listChatCommandsForConfig falls back to legacy listChatCommands", async (t) => {
  const commands = [{ key: "legacy", description: "legacy", textAliases: ["/legacy"] }];
  const { listChatCommandsForConfig } = await importCompatWithModules(t, {
    "openclaw/plugin-sdk/command-auth": {
      listChatCommands: () => commands,
    },
  });

  assert.deepEqual(listChatCommandsForConfig(config), commands);
});

void test("listChatCommandsForConfig returns an empty list when command helpers are unavailable", async (t) => {
  const { listChatCommandsForConfig } = await importCompatWithModules(t, {});

  assert.deepEqual(listChatCommandsForConfig(config), []);
});

void test("createChannelReplyPipeline uses legacy helper when available", async (t) => {
  const params = { channel: "yuanbao" };
  const pipeline = { onModelSelected: () => {}, sourceReplyDeliveryMode: "automatic" };
  const { createChannelReplyPipeline } = await importCompatWithModules(t, {
    "openclaw/plugin-sdk/channel-reply-pipeline": {
      createChannelReplyPipeline: (received: unknown) => {
        assert.equal(received, params);
        return pipeline;
      },
    },
  });

  assert.equal(createChannelReplyPipeline(params), pipeline);
});

void test("createChannelReplyPipeline returns a safe fallback when the SDK entry is unavailable", async (t) => {
  const { createChannelReplyPipeline } = await importCompatWithModules(t, {});
  const pipeline = createChannelReplyPipeline({ channel: "yuanbao" });

  assert.equal(typeof pipeline.onModelSelected, "function");
  assert.doesNotThrow(() => pipeline.onModelSelected?.("model"));
});
