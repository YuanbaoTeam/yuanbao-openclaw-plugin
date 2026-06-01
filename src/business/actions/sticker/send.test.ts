/**
 * Unit tests for actions/sticker/send.ts — buildStickerMsgBody (pure),
 * sendSticker (cache lookup → deliver), and searchSticker (query/limit
 * normalization). sticker-cache + deliver are mocked.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import type { DeliverTarget } from "../deliver.js";
import type { ResolvedYuanbaoAccount } from "../../../types.js";
import type { YuanbaoWsClient } from "../../../access/ws/client.js";

let delivered: unknown[];
let searchArgs: { query: string; limit: number } | null;
let cached: Record<string, unknown> | null;
let mod: typeof import("./send.js");

beforeEach(async () => {
  delivered = [];
  searchArgs = null;
  cached = { sticker_id: "s-1", package_id: "p-1", name: "smile", width: 100, height: 100, formats: "webp" };
  mock.module("./sticker-cache.js", {
    namedExports: {
      getCachedSticker: () => cached,
      searchStickers: (query: string, limit: number) => { searchArgs = { query, limit }; return [{ sticker_id: "s-1" }]; },
    },
  });
  mock.module("../deliver.js", { namedExports: { deliver: async (_dt: DeliverTarget, body: unknown[]) => { delivered.push(body); return { ok: true }; } } });
  mod = await import("./send.js");
});

afterEach(() => mock.restoreAll());

const dt: DeliverTarget = { isGroup: false, target: "u-1", account: {} as ResolvedYuanbaoAccount, wsClient: {} as YuanbaoWsClient };

void test("buildStickerMsgBody builds a TIMFaceElem with packed sticker data", () => {
  const body = mod.buildStickerMsgBody({ sticker_id: "s-1", package_id: "p-1", name: "smile", width: 50, height: 60, formats: "webp" } as never);
  assert.equal(body[0].msg_type, "TIMFaceElem");
  const data = JSON.parse(body[0].msg_content!.data as string);
  assert.equal(data.sticker_id, "s-1");
  assert.equal(data.width, 50);
  assert.deepEqual(data.formats, ["webp"]);
});

void test("sendSticker delivers when the sticker is in cache", async () => {
  const r = await mod.sendSticker({ stickerId: "s-1", dt });
  assert.equal(r.ok, true);
  assert.equal(delivered.length, 1);
});

void test("sendSticker returns an error when the sticker is missing", async () => {
  cached = null;
  const r = await mod.sendSticker({ stickerId: "missing", dt });
  assert.equal(r.ok, false);
  assert.equal(delivered.length, 0);
});

void test("searchSticker normalizes query aliases and limit", () => {
  const r = mod.searchSticker({ keyword: "happy", limit: "5" });
  assert.equal(r.ok, true);
  assert.deepEqual(searchArgs, { query: "happy", limit: 5 });
});

void test("searchSticker defaults limit to 10 and empty query when absent", () => {
  mod.searchSticker({});
  assert.deepEqual(searchArgs, { query: "", limit: 10 });
});
