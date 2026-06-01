/**
 * Unit tests for actions/media/send.ts — download+upload, image/file body
 * selection by MIME, and text-link fallback on failure. Media utils + deliver
 * are mocked.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import type { DeliverTarget } from "../deliver.js";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { ResolvedYuanbaoAccount } from "../../../types.js";
import type { YuanbaoWsClient } from "../../../access/ws/client.js";

let delivered: unknown[];
let mime: string;
let shouldThrow: boolean;
let sendMedia: typeof import("./send.js").sendMedia;

beforeEach(async () => {
  delivered = [];
  mime = "image/png";
  shouldThrow = false;
  mock.module("../../utils/media.js", {
    namedExports: {
      downloadAndUploadMedia: async () => { if (shouldThrow) { throw new Error("download failed"); } return { url: "cos://x", filename: "f", size: 1, uuid: "u" }; },
      guessMimeType: () => mime,
      buildImageMsgBody: () => [{ kind: "image" }],
      buildFileMsgBody: () => [{ kind: "file" }],
    },
  });
  mock.module("../deliver.js", { namedExports: { deliver: async (_dt: DeliverTarget, body: unknown[]) => { delivered.push(body); return { ok: true }; } } });
  ({ sendMedia } = await import("./send.js"));
});

afterEach(() => mock.restoreAll());

const dt: DeliverTarget = { isGroup: false, target: "u-1", account: {} as ResolvedYuanbaoAccount, wsClient: {} as YuanbaoWsClient };
const core = {} as PluginRuntime;

void test("image mime builds an image body and delivers it", async () => {
  mime = "image/png";
  let fellBack = false;
  await sendMedia({ mediaUrl: "http://x.png", core, dt, sendTextFallback: async () => { fellBack = true; return { ok: true }; } });
  assert.deepEqual(delivered[0], [{ kind: "image" }]);
  assert.equal(fellBack, false);
});

void test("non-image mime builds a file body", async () => {
  mime = "application/pdf";
  await sendMedia({ mediaUrl: "http://x.pdf", core, dt, sendTextFallback: async () => ({ ok: true }) });
  assert.deepEqual(delivered[0], [{ kind: "file" }]);
});

void test("download failure falls back to a text link (with fallbackText)", async () => {
  shouldThrow = true;
  let fallbackArg = "";
  const r = await sendMedia({ mediaUrl: "http://x.png", fallbackText: "see image", core, dt, sendTextFallback: async (t) => { fallbackArg = t; return { ok: true }; } });
  assert.equal(r.ok, true);
  assert.equal(delivered.length, 0);
  assert.equal(fallbackArg, "see image\nhttp://x.png");
});
