/**
 * Unit tests for the file/video/sound message element handlers — extract
 * (inbound placeholder + media capture) and buildMsgBody (outbound).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fileHandler } from "./file.js";
import { soundHandler } from "./sound.js";
import { videoHandler } from "./video.js";
import type { ExtractTextFromMsgBodyResult, MsgBodyItemType } from "./types.js";
import type { MessageHandlerContext } from "../context.js";

const ctx = {} as MessageHandlerContext;
const resData = (): ExtractTextFromMsgBodyResult => ({ medias: [] } as unknown as ExtractTextFromMsgBodyResult);

void test("fileHandler.extract captures the file media and returns a named placeholder", () => {
  const res = resData();
  const out = fileHandler.extract!(ctx, { msg_type: "TIMFileElem", msg_content: { url: "http://f/x.pdf", file_name: "report.pdf" } } as MsgBodyItemType, res);
  assert.equal(out, "[file:report.pdf]");
  assert.equal(res.medias.length, 1);
  assert.equal(res.medias[0].mediaType, "file");
});

void test("fileHandler.extract returns [file] when url missing", () => {
  assert.equal(fileHandler.extract!(ctx, { msg_type: "TIMFileElem", msg_content: {} } as MsgBodyItemType, resData()), "[file]");
});

void test("fileHandler.buildMsgBody builds a TIMFileElem with provided fields", () => {
  const body = fileHandler.buildMsgBody!({ url: "u", fileName: "n", fileSize: 9, uuid: "id" });
  assert.equal(body[0].msg_type, "TIMFileElem");
  assert.equal(body[0].msg_content!.url, "u");
  assert.equal(body[0].msg_content!.file_name, "n");
});

void test("videoHandler.extract returns [video]; buildMsgBody builds TIMVideoFileElem", () => {
  assert.equal(videoHandler.extract!(ctx, {} as MsgBodyItemType, resData()), "[video]");
  const body = videoHandler.buildMsgBody!({ videoUrl: "vu", videoUuid: "vid" });
  assert.equal(body[0].msg_type, "TIMVideoFileElem");
  assert.equal(body[0].msg_content!.video_url, "vu");
});

void test("videoHandler.buildMsgBody includes every optional field when provided", () => {
  const body = videoHandler.buildMsgBody!({
    videoUrl: "vu", videoUuid: "vid", videoSize: 1, videoSecond: 2, videoFormat: "mp4",
    thumbUrl: "tu", thumbUuid: "tid", thumbSize: 3, thumbWidth: 4, thumbHeight: 5, thumbFormat: "png",
  });
  const c = body[0].msg_content!;
  assert.equal(c.video_uuid, "vid");
  assert.equal(c.video_second, 2);
  assert.equal(c.thumb_url, "tu");
  assert.equal(c.thumb_width, 4);
  assert.equal(c.thumb_format, "png");
});

void test("soundHandler.extract returns [voice]", () => {
  assert.equal(soundHandler.extract!(ctx, {} as MsgBodyItemType, resData()), "[voice]");
});

void test("buildMsgBody omits optional fields when not provided (falsy branches)", () => {
  const file = fileHandler.buildMsgBody!({ url: "u" });
  assert.equal(file[0].msg_content!.file_name, undefined);
  assert.equal(file[0].msg_content!.file_size, undefined);
  assert.equal(file[0].msg_content!.uuid, undefined);

  const video = videoHandler.buildMsgBody!({ videoUrl: "vu" });
  assert.equal(video[0].msg_content!.video_uuid, undefined);
  assert.equal(video[0].msg_content!.thumb_url, undefined);
});
