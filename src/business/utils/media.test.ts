/**
 * Unit tests for the PURE helpers in utils/media.ts — MIME guessing, image-size
 * parsing (PNG/GIF), and TIM image/file message-body builders. The download/
 * upload IO paths are covered by the YuanbaoPBGo E2E suite.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildFileMsgBody, buildImageMsgBody, guessMimeType, parseImageSize } from "./media.js";

void test("guessMimeType maps known extensions and defaults to octet-stream", () => {
  assert.equal(guessMimeType("a.png"), "image/png");
  assert.equal(guessMimeType("a.JPG"), "image/jpeg");
  assert.equal(guessMimeType("doc.pdf"), "application/pdf");
  assert.equal(guessMimeType("v.mp4"), "video/mp4");
  assert.equal(guessMimeType("noext"), "application/octet-stream");
  assert.equal(guessMimeType("a.unknownext"), "application/octet-stream");
});

void test("parseImageSize reads PNG dimensions", () => {
  const buf = Buffer.alloc(24);
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47; // PNG signature
  buf.writeUInt32BE(120, 16); // width
  buf.writeUInt32BE(80, 20); // height
  assert.deepEqual(parseImageSize(buf), { width: 120, height: 80 });
});

void test("parseImageSize reads GIF dimensions", () => {
  const buf = Buffer.alloc(10);
  buf.write("GIF89a", 0, "ascii");
  buf.writeUInt16LE(64, 6); // width
  buf.writeUInt16LE(48, 8); // height
  assert.deepEqual(parseImageSize(buf), { width: 64, height: 48 });
});

void test("parseImageSize returns undefined for non-image data", () => {
  assert.equal(parseImageSize(Buffer.from("not an image at all")), undefined);
  assert.equal(parseImageSize(Buffer.alloc(2)), undefined);
});

void test("buildImageMsgBody builds a TIMImageElem with dimensions", () => {
  const body = buildImageMsgBody({ url: "http://x/img.png", filename: "img.png", size: 999, uuid: "u-1", imageInfo: { width: 10, height: 20 } });
  assert.equal(body[0].msg_type, "TIMImageElem");
  const arr = body[0].msg_content.image_info_array as Array<Record<string, unknown>>;
  assert.equal(body[0].msg_content.uuid, "u-1");
  assert.equal(arr[0].width, 10);
  assert.equal(arr[0].height, 20);
  assert.equal(arr[0].url, "http://x/img.png");
});

void test("buildImageMsgBody falls back to URL basename for uuid", () => {
  const body = buildImageMsgBody({ url: "http://host/path/pic.png" });
  assert.equal(body[0].msg_content.uuid, "pic.png");
});

void test("buildFileMsgBody builds a TIMFileElem", () => {
  const body = buildFileMsgBody({ url: "http://x/r.pdf", filename: "r.pdf", size: 1234 });
  assert.equal(body[0].msg_type, "TIMFileElem");
  assert.equal(body[0].msg_content.file_name, "r.pdf");
  assert.equal(body[0].msg_content.file_size, 1234);
  assert.equal(body[0].msg_content.uuid, "r.pdf"); // falls back to filename
});
