/**
 * Unit tests for the PURE exports of commands/upgrade/utils.ts.
 *
 * Only the non-IO functions are covered here (isValidVersion,
 * snapshotYuanbaoChannelConfig). The shell-out helpers (npm/openclaw CLI) are
 * exercised in the command integration phase, not as pure-function units.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { isValidVersion, snapshotYuanbaoChannelConfig } from "./utils.js";

void test("isValidVersion accepts MAJOR.MINOR.PATCH and pre-release", () => {
  assert.equal(isValidVersion("1.2.3"), true);
  assert.equal(isValidVersion("10.0.0"), true);
  assert.equal(isValidVersion("2.13.5-beta.1"), true);
  assert.equal(isValidVersion("1.0.0-rc.2"), true);
});

void test("isValidVersion rejects malformed versions", () => {
  assert.equal(isValidVersion("1.2"), false);
  assert.equal(isValidVersion("v1.2.3"), false);
  assert.equal(isValidVersion("1.2.3.4"), false);
  assert.equal(isValidVersion("abc"), false);
  assert.equal(isValidVersion(""), false);
});

void test("snapshotYuanbaoChannelConfig returns a JSON snapshot of channels.yuanbao", () => {
  const cfg = { channels: { yuanbao: { appKey: "k", dm: { policy: "open" } } } } as unknown as OpenClawConfig;
  const snap = snapshotYuanbaoChannelConfig(cfg);
  assert.ok(snap);
  assert.deepEqual(JSON.parse(snap), { appKey: "k", dm: { policy: "open" } });
});

void test("snapshotYuanbaoChannelConfig returns null when yuanbao config absent or non-object", () => {
  assert.equal(snapshotYuanbaoChannelConfig({ channels: {} } as unknown as OpenClawConfig), null);
  assert.equal(snapshotYuanbaoChannelConfig({} as unknown as OpenClawConfig), null);
  assert.equal(
    snapshotYuanbaoChannelConfig({ channels: { yuanbao: "nope" } } as unknown as OpenClawConfig),
    null,
  );
});
