/**
 * messaging/handlers/image.ts unit tests.
 *
 * Test scope: imageHandler extract and buildMsgBody
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { MessageHandlerContext } from "../context.js";
import { imageHandler } from "./image.js";
import type { ExtractTextFromMsgBodyResult } from "./types.js";

function makeMockCtx(botId = "bot-001"): MessageHandlerContext {
  return {
    account: { botId },
    config: {},
    core: {},
    log: { info: () => {}, warn: () => {}, error: () => {}, verbose: () => {} },
    wsClient: {},
  } as unknown as MessageHandlerContext;
}

function makeResData(): ExtractTextFromMsgBodyResult {
  return { rawBody: "", isAtBot: false, medias: [], mentions: [], linkUrls: [] };
}

void test("imageHandler extract extracts image URL to media list", () => {
  const ctx = makeMockCtx();
  const resData = makeResData();

  const elem = {
    msg_type: "TIMImageElem",
    msg_content: {
      uuid: "abc123.jpeg",
      image_info_array: [
        { type: 1, width: 735, height: 1830, url: "https://example.com/original.png" },
        { type: 2, width: 720, height: 1793, url: "https://example.com/medium.png" },
      ],
    },
  };

  const result = imageHandler.extract(ctx, elem, resData);
  assert.equal(result, "[image:abc123_720_1793.jpeg]");
  assert.equal(resData.medias.length, 1);
  // Prefers medium image (index 1)
  assert.equal(resData.medias[0].url, "https://example.com/medium.png");
  assert.equal(resData.medias[0].mediaType, "image");
  assert.equal(resData.medias[0].mediaName, "abc123_720_1793.jpeg");
});

void test("imageHandler extract falls back to plain uuid when no dimensions", () => {
  const ctx = makeMockCtx();
  const resData = makeResData();

  const elem = {
    msg_type: "TIMImageElem",
    msg_content: {
      uuid: "photo.jpg",
      image_info_array: [
        { type: 1, url: "https://example.com/photo.jpg" },
      ],
    },
  };

  const result = imageHandler.extract(ctx, elem, resData);
  assert.equal(result, "[image:photo.jpg]");
  assert.equal(resData.medias[0].mediaName, "photo.jpg");
});

void test("imageHandler extract falls back to image{N} when no uuid", () => {
  const ctx = makeMockCtx();
  const resData = makeResData();

  const elem = {
    msg_type: "TIMImageElem",
    msg_content: {
      image_info_array: [
        { type: 1, width: 100, height: 200, url: "https://example.com/img.png" },
      ],
    },
  };

  const result = imageHandler.extract(ctx, elem, resData);
  assert.equal(result, "[image:image1]");
  assert.equal(resData.medias[0].mediaName, "image1");
});

void test("imageHandler extract returns undefined when no URL", () => {
  const ctx = makeMockCtx();
  const resData = makeResData();

  const elem = {
    msg_type: "TIMImageElem",
    msg_content: { image_info_array: [] },
  };

  assert.equal(imageHandler.extract(ctx, elem, resData), undefined);
  assert.equal(resData.medias.length, 0);
});

void test("imageHandler buildMsgBody constructs image message", () => {
  const result = imageHandler.buildMsgBody!({ url: "https://example.com/img.png" });
  assert.equal(result.length, 1);
  assert.equal(result[0].msg_type, "TIMImageElem");
  assert.ok(result[0].msg_content.image_info_array);
});
