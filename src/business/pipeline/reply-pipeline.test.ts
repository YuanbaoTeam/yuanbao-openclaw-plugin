import assert from "node:assert/strict";
import test from "node:test";
import { resolveCreateChannelReplyPipeline } from "./reply-pipeline.js";

const params = { cfg: {}, agentId: "agent-1", channel: "yuanbao", accountId: "bot-1" };

void test("resolveCreateChannelReplyPipeline prefers channel-outbound", async () => {
  const list = await resolveCreateChannelReplyPipeline(
    async () => ({
      createChannelMessageReplyPipeline: (value: typeof params) => ({
        onModelSelected: () => {},
        agentId: value.agentId,
      }),
    }),
    async () => {
      throw new Error("legacy should not be imported");
    },
  );
  const pipeline = list(params);
  assert.equal(pipeline.agentId, "agent-1");
  assert.equal(typeof pipeline.onModelSelected, "function");
});

void test("resolveCreateChannelReplyPipeline falls back when the modern helper is absent", async () => {
  const list = await resolveCreateChannelReplyPipeline(
    async () => ({}),
    async () => ({
      createChannelReplyPipeline: () => ({ legacy: true }),
    }),
  );
  assert.equal(list(params).legacy, true);
});

void test("resolveCreateChannelReplyPipeline falls back when the modern import fails", async () => {
  const list = await resolveCreateChannelReplyPipeline(
    async () => {
      throw new Error("missing channel-outbound");
    },
    async () => ({
      createChannelReplyPipeline: () => ({ legacy: true }),
    }),
  );
  assert.equal(list(params).legacy, true);
});

void test("resolveCreateChannelReplyPipeline throws when both SDKs are unavailable", async () => {
  await assert.rejects(
    () => resolveCreateChannelReplyPipeline(
      async () => {
        throw new Error("missing modern");
      },
      async () => {
        throw new Error("missing legacy");
      },
    ),
    /未提供回复管线/,
  );
  await assert.rejects(
    () => resolveCreateChannelReplyPipeline(async () => null, async () => "not-a-module"),
    /未提供回复管线/,
  );
});
