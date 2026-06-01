/**
 * Unit tests for inbound/index.ts handleInboundMessage — routes system callbacks
 * (synchronous) vs normal messages (debounced). The debouncer is mocked.
 */

import assert from "node:assert/strict";
import test, { afterEach, beforeEach, mock } from "node:test";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { InboundMessageParams } from "./index.js";
import type { ResolvedYuanbaoAccount, YuanbaoInboundMessage } from "../../types.js";
import type { YuanbaoWsClient } from "../../access/ws/client.js";

let enqueued: unknown[];
let handleInboundMessage: typeof import("./index.js").handleInboundMessage;

beforeEach(async () => {
  enqueued = [];
  mock.module("../../dispatcher/debouncer/index.js", {
    namedExports: { ensureDebouncer: () => ({ enqueue: async (p: unknown) => { enqueued.push(p); } }) },
  });
  ({ handleInboundMessage } = await import("./index.js"));
});

afterEach(() => mock.restoreAll());

const core = {
  channel: { routing: { resolveAgentRoute: () => ({ sessionKey: "sk", agentId: "ag", accountId: "a-1" }) } },
  system: { enqueueSystemEvent: () => {} },
} as unknown as PluginRuntime;

function baseParams(msg: YuanbaoInboundMessage, isGroup = false): InboundMessageParams {
  return {
    msg, isGroup,
    account: { accountId: "a-1" } as ResolvedYuanbaoAccount,
    config: {} as never,
    core,
    wsClient: {} as YuanbaoWsClient,
  };
}

void test("normal message is delegated to the debouncer", async () => {
  await handleInboundMessage(baseParams({ from_account: "u-1", msg_body: [] } as YuanbaoInboundMessage));
  assert.equal(enqueued.length, 1);
});

void test("system callback (recall) is dispatched synchronously, not debounced", async () => {
  // Group recall with empty seq list → handler returns early, but dispatch
  // still consumes the message so it must NOT be enqueued.
  await handleInboundMessage(baseParams(
    { callback_command: "Group.CallbackAfterRecallMsg", group_code: "g-1", recall_msg_seq_list: [] } as unknown as YuanbaoInboundMessage,
    true,
  ));
  assert.equal(enqueued.length, 0);
});
