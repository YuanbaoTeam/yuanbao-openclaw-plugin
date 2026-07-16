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

// ── Bare-target routing fix (TAPD 1070112211160719458) ──
// Agent `send` tool may pass a bare group code (no group:/user:/direct: prefix). When it
// equals the originating group context it must route as group; explicit user:/direct: must
// not be re-classified even when their value coincidentally equals the group code.

void test("resolveActionTarget: bare target equal to context group routes as group", () => {
  const r = resolveActionTarget({
    cfg,
    params: { to: "658317543", __sessionKey: "sk", __agentId: "ag" },
    toolContext: { currentChannelId: "yuanbao:group:658317543" },
  });
  assert.equal(r.isGroup, true);
  assert.equal(r.target, "658317543");
  assert.equal(r.groupCode, "658317543");
  assert.equal(r.sessionKey, "sk");
  assert.equal(r.agentId, "ag");
});

void test("resolveActionTarget: explicit user:<groupCode> stays DM even when equal to context group", () => {
  const r = resolveActionTarget({
    cfg,
    params: { to: "user:658317543" },
    toolContext: { currentChannelId: "yuanbao:group:658317543" },
  });
  assert.equal(r.isGroup, false, "explicit user: must never be re-classified as group");
  assert.equal(r.target, "658317543");
});

void test("resolveActionTarget: explicit direct:<groupCode> stays DM even when equal to context group", () => {
  const r = resolveActionTarget({
    cfg,
    params: { to: "direct:658317543" },
    toolContext: { currentChannelId: "yuanbao:group:658317543" },
  });
  assert.equal(r.isGroup, false, "explicit direct: must never be re-classified as group");
});

void test("resolveActionTarget: bare target not equal to context group falls through to parseTarget (DM)", () => {
  const r = resolveActionTarget({
    cfg,
    params: { to: "999999" },
    toolContext: { currentChannelId: "yuanbao:group:658317543" },
  });
  assert.equal(r.isGroup, false, "bare target that differs from context is not re-classified");
  assert.equal(r.target, "999999");
});

void test("resolveActionTarget: explicit group:<code> with context still routes as group", () => {
  const r = resolveActionTarget({
    cfg,
    params: { to: "group:658317543" },
    toolContext: { currentChannelId: "yuanbao:group:658317543" },
  });
  assert.equal(r.isGroup, true);
  assert.equal(r.target, "658317543");
});
