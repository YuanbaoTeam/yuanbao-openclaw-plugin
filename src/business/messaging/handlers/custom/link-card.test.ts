/**
 * Unit tests for custom/link-card.ts — share card (1010) and link-understanding
 * (1007) formatting + URL extraction. Pure functions.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { extractLinkCard, extractLinkCardUrls } from "./link-card.js";

void test("extractLinkCard formats a share card (1010) as XML", () => {
  const out = extractLinkCard({ elem_type: 1010, title: "T", link: "http://x", card_content: "c", wechat_des: "d" });
  assert.match(out!, /<share_card name="T">/);
  assert.match(out!, /<link>http:\/\/x<\/link>/);
  assert.match(out!, /<preview_title>c<\/preview_title>/);
});

void test("extractLinkCard formats link-understanding (1007) when content has a link", () => {
  const out = extractLinkCard({ elem_type: 1007, content: JSON.stringify({ link: "http://y" }) });
  assert.match(out!, /<link_understanding>/);
  assert.match(out!, /http:\/\/y/);
});

void test("extractLinkCard returns undefined for unknown / linkless data", () => {
  assert.equal(extractLinkCard({ elem_type: 9999 }), undefined);
  assert.equal(extractLinkCard({ elem_type: 1007, content: "not-json" }), undefined);
  assert.equal(extractLinkCard(null), undefined);
});

void test("extractLinkCardUrls pulls the url from both card types", () => {
  assert.deepEqual(extractLinkCardUrls({ elem_type: 1010, link: "http://x" }), ["http://x"]);
  assert.deepEqual(extractLinkCardUrls({ elem_type: 1007, content: JSON.stringify({ link: "http://y" }) }), ["http://y"]);
  assert.deepEqual(extractLinkCardUrls({ elem_type: 1010 }), []);
  assert.deepEqual(extractLinkCardUrls({ elem_type: 1007, content: "bad" }), []);
});
