/**
 * Unit tests for messaging/system-callbacks.ts — the callback registry +
 * dispatcher.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { dispatchSystemCallback, registerSystemCallback } from "./system-callbacks.js";
import type { SystemCallbackParams } from "./system-callbacks.js";

function params(callback_command?: string): SystemCallbackParams {
  return { ctx: {} as never, msg: { callback_command } as never, isGroup: false };
}

void test("dispatchSystemCallback returns false when no callback_command", () => {
  assert.equal(dispatchSystemCallback(params(undefined)), false);
});

void test("dispatchSystemCallback returns false for an unregistered command", () => {
  assert.equal(dispatchSystemCallback(params("No.Such.Command")), false);
});

void test("registered handler is invoked and dispatch returns true", () => {
  let called = false;
  registerSystemCallback("Test.UnitCmd", () => { called = true; });
  const handled = dispatchSystemCallback(params("Test.UnitCmd"));
  assert.equal(handled, true);
  assert.equal(called, true);
});

void test("re-registering the same command overwrites the handler", () => {
  const order: string[] = [];
  registerSystemCallback("Test.Overwrite", () => order.push("first"));
  registerSystemCallback("Test.Overwrite", () => order.push("second"));
  dispatchSystemCallback(params("Test.Overwrite"));
  assert.deepEqual(order, ["second"]);
});
