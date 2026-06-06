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
  nick_name: "绘梨衣",
  msg: [
    {
      sender: "绘梨衣",
      plainText: "[Photo] Weixinimage_20260604134715_46281.jpg",
      msgContent: [
        {
          type: 2,
          multimedia: [
            {
              type: "image",
              url: "https://hunyuan.tencent.com/api/resource/download?resourceId=378737b947f1822c1e8d0b6d0b344fae_19",
              file_name: "Weixinimage_20260604134715_46281.jpg",
              media_id: "378737b947f1822c1e8d0b6d0b344fae_19",
              doc_type: "image",
            },
          ],
        },
      ],
    },
    {
      sender: "LK7",
      plainText: "我滴乖大型 suv",
      msgContent: [{ type: 1, text: "我滴乖大型 suv" }],
    },
  ],
};

const PRODUCTION_FORWARD_PROTO =
  "CAEiCeael+mUkOa2myqKAhovW+WbvueJh10g5b6u5L+h5Zu+54mHXzIwMjYwNjA2MTA0MzM3XzE1NzQzNC5qcGci1gEIAhrRAQoFaW1hZ2USaWh0dHBzOi8veXVhbmJhby50ZXN0Lmh1bnl1YW4ud29hLmNvbS9hcGkvcmVzb3VyY2UvZG93bmxvYWQ/cmVzb3VyY2VJZD00NmEwYmY3OTRkMjYxNmE0YTBkNjBmNTE4YzdmOTliNF8wMCIm5b6u5L+h5Zu+54mHXzIwMjYwNjA2MTA0MzM3XzE1NzQzNC5qcGcorskLMIAKOLINeiM0NmEwYmY3OTRkMjYxNmE0YTBkNjBmNTE4YzdmOTliNF8wMMIBBWltYWdl";

// ── parseForwardMsgData ─────────────────────────────────────────────────────
void test("parseForwardMsgData decodes base64 protobuf payloads from production ext_map", () => {
  const extMap = {
    wexin_forward_msg_8bd2b7dc615111f1bbb45254003930f1_f9aed05b77aa4b1ba860b50b836bb57e:
      PRODUCTION_FORWARD_PROTO,
  };

  const data = parseForwardMsgData(extMap);
  assert.equal(data?.sub_type, 1);
  assert.equal(data?.nick_name, "林锐涛");
  assert.equal(data?.msg?.length, 1);
  assert.equal(data?.msg?.[0]?.plainText, "[图片] 微信图片_20260606104337_157434.jpg");
  assert.equal(data?.msg?.[0]?.msgContent?.[0]?.multimedia?.[0]?.type, "image");
  assert.equal(
    data?.msg?.[0]?.msgContent?.[0]?.multimedia?.[0]?.url,
    "https://yuanbao.test.hunyuan.woa.com/api/resource/download?resourceId=46a0bf794d2616a4a0d60f518c7f99b4_00",
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
    other_key: PRODUCTION_FORWARD_PROTO,
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
  assert.equal(lines[1], "转发者微信昵称：绘梨衣");
  assert.equal(lines[2], "以下为用户的聊天记录");
  assert.ok(lines[3].startsWith("绘梨衣：[image:"));
  assert.equal(lines[4], "LK7：我滴乖大型 suv");

  assert.equal(resData.medias.length, 1);
  assert.equal(resData.medias[0].mediaType, "image");
  assert.equal(
    resData.medias[0].url,
    "https://hunyuan.tencent.com/api/resource/download?resourceId=378737b947f1822c1e8d0b6d0b344fae_19",
  );
  // placeholder name must match the recorded media name
  assert.ok(text!.includes(`[image:${resData.medias[0].mediaName}]`));
});

void test("buildForwardRecordsText omits nickname header when sender unknown", () => {
  const resData = makeResData();
  const text = buildForwardRecordsText({ sub_type: 1, msg: [{ sender: "A", msgContent: [{ type: 1, text: "hi" }] }] }, resData);
  assert.equal(text!.split("\n")[0], "以下为用户的聊天记录");
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
  assert.equal(text!.split("\n").at(-1), "A：[Sticker]");
  assert.equal(resData.medias.length, 0);
});

void test("buildForwardRecordsText marks nested forward records", () => {
  const resData = makeResData();
  const text = buildForwardRecordsText(
    { sub_type: 1, msg: [{ sender: "A", msgContent: [{ type: 3 }] }] },
    resData,
  );
  assert.ok(text!.includes("A：[嵌套聊天记录]"));
});

void test("buildForwardRecordsText returns undefined for empty msg list", () => {
  const resData = makeResData();
  assert.equal(buildForwardRecordsText({ sub_type: 1, msg: [] }, resData), undefined);
});

void test("buildForwardRecordsText caps records at 50", () => {
  const resData = makeResData();
  const msg = Array.from({ length: 60 }, (_, i) => ({ sender: `u${i}`, msgContent: [{ type: 1, text: `m${i}` }] }));
  const text = buildForwardRecordsText({ sub_type: 1, msg }, resData);
  // header line + 50 record lines
  assert.equal(text!.split("\n").length, 51);
});
