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
