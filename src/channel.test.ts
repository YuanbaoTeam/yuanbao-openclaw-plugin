import assert from "node:assert/strict";
import test, { after, before, beforeEach, mock } from "node:test";
import type { ChannelOutboundContext } from "openclaw/plugin-sdk/channel-contract";
import type { ActionHandlerResult } from "./business/actions/handler.js";
import type { ActionParams } from "./business/actions/resolve-target.js";

let handleActionImpl: (input: ActionParams) => Promise<ActionHandlerResult>;
let receivedInputs: ActionParams[];
let yuanbaoPlugin: typeof import("./channel.js").yuanbaoPlugin;

const outboundContext = {
  cfg: {},
  to: "user:u-1",
  text: "hello",
  mediaUrl: "https://example.com/image.png",
} as ChannelOutboundContext;

before(async () => {
  mock.module("./business/actions/index.js", {
    namedExports: {
      handleAction: (input: ActionParams) => {
        receivedInputs.push(input);
        return handleActionImpl(input);
      },
      yuanbaoMessageActions: {},
    },
  });
  ({ yuanbaoPlugin } = await import("./channel.js"));
});

beforeEach(() => {
  receivedInputs = [];
  handleActionImpl = async () => ({
    channel: "yuanbao",
    ok: true,
    messageId: "m-1",
  });
});

after(() => {
  mock.restoreAll();
});

for (const method of ["sendText", "sendMedia"] as const) {
  void test(`outbound.${method} returns the delivered message id`, async () => {
    const send = yuanbaoPlugin.outbound?.[method];
    assert.ok(send);

    const result = await send(outboundContext);

    assert.deepEqual(result, { channel: "yuanbao", messageId: "m-1" });
    assert.equal(receivedInputs[0], outboundContext);
  });

  void test(`outbound.${method} rejects when the action handler reports failure`, async () => {
    const expectedError = new Error("ws down");
    handleActionImpl = async () => ({
      channel: "yuanbao",
      ok: false,
      messageId: "",
      error: expectedError,
    });
    const send = yuanbaoPlugin.outbound?.[method];
    assert.ok(send);

    await assert.rejects(send(outboundContext), error => error === expectedError);
  });
}

void test("outbound adapter creates an error when the handler omits one", async () => {
  handleActionImpl = async () => ({
    channel: "yuanbao",
    ok: false,
    messageId: "",
  });
  const sendText = yuanbaoPlugin.outbound?.sendText;
  assert.ok(sendText);

  await assert.rejects(sendText(outboundContext), /Yuanbao outbound sendText failed/);
});

void test("outbound adapter does not swallow an unexpected handler exception", async () => {
  const expectedError = new Error("unexpected failure");
  handleActionImpl = async () => {
    throw expectedError;
  };
  const sendText = yuanbaoPlugin.outbound?.sendText;
  assert.ok(sendText);

  await assert.rejects(sendText(outboundContext), error => error === expectedError);
});
