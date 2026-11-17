/**
 * Unit tests for command-sync — plugin command registry + sync payload builder.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildSyncCommandsPayload, getPluginCommands, registerPluginCommand, SYNC_INFORMATION_TYPE } from "./index.js";

void test("registerPluginCommand normalizes the slash prefix and dedups", () => {
  registerPluginCommand("foocmd", "do foo");
  registerPluginCommand("foocmd", "do foo again"); // dup → ignored
  registerPluginCommand("/barcmd", "do bar");
  const cmds = getPluginCommands();
  assert.ok(cmds.some(c => c.name === "/foocmd"));
  assert.ok(cmds.some(c => c.name === "/barcmd"));
  assert.equal(cmds.filter(c => c.name === "/foocmd").length, 1);
});

void test("buildSyncCommandsPayload returns COMMANDS type with versions + command data", () => {
  registerPluginCommand("synced", "x");
  const payload = buildSyncCommandsPayload();
  assert.equal(payload.syncType, SYNC_INFORMATION_TYPE.COMMANDS);
  assert.equal(typeof payload.botVersion, "string");
  assert.equal(typeof payload.pluginVersion, "string");
  assert.ok(Array.isArray(payload.commandData.botCommands));
  assert.ok(payload.commandData.pluginCommands.some(c => c.name === "/synced"));
});

void test("command sync includes text commands without native Yuanbao support", () => {
  const names = buildSyncCommandsPayload().commandData.botCommands.map(command => command.name);
  for (const name of ["/openclaw", "/allowlist", "/login", "/status"]) {
    assert.ok(names.includes(name), `${name} must be discoverable as a text command`);
  }
});

void test("command sync preserves explicit config flags for gated commands", () => {
  const gated = ["config", "mcp", "plugins", "debug", "bash"] as const;
  const defaults = buildSyncCommandsPayload().commandData.botCommands.map(command => command.name);
  for (const key of gated) assert.ok(!defaults.includes(`/${key}`), `${key} defaults off`);

  const enabled = buildSyncCommandsPayload({ commands: Object.fromEntries(gated.map(key => [key, true])) })
    .commandData.botCommands.map(command => command.name);
  for (const key of gated) assert.ok(enabled.includes(`/${key}`), `${key} enabled`);

  const disabled = buildSyncCommandsPayload({ commands: Object.fromEntries(gated.map(key => [key, false])) })
    .commandData.botCommands.map(command => command.name);
  for (const key of gated) assert.ok(!disabled.includes(`/${key}`), `${key} disabled`);
});
