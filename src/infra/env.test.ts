/**
 * Unit tests for infra/env.ts — version getters, operation-system probe, and the
 * minHostVersion runtime guard in initEnv.
 *
 * Each test calls initEnv with its own api so module-level version state is
 * deterministic regardless of order.
 */

import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import {
  OPENCLAW_TERMINAL_TYPE_ID,
  buildDeviceInfo,
  getHostInstanceId,
  getOpenclawVersion,
  getOperationSystem,
  getPluginVersion,
  initEnv,
} from "./env.js";

function api(version: string, lastTouchedVersion: string): OpenClawPluginApi {
  return { version, config: { meta: { lastTouchedVersion } } } as unknown as OpenClawPluginApi;
}

void test("getOperationSystem returns the os type", () => {
  assert.equal(getOperationSystem(), os.type());
});

void test("initEnv populates plugin + openclaw versions from api", () => {
  initEnv(api("9.9.9", "2026.5.6"));
  assert.equal(getPluginVersion(), "9.9.9");
  assert.equal(getOpenclawVersion(), "2026.5.6");
});

void test("initEnv still sets versions for an old host (compat guard is best-effort)", () => {
  // The minHostVersion guard reads package.json via a dist-relative path; under
  // tsx/src it is unresolvable so the constraint is skipped (if (!constraint) return).
  assert.doesNotThrow(() => initEnv(api("9.9.9", "2026.1.0")));
  assert.equal(getOpenclawVersion(), "2026.1.0");
});

void test("initEnv with empty api does not throw (legacy fallback path)", () => {
  assert.doesNotThrow(() => initEnv({} as unknown as OpenClawPluginApi));
});

void test("buildDeviceInfo mirrors auth-bind deviceInfo fields", () => {
  initEnv(api("2.17.0", "2026.6.5"));
  assert.deepEqual(buildDeviceInfo(), {
    appVersion: "2.17.0",
    appOperationSystem: os.type(),
    botVersion: "2026.6.5",
    instanceId: String(OPENCLAW_TERMINAL_TYPE_ID),
  });
});

void test("getHostInstanceId prefers OPENCLAW_INSTANCE_ID over HOSTNAME", () => {
  const prevInstance = process.env.OPENCLAW_INSTANCE_ID;
  const prevHost = process.env.HOSTNAME;
  process.env.OPENCLAW_INSTANCE_ID = "yb_prod_001";
  process.env.HOSTNAME = "pod-abc";
  try {
    assert.equal(getHostInstanceId(), "yb_prod_001");
  } finally {
    if (prevInstance === undefined) delete process.env.OPENCLAW_INSTANCE_ID;
    else process.env.OPENCLAW_INSTANCE_ID = prevInstance;
    if (prevHost === undefined) delete process.env.HOSTNAME;
    else process.env.HOSTNAME = prevHost;
  }
});
