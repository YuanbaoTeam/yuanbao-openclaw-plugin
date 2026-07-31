/**
 * Unit tests for resolveFetchUrl in utils/media.ts.
 *
 * Covers the regression where resourceId exchange path matching used exact
 * equality (`=== "/api/resource/download"`) instead of prefix matching
 * (`startsWith("/api/resource/")`), causing `/api/resource/v1/download` to
 * never match → resourceId exchange skipped → fetch of un-authed Yuanbao API
 * URL (401) → agent lost file contents.
 *
 * `apiGetDownloadUrl` is mocked so no real HTTP call is made.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ResolvedYuanbaoAccount } from "../../types.js";

const FAKE_ACCOUNT = {} as ResolvedYuanbaoAccount;

let mockCallCount = 0;
let mockReturnUrl = "https://cos.example.com/real-url";
let mockRegistered = false;

function setupMock(t: any) {
  if (!mockRegistered) {
    t.mock.module("../../access/api.js", {
      namedExports: {
        // media.ts imports both; the mock must provide the full surface.
        apiGetDownloadUrl: async (_acct: unknown, _resourceId: string) => {
          mockCallCount++;
          return mockReturnUrl;
        },
        apiGetUploadInfo: async () => { throw new Error("apiGetUploadInfo should not be called here"); },
      },
    });
    mockRegistered = true;
  }
}

void test("resolveFetchUrl: passes through unchanged when no account", async (t) => {
  setupMock(t);
  const { resolveFetchUrl } = await import("./media.js");
  mockCallCount = 0;
  const url = "https://yuanbao.example.com/api/resource/v1/download?resourceId=abc";
  assert.equal(await resolveFetchUrl(url, undefined), url);
  assert.equal(mockCallCount, 0, "must not call apiGetDownloadUrl without account");
});

void test("resolveFetchUrl: passes through non-resource URLs unchanged", async (t) => {
  setupMock(t);
  const { resolveFetchUrl } = await import("./media.js");
  mockCallCount = 0;
  const url = "https://example.com/other/path?resourceId=abc";
  assert.equal(await resolveFetchUrl(url, FAKE_ACCOUNT), url);
  assert.equal(mockCallCount, 0, "must not call apiGetDownloadUrl for non-resource path");
});

void test("resolveFetchUrl: passes through invalid URL strings unchanged", async (t) => {
  setupMock(t);
  const { resolveFetchUrl } = await import("./media.js");
  mockCallCount = 0;
  assert.equal(await resolveFetchUrl("not a url", FAKE_ACCOUNT), "not a url");
  assert.equal(mockCallCount, 0, "must not call apiGetDownloadUrl for invalid URL");
});

void test("resolveFetchUrl: exchanges resourceId for /api/resource/v1/download via prefix match", async (t) => {
  setupMock(t);
  const { resolveFetchUrl } = await import("./media.js");
  mockCallCount = 0;
  mockReturnUrl = "https://cos.example.com/exchanged-doc.pdf";
  const resolved = await resolveFetchUrl(
    "https://yuanbao.example.com/api/resource/v1/download?resourceId=doc-123",
    FAKE_ACCOUNT,
  );
  assert.equal(resolved, "https://cos.example.com/exchanged-doc.pdf");
  assert.equal(mockCallCount, 1, "must call apiGetDownloadUrl for versioned resource download endpoint");
});

void test("resolveFetchUrl: also matches legacy /api/resource/download path", async (t) => {
  setupMock(t);
  const { resolveFetchUrl } = await import("./media.js");
  mockCallCount = 0;
  mockReturnUrl = "https://cos.example.com/legacy.pdf";
  const resolved = await resolveFetchUrl(
    "https://yuanbao.example.com/api/resource/download?resourceId=legacy-1",
    FAKE_ACCOUNT,
  );
  assert.equal(resolved, "https://cos.example.com/legacy.pdf");
  assert.equal(mockCallCount, 1, "prefix match should also cover the legacy unversioned path");
});
