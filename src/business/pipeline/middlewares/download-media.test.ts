/**
 * Unit tests for download-media middleware: media download, quoted media lookup, when guard.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { createMockCtx, createMockNext } from "../test-helpers/mock-ctx.js";

let mockDownloadResult = {
  mediaPaths: ["/tmp/img1.jpg"] as string[],
  mediaTypes: ["image"] as string[],
};

// Stable Map reference: t.mock.module captures this reference once at first
// registration, so we MUST mutate (clear + copy) rather than reassign to make
// per-test history data visible to the code under test.
const mockMediaHistories = new Map<string, Array<{ sender: string; messageId?: string; timestamp: number; medias: Array<{ url: string; mediaName?: string; mediaType: "image" | "file" }> }>>();
let mockRecordCalls: Array<{ sessionKey: string; entry: unknown }> = [];
let mockDownloadCalls: Array<Array<{ url: string; mediaName?: string; mediaType?: string }>> = [];

let mockRegistered = false;

function setupMocks(t: any, opts?: {
  downloadResult?: { mediaPaths: string[]; mediaTypes: string[] };
  mediaHistories?: typeof mockMediaHistories;
}) {
  mockDownloadResult = opts?.downloadResult ?? {
    mediaPaths: ["/tmp/img1.jpg"],
    mediaTypes: ["image"],
  };
  mockMediaHistories.clear();
  if (opts?.mediaHistories) {
    for (const [k, v] of opts.mediaHistories) {
      mockMediaHistories.set(k, v);
    }
  }
  mockRecordCalls = [];
  mockDownloadCalls = [];
  if (!mockRegistered) {
    t.mock.module("../../utils/media.js", {
      namedExports: {
        downloadMediasToLocalFiles: async (medias: Array<{ url: string; mediaName?: string; mediaType?: string }>) => {
          mockDownloadCalls.push(medias);
          return { ...mockDownloadResult };
        },
      },
    });
    t.mock.module("../../messaging/chat-history.js", {
      namedExports: {
        chatMediaHistories: mockMediaHistories,
        deriveChatKey: (isGroup: boolean, groupCode?: string, fromAccount?: string) => {
          if (isGroup && groupCode) { return `group:${groupCode}`; }
          return `direct:${fromAccount ?? "unknown"}`;
        },
        recordMediaHistory: (sessionKey: string, entry: unknown) => {
          mockRecordCalls.push({ sessionKey, entry });
        },
      },
    });
    mockRegistered = true;
  }
}

void test("download-media: when guard - executes when media present", async (t) => {
  setupMocks(t);
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    medias: [{ mediaType: "image", url: "https://example.com/img.jpg" }] as any,
  });
  assert.equal(downloadMedia.when!(ctx), true);
});

void test("download-media: when guard - empty array is still truthy", async (t) => {
  setupMocks(t);
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({ medias: [] });
  assert.equal(downloadMedia.when!(ctx), true);
});

void test("download-media: C2C - downloads media and populates mediaPaths", async (t) => {
  setupMocks(t, {
    downloadResult: { mediaPaths: ["/tmp/img1.jpg"], mediaTypes: ["image"] },
  });
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    isGroup: false,
    medias: [{ mediaType: "image", url: "https://example.com/img.jpg" }] as any,
  });
  const { next, wasCalled } = createMockNext();

  await downloadMedia.handler(ctx, next);

  assert.deepEqual(ctx.mediaPaths, ["/tmp/img1.jpg"]);
  assert.deepEqual(ctx.mediaTypes, ["image"]);
  assert.equal(wasCalled(), true);
});

void test("download-media: C2C - records media history with dm: session key", async (t) => {
  setupMocks(t, {
    downloadResult: { mediaPaths: ["/tmp/img1.jpg"], mediaTypes: ["image"] },
  });
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    isGroup: false,
    fromAccount: "user-abc",
    medias: [{ mediaType: "image", url: "https://example.com/img.jpg" }] as any,
    raw: { msg_id: "msg-100" } as any,
  });
  const { next } = createMockNext();

  await downloadMedia.handler(ctx, next);

  assert.equal(mockRecordCalls.length, 1);
  assert.equal(mockRecordCalls[0].sessionKey, "direct:user-abc");
});

void test("download-media: group - downloads media and populates mediaPaths", async (t) => {
  setupMocks(t, {
    downloadResult: { mediaPaths: ["/tmp/group-img.jpg"], mediaTypes: ["image"] },
  });
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    isGroup: true,
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    medias: [{ mediaType: "image", url: "https://example.com/group-img.jpg" }] as any,
    raw: { msg_id: "msg-001" } as any,
  });
  const { next, wasCalled } = createMockNext();

  await downloadMedia.handler(ctx, next);

  assert.deepEqual(ctx.mediaPaths, ["/tmp/group-img.jpg"]);
  assert.deepEqual(ctx.mediaTypes, ["image"]);
  assert.equal(wasCalled(), true);
  assert.equal(mockRecordCalls[0].sessionKey, "group:group-001");
});

void test("download-media: no media - mediaPaths is empty", async (t) => {
  setupMocks(t, {
    downloadResult: { mediaPaths: [], mediaTypes: [] },
  });
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    isGroup: false,
    medias: [],
  });
  const { next, wasCalled } = createMockNext();

  await downloadMedia.handler(ctx, next);

  assert.deepEqual(ctx.mediaPaths, []);
  assert.deepEqual(ctx.mediaTypes, []);
  assert.equal(wasCalled(), true);
});

void test("download-media: multiple media files download", async (t) => {
  setupMocks(t, {
    downloadResult: { mediaPaths: ["/tmp/img1.jpg", "/tmp/doc.pdf"], mediaTypes: ["image", "file"] },
  });
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    isGroup: false,
    medias: [
      { mediaType: "image", url: "https://example.com/img1.jpg" },
      { mediaType: "file", url: "https://example.com/doc.pdf" },
    ] as any,
  });
  const { next } = createMockNext();

  await downloadMedia.handler(ctx, next);

  assert.equal(ctx.mediaPaths.length, 2);
  assert.equal(ctx.mediaTypes.length, 2);
});

void test("download-media: C2C quote - merges quoted message media", async (t) => {
  const histories = new Map();
  histories.set("direct:user-001", [
    { sender: "other-user", messageId: "quoted-msg-1", timestamp: Date.now(), medias: [{ url: "https://example.com/quoted-img.jpg", mediaType: "image" }] },
  ]);
  setupMocks(t, {
    downloadResult: { mediaPaths: ["/tmp/quoted-img.jpg"], mediaTypes: ["image"] },
    mediaHistories: histories,
  });
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    isGroup: false,
    fromAccount: "user-001",
    medias: [],
    quoteInfo: { id: "quoted-msg-1", desc: "[image]" } as any,
  });
  const { next } = createMockNext();

  await downloadMedia.handler(ctx, next);

  assert.deepEqual(ctx.mediaPaths, ["/tmp/quoted-img.jpg"]);
});

void test("download-media: no quote + no history → empty mediaPaths", async (t) => {
  setupMocks(t, {
    downloadResult: { mediaPaths: [], mediaTypes: [] },
  });
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    isGroup: true,
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    medias: [],
    quoteInfo: undefined,
  });
  const { next } = createMockNext();

  await downloadMedia.handler(ctx, next);

  assert.deepEqual(ctx.mediaPaths, []);
  assert.deepEqual(ctx.mediaTypes, []);
});

void test("download-media: no quote + recent history within window → injects recent media", async (t) => {
  const histories = new Map();
  histories.set("group:group-001", [
    {
      sender: "user-001",
      messageId: "old-msg",
      timestamp: Date.now() - 3 * 60 * 1000, // 3 minutes ago, within window
      medias: [{ url: "https://example.com/recent-img.jpg", mediaType: "image" }],
    },
  ]);
  setupMocks(t, {
    downloadResult: { mediaPaths: ["/tmp/recent-img.jpg"], mediaTypes: ["image"] },
    mediaHistories: histories,
  });
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    isGroup: true,
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    medias: [], // current message has no media
    quoteInfo: undefined,
  });
  const { next } = createMockNext();

  await downloadMedia.handler(ctx, next);

  assert.deepEqual(ctx.mediaPaths, ["/tmp/recent-img.jpg"], "recent history image should be injected");
});

void test("download-media: no quote + history outside window → not injected", async (t) => {
  const histories = new Map();
  histories.set("group:group-001", [
    {
      sender: "user-001",
      messageId: "old-msg",
      timestamp: Date.now() - 15 * 60 * 1000, // 15 minutes ago, outside window
      medias: [{ url: "https://example.com/old-img.jpg", mediaType: "image" }],
    },
  ]);
  setupMocks(t, {
    downloadResult: { mediaPaths: [], mediaTypes: [] },
    mediaHistories: histories,
  });
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    isGroup: true,
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    medias: [],
    quoteInfo: undefined,
  });
  const { next } = createMockNext();

  await downloadMedia.handler(ctx, next);

  assert.deepEqual(ctx.mediaPaths, [], "history outside window should not be injected");
});

void test("download-media: no quote + history from different sender → not injected", async (t) => {
  const histories = new Map();
  histories.set("group:group-001", [
    {
      sender: "other-user",
      messageId: "other-msg",
      timestamp: Date.now() - 1 * 60 * 1000,
      medias: [{ url: "https://example.com/other-img.jpg", mediaType: "image" }],
    },
  ]);
  setupMocks(t, {
    downloadResult: { mediaPaths: [], mediaTypes: [] },
    mediaHistories: histories,
  });
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    isGroup: true,
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    medias: [],
    quoteInfo: undefined,
  });
  const { next } = createMockNext();

  await downloadMedia.handler(ctx, next);

  assert.deepEqual(ctx.mediaPaths, [], "other sender's history should not be injected");
});

void test("download-media: with quote → uses quoted media, not recent history", async (t) => {
  const histories = new Map();
  histories.set("direct:user-001", [
    {
      sender: "user-001",
      messageId: "recent-msg",
      timestamp: Date.now() - 1 * 60 * 1000,
      medias: [{ url: "https://example.com/recent-img.jpg", mediaType: "image" }],
    },
    {
      sender: "user-001",
      messageId: "quoted-msg",
      timestamp: Date.now() - 5 * 60 * 1000,
      medias: [{ url: "https://example.com/quoted-img.jpg", mediaType: "image" }],
    },
  ]);
  setupMocks(t, {
    downloadResult: { mediaPaths: ["/tmp/quoted-img.jpg"], mediaTypes: ["image"] },
    mediaHistories: histories,
  });
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    isGroup: false,
    fromAccount: "user-001",
    medias: [],
    quoteInfo: { id: "quoted-msg", desc: "[image]" } as any,
  });
  const { next } = createMockNext();

  await downloadMedia.handler(ctx, next);

  assert.deepEqual(ctx.mediaPaths, ["/tmp/quoted-img.jpg"], "should use quoted media, not recent history");
});

void test("download-media: current msg has media + no quote → does NOT inject recent history", async (t) => {
  const histories = new Map();
  histories.set("group:group-001", [
    {
      sender: "user-001",
      messageId: "old-msg",
      timestamp: Date.now() - 2 * 60 * 1000, // within window
      medias: [{ url: "https://example.com/old-img.jpg", mediaName: "old.jpg", mediaType: "image" }],
    },
  ]);
  setupMocks(t, {
    downloadResult: { mediaPaths: ["/tmp/current-img.jpg"], mediaTypes: ["image"] },
    mediaHistories: histories,
  });
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    isGroup: true,
    groupCode: "group-001" as any,
    fromAccount: "user-001",
    medias: [{ mediaType: "image", url: "https://example.com/current-img.jpg", mediaName: "current.jpg" }] as any,
    quoteInfo: undefined,
  });
  const { next } = createMockNext();

  await downloadMedia.handler(ctx, next);

  assert.equal(mockDownloadCalls.length, 1);
  const downloadedUrls = mockDownloadCalls[0].map(m => m.url);
  assert.deepEqual(
    downloadedUrls,
    ["https://example.com/current-img.jpg"],
    "should download only current message media, NOT inject historical media when current msg already has media",
  );
});

void test("download-media: quoted file media preserves mediaType=file (not hardcoded to image)", async (t) => {
  const histories = new Map();
  histories.set("direct:user-001", [
    {
      sender: "other-user",
      messageId: "quoted-file-msg",
      timestamp: Date.now(),
      medias: [{ url: "https://example.com/quoted-doc.pdf", mediaName: "doc.pdf", mediaType: "file" }],
    },
  ]);
  setupMocks(t, {
    downloadResult: { mediaPaths: ["/tmp/quoted-doc.pdf"], mediaTypes: ["application/pdf"] },
    mediaHistories: histories,
  });
  const { downloadMedia } = await import("./download-media.js");

  const ctx = createMockCtx({
    isGroup: false,
    fromAccount: "user-001",
    medias: [],
    quoteInfo: { id: "quoted-file-msg", desc: "[file]" } as any,
  });
  const { next } = createMockNext();

  await downloadMedia.handler(ctx, next);

  assert.equal(mockDownloadCalls.length, 1);
  assert.equal(mockDownloadCalls[0][0]?.mediaType, "file", "auxiliary file media must preserve mediaType=file");
});
