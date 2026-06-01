/**
 * Unit tests for access/http/request.ts — sign-token (签票), HMAC signature,
 * auth headers, token cache, and HTTP wrappers.
 *
 * `fetch` is stubbed per-test. Timers are mocked where the retry/refresh delays
 * would otherwise fire. SIGN-001 golden values are inlined (no cross-repo dep).
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import {
  clearAllSignTokenCache,
  computeSignature,
  getAuthHeaders,
  getSignToken,
  getTokenStatus,
  verifySignature,
  yuanbaoGet,
  yuanbaoPost,
} from "./request.js";
import type { ResolvedYuanbaoAccount } from "../../types.js";

function makeAccount(over: Record<string, unknown> = {}): ResolvedYuanbaoAccount {
  return {
    accountId: "acc-1",
    appKey: "k",
    appSecret: "s",
    apiDomain: "api.test",
    botId: "",
    enabled: true,
    configured: true,
    name: "bot",
    config: {},
    ...over,
  } as unknown as ResolvedYuanbaoAccount;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const realFetch = globalThis.fetch;
let fetchCalls: Array<{ url: string; init?: RequestInit }>;

/** Install a fetch stub that returns queued responses (last one repeats). */
function stubFetch(responses: Array<() => Response>) {
  let i = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), init });
    const make = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return make();
  }) as typeof fetch;
}

beforeEach(() => {
  fetchCalls = [];
  clearAllSignTokenCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearAllSignTokenCache();
  mock.timers.reset();
});

// ── SIGN-001 golden (values inlined from yuanbao-bot-spec) ──────────────────
const SIGN_001 = [
  { id: "basic-ascii", nonce: "0123456789abcdef0123456789abcdef", timestamp: "2025-01-15T10:00:00+08:00", appKey: "test_app_key", appSecret: "test_app_secret", expected: "5cd75b6e709029798c76b8ba8f9308e96aead669c694dd39168c10718f646acb" },
  { id: "empty-secret", nonce: "0123456789abcdef0123456789abcdef", timestamp: "2025-01-15T10:00:00+08:00", appKey: "test_app_key", appSecret: "", expected: "50f3ef182db6e9231698f31472ed5ebb1a2d1db33d42885788657ed294841d42" },
  { id: "unicode-key", nonce: "abcdef0123456789abcdef0123456789", timestamp: "2025-12-31T23:59:59+08:00", appKey: "元宝-bot-名", appSecret: "pässwörd", expected: "a358bab4bce7479b7e9e4673fe90a542df6302c9d0e7dc838428acbc0720d7c9" },
  { id: "special-chars", nonce: "ffffffffffffffffffffffffffffffff", timestamp: "2026-05-25T16:30:00+08:00", appKey: "key with spaces", appSecret: "secret/with+symbols=", expected: "c963a5dd4e21b0bacc6c99e4d60696e4b497d3dd2305c579bf23e4887b29813d" },
];

for (const c of SIGN_001) {
  void test(`SIGN-001 golden: ${c.id}`, () => {
    assert.equal(computeSignature({ nonce: c.nonce, timestamp: c.timestamp, appKey: c.appKey, appSecret: c.appSecret }), c.expected);
  });
}

void test("verifySignature: equal / mismatch / different length", () => {
  const a = "5cd75b6e709029798c76b8ba8f9308e96aead669c694dd39168c10718f646acb";
  const b = "50f3ef182db6e9231698f31472ed5ebb1a2d1db33d42885788657ed294841d42";
  assert.equal(verifySignature(a, a), true);
  assert.equal(verifySignature(a, b), false);
  assert.equal(verifySignature(a, "abcd"), false);
});

// ── token status / static token ─────────────────────────────────────────────
void test("getTokenStatus returns none when nothing cached", () => {
  assert.deepEqual(getTokenStatus("acc-1"), { status: "none", expiresAt: null });
});

void test("getSignToken short-circuits on static token (no fetch)", async () => {
  const account = makeAccount({ token: "static-tok", botId: "bot-9" });
  const data = await getSignToken(account);
  assert.equal(data.token, "static-tok");
  assert.equal(data.bot_id, "bot-9");
  assert.equal(fetchCalls.length, 0);
});

// ── sign-token fetch flow ─────────────────────────────────────────────────────
void test("getSignToken fetches, caches, and reuses cache on second call", () => {
  mock.timers.enable({ apis: ["setTimeout"] }); // swallow the refresh timer
  stubFetch([() => jsonResponse({ code: 0, msg: "ok", data: { bot_id: "bot-1", duration: 3600, product: "yuanbao", source: "bot", token: "tok-1" } })]);

  return (async () => {
    const account = makeAccount();
    const first = await getSignToken(account);
    assert.equal(first.token, "tok-1");
    assert.equal(getTokenStatus("acc-1").status, "valid");

    const second = await getSignToken(account);
    assert.equal(second.token, "tok-1");
    assert.equal(fetchCalls.length, 1, "second call must hit cache, not fetch");

    // request body carries the signed fields
    const body = JSON.parse(String(fetchCalls[0].init?.body));
    assert.equal(body.app_key, "k");
    assert.equal(typeof body.signature, "string");
    assert.equal(body.signature.length, 64);
  })();
});

void test("getSignToken throws when appKey/appSecret missing", async () => {
  stubFetch([() => jsonResponse({ code: 0, data: {} })]);
  await assert.rejects(getSignToken(makeAccount({ appKey: "", appSecret: "" })), /missing appKey or appSecret/);
});

void test("getSignToken throws on HTTP error", async () => {
  stubFetch([() => new Response("nope", { status: 500, statusText: "Server Error" })]);
  await assert.rejects(getSignToken(makeAccount()), /sign-token HTTP error: 500/);
});

void test("getSignToken throws on non-retryable business error", async () => {
  stubFetch([() => jsonResponse({ code: 40001, msg: "bad", data: {} })]);
  await assert.rejects(getSignToken(makeAccount()), /code=40001/);
});

void test("getSignToken retries on retryable code 10099 then succeeds", async () => {
  // Real timer: the retry delay (~1s) is short enough; using fake timers here is
  // race-prone because the setTimeout is registered mid-async-flow. duration:0 on
  // success means no refresh timer is scheduled, so nothing leaks.
  stubFetch([
    () => jsonResponse({ code: 10099, msg: "retry", data: {} }),
    () => jsonResponse({ code: 0, msg: "ok", data: { bot_id: "bot-2", duration: 0, product: "yuanbao", source: "bot", token: "tok-2" } }),
  ]);
  const data = await getSignToken(makeAccount());
  assert.equal(data.token, "tok-2");
  assert.equal(fetchCalls.length, 2);
});

void test("getSignToken singleflight: concurrent calls fetch once", () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  stubFetch([() => jsonResponse({ code: 0, data: { bot_id: "b", duration: 3600, product: "yuanbao", source: "bot", token: "tok-sf" }, msg: "ok" })]);

  return (async () => {
    const account = makeAccount();
    const [a, b] = await Promise.all([getSignToken(account), getSignToken(account)]);
    assert.equal(a.token, "tok-sf");
    assert.equal(b.token, "tok-sf");
    assert.equal(fetchCalls.length, 1);
  })();
});

// ── auth headers ──────────────────────────────────────────────────────────────
void test("getAuthHeaders builds headers, backfills botId, includes routeEnv", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  stubFetch([() => jsonResponse({ code: 0, data: { bot_id: "bot-h", duration: 3600, product: "yuanbao", source: "web", token: "tok-h" }, msg: "ok" })]);

  const account = makeAccount({ config: { routeEnv: "test-env" } });
  const headers = await getAuthHeaders(account);
  assert.equal(headers["X-ID"], "bot-h");
  assert.equal(headers["X-Token"], "tok-h");
  assert.equal(headers["X-Route-Env"], "test-env");
  assert.equal(account.botId, "bot-h"); // backfilled
});

// ── HTTP wrappers ─────────────────────────────────────────────────────────────
void test("yuanbaoPost returns data on success", async () => {
  const account = makeAccount({ token: "static" }); // static token → no sign fetch
  stubFetch([() => jsonResponse({ code: 0, data: { ok: true }, msg: "ok" })]);
  const res = await yuanbaoPost<{ ok: boolean }>(account, "/x", { a: 1 });
  assert.deepEqual(res, { ok: true });
});

void test("yuanbaoPost retries once on 401 then succeeds", async () => {
  const account = makeAccount({ token: "static" });
  stubFetch([
    () => new Response("unauth", { status: 401 }),
    () => jsonResponse({ code: 0, data: { ok: 1 }, msg: "ok" }),
  ]);
  const res = await yuanbaoPost<{ ok: number }>(account, "/x", {});
  assert.deepEqual(res, { ok: 1 });
  assert.equal(fetchCalls.length, 2);
});

void test("yuanbaoPost throws on business error code", async () => {
  const account = makeAccount({ token: "static" });
  stubFetch([() => jsonResponse({ code: 500, msg: "boom" })]);
  await assert.rejects(yuanbaoPost(account, "/x", {}), /business error: code=500/);
});

void test("yuanbaoGet appends params and returns data", async () => {
  const account = makeAccount({ token: "static" });
  stubFetch([() => jsonResponse({ code: 0, data: { v: "y" }, msg: "ok" })]);
  const res = await yuanbaoGet<{ v: string }>(account, "/q", { a: "1", b: "2" });
  assert.deepEqual(res, { v: "y" });
  assert.match(fetchCalls[0].url, /\/q\?a=1&b=2$/);
});

void test("yuanbaoGet throws on HTTP error", async () => {
  const account = makeAccount({ token: "static" });
  stubFetch([() => new Response("err", { status: 503, statusText: "Unavailable" })]);
  await assert.rejects(yuanbaoGet(account, "/q"), /HTTP 503/);
});
