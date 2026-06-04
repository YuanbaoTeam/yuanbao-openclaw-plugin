/**
 * Unit tests for callbacks/recall.ts — group/C2C recall handling: local history
 * deletion vs. system-event injection.
 */

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { handleC2CRecall, handleGroupRecall } from "./recall.js";
import { chatHistories } from "../chat-history.js";
import type { MessageHandlerContext } from "../context.js";
import type { YuanbaoInboundMessage } from "../../../types.js";

function ctxWith() {
  const events: { text: string; opts: Record<string, unknown> }[] = [];
  const ctx = {
    account: { accountId: "a-1" },
    config: {},
    log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    core: {
      channel: { routing: { resolveAgentRoute: () => ({ sessionKey: "sk-1", agentId: "ag", accountId: "a-1" }) } },
      system: { enqueueSystemEvent: (text: string, opts: Record<string, unknown>) => { events.push({ text, opts }); } },
    },
  } as unknown as MessageHandlerContext;
  return { ctx, events };
}

afterEach(() => chatHistories.clear());

void test("handleGroupRecall with empty seq list does nothing", () => {
  const { ctx, events } = ctxWith();
  handleGroupRecall(ctx, { group_code: "g-1", recall_msg_seq_list: [] } as unknown as YuanbaoInboundMessage);
  assert.equal(events.length, 0);
});

void test("handleGroupRecall removes the message from history when present (no system event)", () => {
  const { ctx, events } = ctxWith();
  chatHistories.set("g-1", [{ messageId: "m-1", sender: "u", body: "x", timestamp: 1 } as never]);
  handleGroupRecall(ctx, { group_code: "g-1", recall_msg_seq_list: [{ msg_id: "m-1" }] } as unknown as YuanbaoInboundMessage);
  assert.equal(events.length, 0);
  assert.equal(chatHistories.get("g-1")!.length, 0);
});

void test("handleGroupRecall injects a system event when not in history", () => {
  const { ctx, events } = ctxWith();
  handleGroupRecall(ctx, { group_code: "g-1", group_name: "G", recall_msg_seq_list: [{ msg_id: "m-x" }] } as unknown as YuanbaoInboundMessage);
  assert.equal(events.length, 1);
  assert.match(events[0].text, /m-x/);
  assert.match(String(events[0].opts.contextKey), /yuanbao:recall:g-1:m-x/);
});

void test("handleC2CRecall injects a system event for the recalled msg_id", () => {
  const { ctx, events } = ctxWith();
  handleC2CRecall(ctx, { from_account: "u-1", msg_id: "c-1", msg_seq: 7 } as unknown as YuanbaoInboundMessage);
  assert.equal(events.length, 1);
  assert.match(events[0].text, /c-1/);
});

void test("handleC2CRecall does nothing without a msg_id", () => {
  const { ctx, events } = ctxWith();
  handleC2CRecall(ctx, { from_account: "u-1" } as unknown as YuanbaoInboundMessage);
  assert.equal(events.length, 0);
});
