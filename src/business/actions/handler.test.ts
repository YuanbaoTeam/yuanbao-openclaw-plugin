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
import { resolveTraceContext, runWithTraceContext } from "../trace/context.js";

let sentItems: OutboundItem[];
let sendResult: SendResult;
let queuedSendOutcomes: Array<SendResult | Error>;
let handleAction: typeof import("./handler.js").handleAction;

const cfg = {} as ActionParams["cfg"];

beforeEach(async () => {
  sentItems = [];
  sendResult = { ok: true, messageId: "m-1" };
  queuedSendOutcomes = [];
  mock.module("../outbound/create-sender.js", {
    namedExports: {
      createMessageSender: () => ({
        send: async (item: OutboundItem) => {
          sentItems.push(item);
          const outcome = queuedSendOutcomes.shift() ?? sendResult;
          if (outcome instanceof Error) {
            throw outcome;
          }
          return outcome;
        },
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

void test("media send failures do not abort remaining items but return ok:false", async () => {
  sendResult = { ok: false, error: "media boom" };
  const res = await handleAction({ cfg, to: "user:u-1", params: { action: "send", mediaUrls: ["http://a", "http://b"] } });
  assert.equal(res.ok, false);
  assert.match(res.error!.message, /media boom/);
  assert.equal(sentItems.filter(i => i.type === "media").length, 2);
});

void test("partial media failure preserves the last successful message id", async () => {
  queuedSendOutcomes = [
    { ok: false, error: "first media failed" },
    { ok: true, messageId: "m-2" },
  ];
  const trace = resolveTraceContext({ traceId: "t-partial-media" });

  const res = await runWithTraceContext(trace, async () => {
    return handleAction({ cfg, to: "user:u-1", params: { action: "send", mediaUrls: ["http://a", "http://b"] } });
  });

  assert.equal(res.ok, false);
  assert.equal(res.messageId, "m-2");
  assert.match(res.error!.message, /first media failed/);
  assert.equal(sentItems.filter(i => i.type === "media").length, 2);
  assert.equal(trace.hasActionDelivered(), true);
});

void test("a thrown media error does not abort remaining items", async () => {
  const expectedError = new Error("second media threw");
  queuedSendOutcomes = [
    { ok: true, messageId: "m-1" },
    expectedError,
    { ok: true, messageId: "m-3" },
  ];

  const res = await handleAction({
    cfg,
    to: "user:u-1",
    params: { action: "send", mediaUrls: ["http://a", "http://b", "http://c"] },
  });

  assert.equal(res.ok, false);
  assert.equal(res.messageId, "m-3");
  assert.equal(res.error, expectedError);
  assert.equal(sentItems.filter(i => i.type === "media").length, 3);
});

void test("text success followed by media failure reports partial delivery", async () => {
  queuedSendOutcomes = [
    { ok: true, messageId: "m-text" },
    { ok: false, error: "media failed" },
  ];
  const trace = resolveTraceContext({ traceId: "t-text-media" });

  const res = await runWithTraceContext(trace, async () => {
    return handleAction({
      cfg,
      to: "user:u-1",
      params: { action: "send", message: "caption", mediaUrls: ["http://a"] },
    });
  });

  assert.equal(res.ok, false);
  assert.equal(res.messageId, "m-text");
  assert.match(res.error!.message, /media failed/);
  assert.deepEqual(sentItems.map(item => item.type), ["text", "media"]);
  assert.equal(trace.hasActionDelivered(), true);
});

void test("unresolvable target surfaces an error result", async () => {
  const res = await handleAction({ cfg, params: { action: "send", message: "hi" } }); // no to/target/context
  assert.equal(res.ok, false);
  assert.ok(res.error);
});

void test("sticker-search short-circuits without creating a sender", async () => {
  const res = await handleAction({ cfg, to: "user:u-1", params: { action: "sticker-search", query: "smile" } });
  assert.equal(res.channel, "yuanbao");
  assert.equal(typeof res.ok, "boolean");
  assert.equal(sentItems.length, 0);
});

void test("action read from top-level input + single mediaUrl branch", async () => {
  // no params.action → falls back to input.action; single `mediaUrl` (not mediaUrls)
  await handleAction({ cfg, to: "user:u-1", action: "send", params: { mediaUrl: "http://one.png" } } as never);
  assert.equal(sentItems.filter(i => i.type === "media").length, 1);
});

void test("react action with sticker_id as an array dispatches a sticker", async () => {
  await handleAction({ cfg, to: "user:u-1", params: { action: "react", sticker_id: ["s-9", "s-10"] } });
  assert.equal(sentItems.length, 1);
  assert.equal(sentItems[0].type, "sticker");
});

void test("successful action send marks the active trace context as delivered", async () => {
  const trace = resolveTraceContext({ traceId: "t-1" });
  assert.equal(trace.hasActionDelivered(), false);

  await runWithTraceContext(trace, async () => {
    await handleAction({ cfg, to: "user:u-1", params: { action: "sticker", stickerId: "s-9" } });
  });

  assert.equal(trace.hasActionDelivered(), true);
});

void test("failed sticker send does not mark the trace context as delivered", async () => {
  sendResult = { ok: false, error: "sticker boom" };
  const trace = resolveTraceContext({ traceId: "t-2" });

  const result = await runWithTraceContext(trace, async () => {
    return handleAction({ cfg, to: "user:u-1", params: { action: "sticker", stickerId: "s-9" } });
  });

  assert.equal(result.ok, false);
  assert.match(result.error!.message, /sticker boom/);
  assert.equal(trace.hasActionDelivered(), false);
});
