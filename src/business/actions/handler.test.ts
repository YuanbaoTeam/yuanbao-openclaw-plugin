/**
 * Integration test for actions/handler.ts handleAction — the outbound entry.
 *
 * createMessageSender is mocked so we can assert which OutboundItems the handler
 * resolves and dispatches; runtime + active WS client are injected so the
 * orchestration runs without a real connection.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { ActionParams } from "./resolve-target.js";
import type { OutboundItem, SendResult } from "../outbound/types.js";
import { setYuanbaoRuntime } from "../../runtime.js";
import { setActiveWsClient } from "../../access/ws/runtime.js";

let sentItems: OutboundItem[];
let sendResult: SendResult;
let handleAction: typeof import("./handler.js").handleAction;

const cfg = {} as ActionParams["cfg"];

beforeEach(async () => {
  sentItems = [];
  sendResult = { ok: true, messageId: "m-1" };
  mock.module("../outbound/create-sender.js", {
    namedExports: {
      createMessageSender: () => ({
        send: async (item: OutboundItem) => { sentItems.push(item); return sendResult; },
        sendText: async () => sendResult,
        sendMedia: async () => sendResult,
        sendSticker: async () => sendResult,
        sendRaw: async () => sendResult,
        deliver: async () => {},
      }),
    },
  });
  ({ handleAction } = await import("./handler.js"));
  setYuanbaoRuntime({} as PluginRuntime);
  setActiveWsClient("default", {} as never);
});

afterEach(() => {
  mock.restoreAll();
  setActiveWsClient("default", null);
  setYuanbaoRuntime(null as unknown as PluginRuntime);
});

void test("send action dispatches a text item and returns ok", async () => {
  const res = await handleAction({ cfg, to: "user:u-1", params: { action: "send", message: "hello" } });
  assert.equal(res.ok, true);
  assert.equal(res.messageId, "m-1");
  assert.equal(sentItems.length, 1);
  assert.equal(sentItems[0].type, "text");
});

void test("send action with text + media dispatches both items", async () => {
  await handleAction({ cfg, to: "user:u-1", params: { action: "send", message: "look", mediaUrls: ["http://a.png", "http://b.png"] } });
  assert.equal(sentItems.filter(i => i.type === "text").length, 1);
  assert.equal(sentItems.filter(i => i.type === "media").length, 2);
});

void test("sticker action dispatches a sticker item", async () => {
  await handleAction({ cfg, to: "user:u-1", params: { action: "sticker", stickerId: "s-9" } });
  assert.equal(sentItems.length, 1);
  assert.equal(sentItems[0].type, "sticker");
});

void test("empty resolvable items returns ok:false", async () => {
  const res = await handleAction({ cfg, to: "user:u-1", params: { action: "send", message: "   " } });
  assert.equal(res.ok, false);
  assert.match(res.error!.message, /no sendable items/);
});

void test("text send failure returns ok:false with the error", async () => {
  sendResult = { ok: false, error: "ws down" };
  const res = await handleAction({ cfg, to: "user:u-1", params: { action: "send", message: "hi" } });
  assert.equal(res.ok, false);
  assert.match(res.error!.message, /ws down/);
});

void test("missing runtime surfaces an error result", async () => {
  setYuanbaoRuntime(null as unknown as PluginRuntime);
  const res = await handleAction({ cfg, to: "user:u-1", params: { action: "send", message: "hi" } });
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

void test("missing active WS client surfaces an error result", async () => {
  setActiveWsClient("default", null);
  const res = await handleAction({ cfg, to: "user:u-1", params: { action: "send", message: "hi" } });
  assert.equal(res.ok, false);
  assert.ok(res.error);
});
