/**
 * Unit tests for infra/cos.ts — COS PUT Object client. `fetch` is stubbed so the
 * signing path (signCosRequest) and header assembly are exercised offline.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import type { CosUploadConfig } from "../access/api.js";
import { createCosClient } from "./cos.js";

const realFetch = globalThis.fetch;
let lastCall: { url: string; init: RequestInit } | null;

function stubFetch(make: () => Response) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    lastCall = { url: String(url), init };
    return make();
  }) as typeof fetch;
}

function baseConfig(over: Partial<CosUploadConfig> = {}): CosUploadConfig {
  return {
    bucketName: "b", region: "ap-guangzhou", location: "", resourceUrl: "",
    encryptTmpSecretId: "AKID-test", encryptTmpSecretKey: "secret-key", encryptToken: "",
    startTime: 1_700_000_000, expiredTime: 1_700_003_600,
    ...over,
  } as CosUploadConfig;
}

beforeEach(() => { lastCall = null; });
afterEach(() => { globalThis.fetch = realFetch; });

void test("putObject signs the request and omits Host/Content-Length from wire headers", async () => {
  stubFetch(() => new Response("", { status: 200 }));
  const client = createCosClient(baseConfig());
  await client.putObject({ Bucket: "b", Region: "ap-guangzhou", Key: "path/to/file.png", Body: Buffer.from("hi"), Headers: { "Content-Type": "image/png" } });

  assert.ok(lastCall);
  assert.equal(lastCall.url, "https://b.cos.ap-guangzhou.myqcloud.com/path/to/file.png");
  const headers = lastCall.init.headers as Record<string, string>;
  assert.match(headers.Authorization, /q-sign-algorithm=sha1/);
  assert.match(headers.Authorization, /q-signature=[0-9a-f]+/);
  assert.equal(headers["Content-Type"], "image/png");
  assert.equal("host" in headers || "Host" in headers, false);
  assert.equal("content-length" in headers, false);
});

void test("putObject prefixes a leading slash to keys without one", async () => {
  stubFetch(() => new Response("", { status: 200 }));
  await createCosClient(baseConfig()).putObject({ Bucket: "b", Region: "ap-guangzhou", Key: "nolead.png", Body: Buffer.from("x") });
  assert.match(lastCall!.url, /\/nolead\.png$/);
});

void test("putObject adds x-cos-security-token when encryptToken set", async () => {
  stubFetch(() => new Response("", { status: 200 }));
  await createCosClient(baseConfig({ encryptToken: "tok-123" })).putObject({ Bucket: "b", Region: "ap-guangzhou", Key: "k", Body: Buffer.from("x") });
  const headers = lastCall!.init.headers as Record<string, string>;
  assert.equal(headers["x-cos-security-token"], "tok-123");
  assert.match(headers.Authorization, /q-header-list=[^&]*x-cos-security-token/);
});

void test("putObject throws a wrapped error on non-ok response", async () => {
  stubFetch(() => new Response("denied", { status: 403 }));
  await assert.rejects(
    createCosClient(baseConfig()).putObject({ Bucket: "b", Region: "ap-guangzhou", Key: "k", Body: Buffer.from("x") }),
    /COS upload failed: 403/,
  );
});

void test("putObject throws a network error when fetch rejects", async () => {
  globalThis.fetch = (async () => { throw new Error("boom"); }) as typeof fetch;
  await assert.rejects(
    createCosClient(baseConfig()).putObject({ Bucket: "b", Region: "ap-guangzhou", Key: "k", Body: Buffer.from("x") }),
    /network error/,
  );
});
