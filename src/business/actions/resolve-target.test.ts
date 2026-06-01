/**
 * Unit tests for actions/resolve-target.ts — pure target resolution from the
 * two ActionParams sources (explicit to/target vs. toolContext channel id).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { extractGroupFromChannelId, resolveActionTarget } from "./resolve-target.js";
import type { ActionParams } from "./resolve-target.js";

const cfg = {} as ActionParams["cfg"];

void test("extractGroupFromChannelId parses the yuanbao group prefix", () => {
  assert.equal(extractGroupFromChannelId("yuanbao:group:585003747"), "585003747");
  assert.equal(extractGroupFromChannelId("yuanbao:user:u-1"), undefined);
  assert.equal(extractGroupFromChannelId(undefined), undefined);
});

void test("resolveActionTarget: explicit group target", () => {
  const r = resolveActionTarget({ cfg, params: { to: "group:g-1" } });
  assert.equal(r.isGroup, true);
  assert.ok(r.target);
});

void test("resolveActionTarget: explicit direct target", () => {
  const r = resolveActionTarget({ cfg, params: { to: "user:u-1" } });
  assert.equal(r.isGroup, false);
  assert.ok(r.target);
});

void test("resolveActionTarget: top-level `to` is used when params absent", () => {
  const r = resolveActionTarget({ cfg, to: "user:u-2" });
  assert.equal(r.isGroup, false);
  assert.ok(r.target);
});

void test("resolveActionTarget: falls back to toolContext group when no explicit target", () => {
  const r = resolveActionTarget({ cfg, toolContext: { currentChannelId: "yuanbao:group:999" } });
  assert.equal(r.isGroup, true);
  assert.equal(r.target, "999");
  assert.equal(r.groupCode, "999");
});

void test("resolveActionTarget: carries sessionKey/agentId from params", () => {
  const r = resolveActionTarget({ cfg, params: { to: "user:u-1", __sessionKey: "sk", __agentId: "ag" } });
  assert.equal(r.sessionKey, "sk");
  assert.equal(r.agentId, "ag");
});

void test("resolveActionTarget: throws when no target can be determined", () => {
  assert.throws(() => resolveActionTarget({ cfg }), /Unable to determine delivery target/);
});
