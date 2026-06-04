/**
 * Unit tests for outbound/create-sender.ts — the MessageSender factory wiring.
 * The underlying action senders are mocked so we assert send()'s type dispatch
 * and deliver()'s text-then-media ordering.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import type { SendParams } from "./types.js";

let calls: string[];
let createMessageSender: typeof import("./create-sender.js").createMessageSender;

beforeEach(async () => {
  calls = [];
  mock.module("../actions/text/send.js", { namedExports: { sendText: async (a: { text: string }) => { calls.push(`text:${a.text}`); return { ok: true }; } } });
  mock.module("../actions/media/send.js", { namedExports: { sendMedia: async (a: { mediaUrl: string }) => { calls.push(`media:${a.mediaUrl}`); return { ok: true }; } } });
  mock.module("../actions/sticker/send.js", { namedExports: { sendSticker: async (a: { stickerId: string }) => { calls.push(`sticker:${a.stickerId}`); return { ok: true }; } } });
  mock.module("../actions/deliver.js", { namedExports: { deliver: async () => { calls.push("raw"); return { ok: true }; } } });
  mock.module("openclaw/plugin-sdk/reply-payload", { namedExports: { resolveOutboundMediaUrls: (p: { mediaUrls?: string[] }) => p.mediaUrls ?? [] } });
  ({ createMessageSender } = await import("./create-sender.js"));
});

afterEach(() => mock.restoreAll());

function params(): SendParams {
  return { isGroup: false, account: {}, target: "u-1", wsClient: {}, core: {}, config: {} } as unknown as SendParams;
}

void test("send() dispatches text/media/sticker/raw by item type", async () => {
  const s = createMessageSender(params());
  await s.send({ type: "text", text: "hi" });
  await s.send({ type: "media", mediaUrl: "http://x" });
  await s.send({ type: "sticker", stickerId: "s1" });
  await s.send({ type: "raw", msgBody: [] });
  assert.deepEqual(calls, ["text:hi", "media:http://x", "sticker:s1", "raw"]);
});

void test("send() throws on an unknown item type", async () => {
  const s = createMessageSender(params());
  await assert.rejects(s.send({ type: "bogus" } as never), /Unknown outbound item type/);
});

void test("deliver() sends text first, then each media url", async () => {
  const s = createMessageSender(params());
  await s.deliver({ text: "caption", mediaUrls: ["http://a", "http://b"] } as never);
  assert.deepEqual(calls, ["text:caption", "media:http://a", "media:http://b"]);
});

void test("deliver() with blank text only sends media", async () => {
  const s = createMessageSender(params());
  await s.deliver({ text: "  ", mediaUrls: ["http://a"] } as never);
  assert.deepEqual(calls, ["media:http://a"]);
});
