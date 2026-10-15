/**
 * Unit tests for command-sync — plugin command registry + sync payload builder.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildSyncCommandsPayload, getPluginCommands, registerPluginCommand, resolveListChatCommands, SYNC_INFORMATION_TYPE } from "./index.js";

void test("registerPluginCommand normalizes the slash prefix and dedups", () => {
  registerPluginCommand("foocmd", "do foo");
  registerPluginCommand("foocmd", "do foo again"); // dup → ignored
  registerPluginCommand("/barcmd", "do bar");
  const cmds = getPluginCommands();
  assert.ok(cmds.some(c => c.name === "/foocmd"));
  assert.ok(cmds.some(c => c.name === "/barcmd"));
  assert.equal(cmds.filter(c => c.name === "/foocmd").length, 1);
});

void test("buildSyncCommandsPayload returns COMMANDS type with versions + command data", async () => {
  registerPluginCommand("synced", "x");
  const payload = await buildSyncCommandsPayload();
  assert.equal(payload.syncType, SYNC_INFORMATION_TYPE.COMMANDS);
  assert.equal(typeof payload.botVersion, "string");
  assert.equal(typeof payload.pluginVersion, "string");
  assert.ok(Array.isArray(payload.commandData.botCommands));
  assert.ok(payload.commandData.pluginCommands.some(c => c.name === "/synced"));
});

const cfg = {} as never;

void test("resolveListChatCommands prefers native listChatCommandsForConfig", async () => {
  const seen: unknown[] = [];
  const list = await resolveListChatCommands(
    async () => ({
      listChatCommandsForConfig: (value) => {
        seen.push(value);
        return [{ key: "help", description: "help", textAliases: ["/help"] }];
      },
    }),
    async () => {
      throw new Error("legacy should not be imported");
    },
  );
  assert.equal(list(cfg)[0]?.key, "help");
  assert.equal(seen[0], cfg);
});

void test("resolveListChatCommands uses native listChatCommands when the config filter is absent", async () => {
  const list = await resolveListChatCommands(
    async () => ({
      listChatCommands: () => [{ key: "status", description: "status" }],
    }),
    async () => {
      throw new Error("legacy should not be imported");
    },
  );
  assert.equal(list(cfg)[0]?.key, "status");
});

void test("resolveListChatCommands falls back to command-auth when native has no lister", async () => {
  const list = await resolveListChatCommands(
    async () => ({}),
    async () => ({
      listChatCommandsForConfig: () => [{ key: "legacy", description: "legacy" }],
    }),
  );
  assert.equal(list(cfg)[0]?.key, "legacy");
});

void test("resolveListChatCommands falls back to command-auth when the native import fails", async () => {
  const list = await resolveListChatCommands(
    async () => {
      throw new Error("missing native");
    },
    async () => ({
      listChatCommandsForConfig: () => [{ key: "old", description: "old" }],
    }),
  );
  assert.equal(list(cfg)[0]?.key, "old");
});

void test("resolveListChatCommands returns an empty list when both command SDKs are unavailable", async () => {
  const thrown = await resolveListChatCommands(
    async () => {
      throw new Error("missing native");
    },
    async () => {
      throw new Error("missing legacy");
    },
  );
  const empty = await resolveListChatCommands(async () => ({}), async () => ({}));
  const invalid = await resolveListChatCommands(async () => null, async () => "not-a-module");
  assert.deepEqual(thrown(cfg), []);
  assert.deepEqual(empty(cfg), []);
  assert.deepEqual(invalid(cfg), []);
});
