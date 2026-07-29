/**
 * Regression tests for resolveFetchUrl resourceId → COS URL exchange.
 *
 * Covers the b4bae42 regression where the pathname match was narrowed from a
 * "/api/resource/" prefix to an exact "/api/resource/download" compare (missing
 * the real "/api/resource/v1/download" segment), so resourceId exchange never
 * fired and document downloads 401'd silently.
 *
 * Mocks apiGetDownloadUrl via t.mock.module. The mock is registered once (first
 * test) and the cached media.js reuses it; per-test behavior is controlled via
 * module-level state read at call time (same pattern as download-media.test.ts).
 */

import assert from "node:assert/strict";
import test from "node:test";

import type { ResolvedYuanbaoAccount } from "../../types.js";

const fakeAccount = { accountId: "a1" } as unknown as ResolvedYuanbaoAccount;

let exchangeCalls: Array<{ resourceId: string }> = [];
let exchangeReturn = "https://cos.example.com/default";
let mockRegistered = false;

function setupMocks(t: unknown): void {
  exchangeCalls = [];
  if (!mockRegistered) {
    (t as { mock: { module: (spec: string, def: unknown) => void } }).mock.module(
      "../../access/api.js",
      {
        namedExports: {
          apiGetDownloadUrl: async (_account: unknown, resourceId: string) => {
            exchangeCalls.push({ resourceId });
            return exchangeReturn;
          },
          // Stubbed — not exercised by resolveFetchUrl but required by media.js imports.
          apiGetUploadInfo: async () => ({}),
        },
      },
    );
    mockRegistered = true;
  }
}

void test("resolveFetchUrl: exchanges resourceId for real /api/resource/v1/download path", async (t) => {
  setupMocks(t);
  exchangeReturn = "https://cos.example.com/res-1";
  const { resolveFetchUrl } = await import("./media.js");

  const resolved = await resolveFetchUrl(
    "https://yuanbao.tencent.com/api/resource/v1/download?resourceId=res-1",
    fakeAccount,
  );

  assert.equal(resolved, "https://cos.example.com/res-1");
  assert.deepEqual(exchangeCalls, [{ resourceId: "res-1" }]);
});

void test("resolveFetchUrl: prefix match also covers legacy /api/resource/download (no /v1/)", async (t) => {
  setupMocks(t);
  exchangeReturn = "https://cos.example.com/res-2";
  const { resolveFetchUrl } = await import("./media.js");

  const resolved = await resolveFetchUrl(
    "https://yuanbao.tencent.com/api/resource/download?resourceId=res-2",
    fakeAccount,
  );

  assert.equal(resolved, "https://cos.example.com/res-2");
  assert.deepEqual(exchangeCalls, [{ resourceId: "res-2" }]);
});

void test("resolveFetchUrl: passes COS URL through without exchange", async (t) => {
  setupMocks(t);
  const { resolveFetchUrl } = await import("./media.js");

  const cosUrl = "https://cos.example.com/bucket/file.docx?q-sign-token=abc";
  const resolved = await resolveFetchUrl(cosUrl, fakeAccount);

  assert.equal(resolved, cosUrl);
  assert.equal(exchangeCalls.length, 0);
});

void test("resolveFetchUrl: resource path without resourceId param → passthrough", async (t) => {
  setupMocks(t);
  const { resolveFetchUrl } = await import("./media.js");

  const noIdUrl = "https://yuanbao.tencent.com/api/resource/v1/download";
  const resolved = await resolveFetchUrl(noIdUrl, fakeAccount);

  assert.equal(resolved, noIdUrl);
  assert.equal(exchangeCalls.length, 0);
});

void test("resolveFetchUrl: no account → passthrough (no exchange attempt)", async (t) => {
  setupMocks(t);
  const { resolveFetchUrl } = await import("./media.js");

  const url = "https://yuanbao.tencent.com/api/resource/v1/download?resourceId=res-3";
  const resolved = await resolveFetchUrl(url, undefined);

  assert.equal(resolved, url);
  assert.equal(exchangeCalls.length, 0);
});

void test("resolveFetchUrl: non-URL input → passthrough (URL ctor throws, caught)", async (t) => {
  setupMocks(t);
  const { resolveFetchUrl } = await import("./media.js");

  const resolved = await resolveFetchUrl("not-a-valid-url", fakeAccount);

  assert.equal(resolved, "not-a-valid-url");
  assert.equal(exchangeCalls.length, 0);
});
