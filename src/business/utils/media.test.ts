/**
 * Unit tests for media.ts: computeUrlCacheKey, sanitizeMediaFilename,
 * and downloadMediasToLocalFiles caching behaviour.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, existsSync } from "node:fs";

import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  computeUrlCacheKey,
  downloadMediasToLocalFiles,
  sanitizeMediaFilename,
} from "./media.js";

// ---------------------------------------------------------------------------
// computeUrlCacheKey
// ---------------------------------------------------------------------------

function md5(s: string): string {
  return createHash("md5").update(Buffer.from(s)).digest("hex");
}

void test("computeUrlCacheKey: strips query params and hashes origin+pathname", () => {
  const cosUrl = "https://ybim.example.com/multimedia_13/abc/20260101_file.pdf"
    + "?q-sign-algorithm=sha1&q-ak=AK&q-sign-time=100%3B200&q-signature=SIG";

  const key = computeUrlCacheKey(cosUrl);

  const expected = md5("https://ybim.example.com/multimedia_13/abc/20260101_file.pdf");
  assert.equal(key, expected);
});

void test("computeUrlCacheKey: same path, different signatures → same key", () => {
  const base = "https://cos.example.com/bucket/path/doc.pdf";
  const key1 = computeUrlCacheKey(`${base}?q-sign-time=111&q-signature=AAA`);
  const key2 = computeUrlCacheKey(`${base}?q-sign-time=222&q-signature=BBB`);

  assert.equal(key1, key2);
});

void test("computeUrlCacheKey: different paths → different keys", () => {
  const key1 = computeUrlCacheKey("https://cos.example.com/bucket/a.pdf");
  const key2 = computeUrlCacheKey("https://cos.example.com/bucket/b.pdf");

  assert.notEqual(key1, key2);
});

void test("computeUrlCacheKey: returns 32-char hex string", () => {
  const key = computeUrlCacheKey("https://cos.example.com/bucket/file.jpg?q-sign=X");

  assert.match(key, /^[0-9a-f]{32}$/);
});

void test("computeUrlCacheKey: handles invalid URL gracefully", () => {
  const key = computeUrlCacheKey("not-a-valid-url");

  assert.match(key, /^[0-9a-f]{32}$/);
});

// ---------------------------------------------------------------------------
// sanitizeMediaFilename
// ---------------------------------------------------------------------------

void test("sanitizeMediaFilename: empty/undefined → fallback", () => {
  assert.equal(sanitizeMediaFilename(undefined, "fallback"), "fallback");
  assert.equal(sanitizeMediaFilename("", "fallback"), "fallback");
  assert.equal(sanitizeMediaFilename("   ", "fallback"), "fallback");
});

void test("sanitizeMediaFilename: dot / dotdot → fallback (path traversal protection)", () => {
  assert.equal(sanitizeMediaFilename(".", "fallback"), "fallback");
  assert.equal(sanitizeMediaFilename("..", "fallback"), "fallback");
  assert.equal(sanitizeMediaFilename("../../etc/passwd", "fallback"), "passwd");
  assert.equal(sanitizeMediaFilename("..\\..\\windows\\system32", "fallback"), "system32");
});

void test("sanitizeMediaFilename: strips path separators via basename", () => {
  assert.equal(sanitizeMediaFilename("a/b/c.jpg", "fallback"), "c.jpg");
  assert.equal(sanitizeMediaFilename("a\\b\\c.jpg", "fallback"), "c.jpg");
});

void test("sanitizeMediaFilename: replaces placeholder-breaking chars", () => {
  assert.equal(sanitizeMediaFilename("[image].jpg", "fallback"), "_image_.jpg");
});

void test("sanitizeMediaFilename: replaces Windows-illegal chars (<>:|\"*?)", () => {
  assert.equal(sanitizeMediaFilename("a<b>c.jpg", "fallback"), "a_b_c.jpg");
  assert.equal(sanitizeMediaFilename("a:b|c.jpg", "fallback"), "a_b_c.jpg");
  assert.equal(sanitizeMediaFilename("a\"b*c?.jpg", "fallback"), "a_b_c_.jpg");
});

void test("sanitizeMediaFilename: replaces control chars", () => {
  assert.equal(sanitizeMediaFilename("a\x00b\x1fc\x7f.jpg", "fallback"), "a_b_c_.jpg");
});

void test("sanitizeMediaFilename: trims to FILENAME_MAX_LEN, preserves extension", () => {
  const longStem = "a".repeat(200);
  const out = sanitizeMediaFilename(`${longStem}.png`, "fallback");
  assert.ok(out.length <= 120, `length should be <=120, got ${out.length}`);
  assert.ok(out.endsWith(".png"), "extension should be preserved");
});

void test("sanitizeMediaFilename: preserves CJK and unicode chars", () => {
  assert.equal(sanitizeMediaFilename("报告_2026.pdf", "fallback"), "报告_2026.pdf");
  assert.equal(sanitizeMediaFilename("名稱.png", "fallback"), "名稱.png");
});

void test("sanitizeMediaFilename: all-unsafe input collapses to underscore", () => {
  assert.equal(sanitizeMediaFilename("<>:|", "fallback"), "_");
  assert.equal(sanitizeMediaFilename("***???", "fallback"), "_");
});

// ---------------------------------------------------------------------------
// downloadMediasToLocalFiles — integration tests using real temp directory
// ---------------------------------------------------------------------------

/** Create a real temp directory that cleans up after test. */
function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "media-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Mock account with mediaMaxMb. */
const mockAccount = { mediaMaxMb: 20 } as any;

void test("downloadMediasToLocalFiles: empty input returns empty arrays", async () => {
  const result = await downloadMediasToLocalFiles([], mockAccount);

  assert.deepEqual(result.mediaPaths, []);
  assert.deepEqual(result.mediaTypes, []);
  assert.deepEqual(result.results, []);
});

void test("downloadMediasToLocalFiles: cache miss saves to {cacheKey}/{filename}", async () => {
  const { dir, cleanup } = makeTempDir();

  // Patch resolvePreferredOpenClawTmpDir — we test via integration by pointing cacheDir manually.
  // We intercept globalThis.fetch instead.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_input: RequestInfo | URL) => {
    return {
      ok: true,
      headers: {
        get: (h: string) => {
          if (h === "content-length") { return "5"; }
          if (h === "content-type") { return "application/pdf"; }
          if (h === "content-disposition") { return ""; }
          return null;
        },
      },
      arrayBuffer: async () => Buffer.from("hello").buffer,
    } as unknown as Response;
  };

  try {
    // Override the cache dir used internally by pointing to our tmp dir via env trick.
    // Since we can't inject the cacheDir, we instead verify the key shape via a real download.
    const result = await downloadMediasToLocalFiles(
      [{ url: "https://cos.example.com/bucket/path/report.pdf", mediaName: "report.pdf" }],
      mockAccount,
    );

    assert.equal(result.mediaPaths.length, 1);

    const savedPath = result.mediaPaths[0];
    const segments = savedPath.split(/[/\\]/);
    const filename = segments[segments.length - 1];
    const cacheKeyDir = segments[segments.length - 2];

    // Filename should be preserved
    assert.equal(filename, "report.pdf");
    // Cache key directory should be 32-char hex
    assert.match(cacheKeyDir, /^[0-9a-f]{32}$/, `cache dir should be MD5 hex, got: ${cacheKeyDir}`);
    // File should exist on disk
    assert.ok(existsSync(savedPath), `file should exist at: ${savedPath}`);
  } finally {
    globalThis.fetch = originalFetch;
    cleanup();
  }
});

void test("downloadMediasToLocalFiles: two URLs with same path but different sigs → same cache dir", async () => {
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input: RequestInfo | URL) => {
    fetchCount++;
    return {
      ok: true,
      headers: {
        get: (h: string) => {
          if (h === "content-type") { return "application/pdf"; }
          return null;
        },
      },
      arrayBuffer: async () => Buffer.from("same-content").buffer,
    } as unknown as Response;
  };

  try {
    const base = "https://cos.example.com/stable/path/shared.pdf";
    const result = await downloadMediasToLocalFiles(
      [
        { url: `${base}?q-sign-time=111&q-signature=AAA`, mediaName: "shared.pdf" },
        { url: `${base}?q-sign-time=222&q-signature=BBB`, mediaName: "shared.pdf" },
      ],
      mockAccount,
    );

    assert.equal(result.mediaPaths.length, 2);

    const dir1 = result.mediaPaths[0].split(/[/\\]/).slice(0, -1).join("/");
    const dir2 = result.mediaPaths[1].split(/[/\\]/).slice(0, -1).join("/");
    assert.equal(dir1, dir2, "same COS path should map to same cache directory");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

void test("downloadMediasToLocalFiles: cache hit skips fetch on second call", async () => {
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async (_input: RequestInfo | URL) => {
    fetchCount++;
    return {
      ok: true,
      headers: {
        get: (h: string) => {
          if (h === "content-type") { return "image/jpeg"; }
          return null;
        },
      },
      arrayBuffer: async () => Buffer.from("img-data").buffer,
    } as unknown as Response;
  };

  try {
    // Use a unique path per run to avoid interference from previous test runs' cached files.
    const runId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const url = `https://cos.example.com/cache-test-${runId}/photo.jpg?q-sign-time=100&q-signature=ABC`;
    const opts = [{ url, mediaName: "photo.jpg" }];

    // First download
    const result1 = await downloadMediasToLocalFiles(opts, mockAccount);
    const countAfterFirst = fetchCount;

    // Second download — same URL, file already on disk
    const result2 = await downloadMediasToLocalFiles(opts, mockAccount);
    const countAfterSecond = fetchCount;

    assert.equal(result1.mediaPaths[0], result2.mediaPaths[0], "both calls should return same path");
    assert.equal(countAfterFirst, 1, "fetch should be called once on first download");
    assert.equal(countAfterSecond, 1, "fetch should NOT be called again on cache hit");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
