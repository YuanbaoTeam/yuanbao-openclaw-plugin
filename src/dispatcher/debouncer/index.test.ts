/**
 * Unit tests for dispatcher/debouncer/index.ts.
 *
 * The SDK debouncer factory is mocked to capture the {buildKey, shouldDebounce,
 * onFlush, onError} config, which we then invoke directly to exercise the
 * session-key derivation (group / control / btw), debounce decision, single +
 * merged flush paths, and error logging — without driving real SDK timing.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

type Captured = {
  buildKey: (item: unknown) => string;
  shouldDebounce: (item: unknown) => boolean;
  onFlush: (items: unknown[]) => Promise<void>;
  onError: (err: unknown, items: unknown[]) => void;
};
let captured: Captured;
let abortText = "";
let btwText = "";
let ensureDebouncer: typeof import("./index.js").ensureDebouncer;

beforeEach(async () => {
  abortText = "/stop";
  btwText = "/btw";
  // Stub the pipeline so the real middleware graph (and its broad SDK imports)
  // is not pulled in — we only test the debouncer's own routing/flush logic.
  mock.module("../../business/pipeline/create.js", {
    namedExports: { createPipeline: () => ({ execute: async () => {} }) },
  });
  mock.module("openclaw/plugin-sdk/channel-inbound", {
    namedExports: {
      createChannelInboundDebouncer: (cfg: Captured) => { captured = cfg; return { debouncer: { enqueue: async () => {}, flush: async () => {} } }; },
      shouldDebounceTextInbound: () => false,
    },
  });
  mock.module("openclaw/plugin-sdk/reply-runtime", {
    namedExports: {
      isAbortRequestText: (t: string) => t === abortText,
      isBtwRequestText: (t: string) => t === btwText,
    },
  });
  ({ ensureDebouncer } = await import("./index.js"));
  ensureDebouncer({} as OpenClawConfig); // populate `captured`
});

afterEach(() => mock.restoreAll());

function item(over: Record<string, unknown> = {}) {
  return {
    msg: { from_account: "u-1", msg_body: [{ msg_type: "TIMTextElem", msg_content: { text: "hello" } }], msg_seq: 1 },
    isGroup: false,
    account: { accountId: "a-1", botId: "bot-1", config: {} },
    config: {},
    core: { channel: { routing: { resolveAgentRoute: () => ({ sessionKey: "sk" }) } } },
    wsClient: {},
    ...over,
  };
}

void test("buildKey: direct normal text uses the base key", () => {
  assert.equal(captured.buildKey(item()), "direct:a-1:u-1");
});

void test("buildKey: group message uses the group base key", () => {
  assert.equal(captured.buildKey(item({ isGroup: true, msg: { group_code: "g-1", msg_body: [] } })), "group:a-1:g-1");
});

void test("buildKey: /stop routes to a control queue", () => {
  const k = captured.buildKey(item({ msg: { from_account: "u-1", msg_body: [{ msg_type: "TIMTextElem", msg_content: { text: "/stop" } }] } }));
  assert.equal(k, "direct:a-1:u-1:control");
});

void test("buildKey: /btw routes to a per-interjection queue", () => {
  const k = captured.buildKey(item({ msg: { from_account: "u-1", msg_seq: 7, msg_body: [{ msg_type: "TIMTextElem", msg_content: { text: "/btw" } }] } }));
  assert.equal(k, "direct:a-1:u-1:btw:7");
});

void test("shouldDebounce delegates to the SDK predicate", () => {
  assert.equal(captured.shouldDebounce(item()), false);
});

void test("onFlush single item runs without throwing", async () => {
  await assert.doesNotReject(captured.onFlush([item()]));
});

void test("onFlush merges multiple items without throwing", async () => {
  await assert.doesNotReject(captured.onFlush([
    item({ msg: { from_account: "u-1", msg_body: [{ msg_type: "TIMTextElem", msg_content: { text: "a" } }] } }),
    item({ msg: { from_account: "u-1", msg_body: [{ msg_type: "TIMTextElem", msg_content: { text: "b" } }] } }),
  ]));
});

void test("onFlush skips when merged content is empty", async () => {
  await assert.doesNotReject(captured.onFlush([
    item({ msg: { from_account: "u-1", msg_body: [] } }),
    item({ msg: { from_account: "u-1", msg_body: [] } }),
  ]));
});

void test("onError logs without throwing", () => {
  assert.doesNotThrow(() => captured.onError(new Error("boom"), [item()]));
});

void test("onFlush with no items returns early", async () => {
  await assert.doesNotReject(captured.onFlush([]));
});
