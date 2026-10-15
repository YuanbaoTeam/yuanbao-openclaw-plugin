/**
 * Unit tests for skip-xcard-echo middleware: one-shot suppression of a card click's userMessage echo.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { __resetXCardRegistryForTest, rememberUserMessageEcho } from "../../xcard/registry.js";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";
import { skipXCardEcho } from "./skip-xcard-echo.js";

function groupCtx(rawBody: string, fromAccount = "u1") {
  const ctx = createMockCtx({ rawBody, isGroup: true, groupCode: "g1", fromAccount });
  return ctx;
}

void test("skip-xcard-echo: echoed userMessage is skipped once", async () => {
  __resetXCardRegistryForTest();
  const ctx0 = groupCtx("我选了：A");
  rememberUserMessageEcho(ctx0.account.accountId, "g1", "u1", "我选了：A");

  const first = createMockNext();
  await skipXCardEcho.handler(groupCtx(" 我选了：A "), first.next);
  assert.equal(first.wasCalled(), false);

  const second = createMockNext();
  await skipXCardEcho.handler(groupCtx("我选了：A"), second.next);
  assert.equal(second.wasCalled(), true);
});

void test("skip-xcard-echo: other operator / other text passes", async () => {
  __resetXCardRegistryForTest();
  const ctx0 = groupCtx("x");
  rememberUserMessageEcho(ctx0.account.accountId, "g1", "u1", "我选了：A");

  const other = createMockNext();
  await skipXCardEcho.handler(groupCtx("我选了：A", "u2"), other.next);
  assert.equal(other.wasCalled(), true);

  const text = createMockNext();
  await skipXCardEcho.handler(groupCtx("我选了：B"), text.next);
  assert.equal(text.wasCalled(), true);
});

void test("skip-xcard-echo: direct-message echo uses the peer id as conversation", async () => {
  __resetXCardRegistryForTest();
  const ctx = createMockCtx({ rawBody: "落子 E5", isGroup: false, fromAccount: "u1" });
  rememberUserMessageEcho(ctx.account.accountId, "u1", "u1", "落子 E5");

  const next = createMockNext();
  await skipXCardEcho.handler(ctx, next.next);
  assert.equal(next.wasCalled(), false);
});
