/**
 * Unit tests for forwarded chat-record (elem_type 1009) parsing.
 *
 * Covers parseForwardMsgData (ext_map key matching / fallback) and
 * buildForwardRecordsText (structured text + media/link side effects).
 */

import assert from "node:assert/strict";
import test from "node:test";
import { buildForwardRecordsText, parseForwardMsgData } from "./forward-records.js";
import type { ExtractTextFromMsgBodyResult } from "../types.js";

function makeResData(): ExtractTextFromMsgBodyResult {
  return { rawBody: "", isAtBot: false, medias: [], mentions: [], linkUrls: [] };
}

const sampleData = {
  sub_type: 1,
  nick_name: "Forwarder Fixture",
  msg: [
    {
      sender: "Alice",
      plainText: "[image] fixture-image.jpg",
      msgContent: [
        {
          type: 2,
          multimedia: [
            {
              type: "image",
              url: "https://example.invalid/resource/fixture-image.jpg",
              file_name: "fixture-image.jpg",
              media_id: "fixture-media-id",
              doc_type: "image",
            },
          ],
        },
      ],
    },
    {
      sender: "Bob",
      plainText: "fixture text",
      msgContent: [{ type: 1, text: "fixture text" }],
    },
  ],
};

const FIXTURE_FORWARD_PROTO =
  "CAEiEUZvcndhcmRlciBGaXh0dXJlKpABCgVBbGljZRoZW2ltYWdlXSBmaXh0dXJlLWltYWdlLmpwZyJsCAIaaAoFaW1hZ2USMmh0dHBzOi8vZXhhbXBsZS5pbnZhbGlkL3Jlc291cmNlL2ZpeHR1cmUtaW1hZ2UuanBnIhFmaXh0dXJlLWltYWdlLmpwZ3oQZml4dHVyZS1tZWRpYS1pZMIBBWltYWdl";

// ── parseForwardMsgData ─────────────────────────────────────────────────────
void test("parseForwardMsgData decodes base64 protobuf payloads from fixture ext_map", () => {
  const extMap = {
    wexin_forward_msg_fixture_user: FIXTURE_FORWARD_PROTO,
  };

  const data = parseForwardMsgData(extMap);
  assert.equal(data?.sub_type, 1);
  assert.equal(data?.nick_name, "Forwarder Fixture");
  assert.equal(data?.msg?.length, 1);
  assert.equal(data?.msg?.[0]?.plainText, "[image] fixture-image.jpg");
  assert.equal(data?.msg?.[0]?.msgContent?.[0]?.multimedia?.[0]?.type, "image");
  assert.equal(
    data?.msg?.[0]?.msgContent?.[0]?.multimedia?.[0]?.url,
    "https://example.invalid/resource/fixture-image.jpg",
  );
});

void test("parseForwardMsgData prefers the key matching the userId suffix", () => {
  const extMap = {
    wexin_forward_msg_aaa_other: "CAEiBW90aGVyKgMKAW8=",
    wexin_forward_msg_bbb_me: "CAEiBG1pbmUqAwoBbQ==",
  };
  const data = parseForwardMsgData(extMap, "me");
  assert.equal(data?.nick_name, "mine");
});

void test("parseForwardMsgData ignores non-forward keys and non-record sub_types", () => {
  const extMap = {
    other_key: FIXTURE_FORWARD_PROTO,
    wexin_forward_msg_x_u: "EAIqAA==",
  };
  assert.equal(parseForwardMsgData(extMap), undefined);
});

void test("parseForwardMsgData returns undefined for empty / invalid input", () => {
  assert.equal(parseForwardMsgData(undefined), undefined);
  assert.equal(parseForwardMsgData({}), undefined);
  assert.equal(parseForwardMsgData({ wexin_forward_msg_x_u: "!!!" }), undefined);
});

// ── buildForwardRecordsText ─────────────────────────────────────────────────
void test("buildForwardRecordsText builds header + lines and collects image media", () => {
  const resData = makeResData();
  const text = buildForwardRecordsText(sampleData, resData, "小明");

  assert.ok(text);
  const lines = text!.split("\n");
  assert.equal(lines[0], "当前用户的昵称为小明");
  assert.equal(lines[1], "以下为用户的聊天记录，数组每项代表[用户昵称, 聊天内容]");
  const records = JSON.parse(lines[2]) as Array<[string, string]>;
  assert.equal(records.length, 2);
  assert.equal(records[0][0], "Alice");
  assert.ok(records[0][1].startsWith("[image:"));
  assert.deepEqual(records[1], ["Bob", "fixture text"]);

  assert.equal(resData.medias.length, 1);
  assert.equal(resData.medias[0].mediaType, "image");
  assert.equal(
    resData.medias[0].url,
    "https://example.invalid/resource/fixture-image.jpg",
  );
  // placeholder name must match the recorded media name
  assert.ok(text!.includes(`[image:${resData.medias[0].mediaName}]`));
});

void test("buildForwardRecordsText omits nickname header when sender unknown", () => {
  const resData = makeResData();
  const text = buildForwardRecordsText({ sub_type: 1, msg: [{ sender: "A", msgContent: [{ type: 1, text: "hi" }] }] }, resData);
  assert.equal(text!.split("\n")[0], "以下为用户的聊天记录，数组每项代表[用户昵称, 聊天内容]");
});

void test("buildForwardRecordsText preserves newlines inside record text via JSON tuples", () => {
  const resData = makeResData();
  const text = buildForwardRecordsText(
    { sub_type: 1, msg: [{ sender: "A", msgContent: [{ type: 1, text: "第一行\n第二行" }] }] },
    resData,
  );
  const lines = text!.split("\n");
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[1]), [["A", "第一行\n第二行"]]);
});

void test("buildForwardRecordsText collects file media and link urls", () => {
  const resData = makeResData();
  const text = buildForwardRecordsText(
    {
      sub_type: 1,
      msg: [
        {
          sender: "A",
          msgContent: [
            { type: 2, multimedia: [{ type: "file", url: "https://x/f", file_name: "report.pdf" }] },
            { type: 2, multimedia: [{ type: "url", url: "https://mp.weixin.qq.com/s/abc", title: "公众号文章" }] },
          ],
        },
      ],
    },
    resData,
  );

  assert.equal(resData.medias.length, 1);
  assert.equal(resData.medias[0].mediaType, "file");
  assert.equal(resData.medias[0].mediaName, "report.pdf");
  assert.deepEqual(resData.linkUrls, ["https://mp.weixin.qq.com/s/abc"]);
  assert.ok(text!.includes("[file:report.pdf]"));
  assert.ok(text!.includes("[link] 公众号文章 https://mp.weixin.qq.com/s/abc"));
});

void test("buildForwardRecordsText supports alternate media URL fields", () => {
  const resData = makeResData();
  const text = buildForwardRecordsText(
    {
      sub_type: 1,
      msg: [
        {
          sender: "A",
          msgContent: [
            { type: 2, multimedia: [{ type: "file", parse_file_url: "https://x/parse-file", file_name: "parse.pdf" }] },
            { type: 2, multimedia: [{ type: "url", link_url: "https://example.com/link", title: "链接卡片" }] },
          ],
        },
      ],
    },
    resData,
  );

  assert.equal(resData.medias[0].url, "https://x/parse-file");
  assert.deepEqual(resData.linkUrls, ["https://example.com/link"]);
  assert.ok(text!.includes("[file:parse.pdf]"));
  assert.ok(text!.includes("[link] 链接卡片 https://example.com/link"));
});

void test("buildForwardRecordsText falls back to plainText when no msgContent", () => {
  const resData = makeResData();
  const text = buildForwardRecordsText(
    { sub_type: 1, msg: [{ sender: "A", plainText: "[Sticker]" }] },
    resData,
  );
  assert.deepEqual(JSON.parse(text!.split("\n")[1]), [["A", "[Sticker]"]]);
  assert.equal(resData.medias.length, 0);
});

void test("buildForwardRecordsText marks nested forward records", () => {
  const resData = makeResData();
  const text = buildForwardRecordsText(
    { sub_type: 1, msg: [{ sender: "A", msgContent: [{ type: 3 }] }] },
    resData,
  );
  assert.deepEqual(JSON.parse(text!.split("\n")[1]), [["A", "[嵌套聊天记录]"]]);
});

void test("buildForwardRecordsText returns undefined for empty msg list", () => {
  const resData = makeResData();
  assert.equal(buildForwardRecordsText({ sub_type: 1, msg: [] }, resData), undefined);
});

void test("buildForwardRecordsText caps records at 100", () => {
  const resData = makeResData();
  const msg = Array.from({ length: 110 }, (_, i) => ({ sender: `u${i}`, msgContent: [{ type: 1, text: `m${i}` }] }));
  const text = buildForwardRecordsText({ sub_type: 1, msg }, resData);
  assert.equal(JSON.parse(text!.split("\n")[1]).length, 100);
});
