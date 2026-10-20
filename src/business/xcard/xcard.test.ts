/**
 * xCard unit tests: template library (schema validation + field-path errors, each template's
 * example renders valid A2UI v1.0, template event decisions incl. kept-open form submits),
 * card create/update wire calls
 * (card-first, deduped text fallback on refusal, "rate limited" treated as failure), reply-heartbeat
 * pause, event validation + the single receipt per submit (reason codes, replay, perRevision), the two delivery paths (waiting tool call resolved without
 * the session queue vs. waking a new turn through the group queue), renderer errors, and the
 * temporary im1007 transport (1013 carrier card / upevent / downevent, link-card logic untouched). The
 * debouncer and xCard pipeline are mocked.
 */

import assert from "node:assert/strict";
import { before, beforeEach, describe, it, mock } from "node:test";

type Call = { method: string; data: Record<string, any> };

const enqueued: Array<{ accountId: string; groupCode: string }> = [];
const executed: Array<Record<string, any>> = [];
let abortListener: ((accountId: string, groupCode: string) => void) | undefined;

let mod: {
  registry: typeof import("./registry.js");
  service: typeof import("./service.js");
  events: typeof import("./events.js");
  templates: typeof import("./templates/index.js");
  schema: typeof import("./templates/schema.js");
  builder: typeof import("./templates/builder.js");
  validate: typeof import("./validate.js");
  generated: typeof import("./generated.js");
  im1007: typeof import("./transport-im1007.js");
  linkCard: typeof import("../messaging/handlers/custom/link-card.js");
};

before(async () => {
  mock.module("../../dispatcher/debouncer/index.js", {
    namedExports: {
      enqueueGroupTask: async (accountId: string, groupCode: string, task: () => Promise<void>) => {
        enqueued.push({ accountId, groupCode });
        await task();
      },
      enqueueSessionTask: async (
        accountId: string,
        _isGroup: boolean,
        targetId: string,
        task: () => Promise<void>,
      ) => {
        enqueued.push({ accountId, groupCode: targetId });
        await task();
      },
      buildPipelineContext: (item: { msg: unknown; isGroup: boolean }) => ({
        raw: item.msg,
        isGroup: item.isGroup,
      }),
      onGroupAbort: (l: (a: string, g: string) => void) => {
        abortListener = l;
        return () => {};
      },
    },
  });
  mock.module("../pipeline/create.js", {
    namedExports: {
      createXCardEventPipeline: () => ({
        execute: async (ctx: Record<string, any>) => {
          executed.push(ctx);
        },
      }),
    },
  });
  mod = {
    registry: await import("./registry.js"),
    service: await import("./service.js"),
    events: await import("./events.js"),
    templates: await import("./templates/index.js"),
    schema: await import("./templates/schema.js"),
    builder: await import("./templates/builder.js"),
    validate: await import("./validate.js"),
    generated: await import("./generated.js"),
    im1007: await import("./transport-im1007.js"),
    linkCard: await import("../messaging/handlers/custom/link-card.js"),
  };
});

const OWNER = "owner-user";
const OTHER = "other-user";
const GROUP = "123456789";

type CardRsp = { code: number; message: string };

/** A card is recognized by its 1013 custom elem carrying an extend_type=101 envelope. */
function isCard(data: Record<string, any>): boolean {
  const el = data.msg_body?.[0];
  if (el?.msg_type !== "TIMCustomElem") return false;
  try {
    const d = JSON.parse(el.msg_content.data);
    return d.elem_type === 1013 && JSON.parse(d.text).extend_type === 101;
  } catch {
    return false;
  }
}

function fakeClient(cardRsp?: () => CardRsp) {
  const calls: Call[] = [];
  const send = async (data: Record<string, any>, initialMethod: string) => {
    let method = initialMethod;
    try {
      const envelope = JSON.parse(JSON.parse(data.msg_body[0].msg_content.data).text);
      if (envelope.extend_type === 103) {
        if (envelope.content.action_ack) method = "receipt";
        if (envelope.content.state_update) method = "update";
      }
    } catch {}
    calls.push({ method, data });
    if (isCard(data) && cardRsp) return { msgId: "ws", ...cardRsp() };
    return { msgId: "ws", code: 0, message: "" };
  };
  const client = {
    calls,
    async sendGroupMessage(data: Record<string, any>) {
      return send(data, "send");
    },
    async sendC2CMessage(data: Record<string, any>) {
      return send(data, "c2c");
    },
  };
  return client;
}

const account = { accountId: "acct", botId: "bot-1" } as any;

function prepare(key: string, data: Record<string, unknown>) {
  const tpl = mod.templates.getTemplate(key)!;
  const p = mod.templates.prepareTemplateData(tpl, data);
  assert.ok(p.ok, JSON.stringify(!p.ok && p.errors));
  return { tpl, data: p.data };
}

async function createTemplate(
  client: ReturnType<typeof fakeClient>,
  key: string,
  data: Record<string, unknown>,
  audience: "requester" | "anyone" = "requester",
) {
  const p = prepare(key, data);
  return mod.service.createTemplateCard({
    account,
    wsClient: client as any,
    groupCode: GROUP,
    sessionKey: `agent:main:yuanbao:group:${GROUP}`,
    ownerUserId: OWNER,
    audience,
    template: p.tpl,
    data: p.data,
  });
}

const DINNER = {
  title: "晚饭",
  question: "今晚吃什么？",
  options: [
    { id: "hotpot", label: "火锅" },
    { id: "bbq", label: "烧烤" },
  ],
};

const createCard = (client: ReturnType<typeof fakeClient>, audience: "requester" | "anyone" = "requester") =>
  createTemplate(client, "choice", DINNER, audience);

function pushBytes(p: {
  requestId: string;
  surfaceId: string;
  operator?: string;
  optionId?: string;
  revision?: number;
  epoch?: string;
  protocol?: string;
  action?: string;
  context?: Record<string, unknown>;
  messageId?: string;
  /** Replaces the whole renderer message (v1.0 action / error) */
  event?: Record<string, unknown>;
}): Uint8Array {
  const payload = {
    protocol: p.protocol ?? "yuanbao.openclaw.xcard/1",
    requestId: p.requestId,
    binding: {
      pluginEpoch: p.epoch ?? mod.registry.PLUGIN_EPOCH,
      revision: p.revision ?? 1,
      messageId: p.messageId ?? "card-message",
    },
    event: p.event ?? {
      version: "v1.0",
      action: {
        name: p.action ?? "select",
        surfaceId: p.surfaceId,
        context: p.context ?? { optionId: p.optionId ?? "bbq" },
      },
    },
  };
  return new TextEncoder().encode(JSON.stringify({
    payload: JSON.stringify(payload),
    trusted: { operatorUserId: p.operator ?? OWNER, botId: "bot-1", groupCode: GROUP, pluginEpoch: "", replyToken: `tok-${p.requestId}` },
  }));
}

function receipts(client: ReturnType<typeof fakeClient>) {
  return client.calls
    .filter((c) => c.method === "receipt")
    .map((c) => {
      const ack = envelopeOf(c).content.action_ack;
      return ack.success ? "accepted" : `rejected:${ack.error_code}`;
    });
}

const envelopeOf = (call: Call) => JSON.parse(JSON.parse(call.data.msg_body[0].msg_content.data).text);
const contentOf = (call: Call) => {
  const content = envelopeOf(call).content;
  return (content.state_update ? content.state_update.content : content) as any[];
};
const modelOf = (msgs: any[]) => msgs.find((m) => m.updateDataModel)!.updateDataModel.value;

const deps = (client: ReturnType<typeof fakeClient>) => ({
  account,
  config: {} as any,
  core: {} as any,
  wsClient: client as any,
});

async function handleEventPush(raw: Uint8Array, client: ReturnType<typeof fakeClient>): Promise<void> {
  const outer = JSON.parse(new TextDecoder().decode(raw));
  const trusted = outer.trusted as Record<string, string>;
  await mod.events.handleXCardUpEvent(
    { from_account: trusted.operatorUserId, group_code: trusted.groupCode } as any,
    JSON.parse(outer.payload),
    deps(client),
  );
}

beforeEach(() => {
  mod?.registry.__resetXCardRegistryForTest();
  mod?.service.__resetXCardFallbacksForTest();
  enqueued.length = 0;
  executed.length = 0;
});

describe("template data schema", () => {
  it("reports field paths, applies defaults, coerces and drops unknown keys", () => {
    const tpl = mod.templates.getTemplate("choice")!;
    const bad = mod.templates.prepareTemplateData(tpl, { question: "", options: [{ label: "A" }, { id: 3 }], extra: 1 });
    assert.ok(!bad.ok);
    const paths = bad.errors.map((e) => e.path);
    assert.ok(paths.includes("title"), paths.join());
    assert.ok(paths.includes("question"), paths.join());
    assert.ok(paths.includes("options[1].label"), paths.join());

    const ok = mod.templates.prepareTemplateData(tpl, {
      title: "t", question: "q", options: [{ label: "A" }, { label: "B" }], multiple: "false", extra: 1,
    });
    assert.ok(ok.ok);
    assert.equal(ok.data.multiple, false);
    assert.equal(ok.data.submitLabel, "提交");
    assert.deepEqual((ok.data.options as any[]).map((o) => o.id), ["opt1", "opt2"]);
    assert.equal("extra" in ok.data, false);
    assert.ok(ok.warnings.some((w) => w.includes("extra")));
  });

  it("template check rules surface as field errors", () => {
    const dup = mod.templates.prepareTemplateData(mod.templates.getTemplate("choice")!, {
      title: "t", question: "q", options: [{ id: "x", label: "A" }, { id: "x", label: "B" }],
    });
    assert.ok(!dup.ok);
    assert.equal(dup.errors[0]?.path, "options[1].id");

    const form = mod.templates.prepareTemplateData(mod.templates.getTemplate("form")!, {
      title: "t", fields: [{ key: "city", label: "城市", type: "select" }],
    });
    assert.ok(!form.ok);
    assert.match(form.errors.map((e) => `${e.path}: ${e.message}`).join("\n"), /fields\[0\]\.options/);

    const tooMany = mod.templates.prepareTemplateData(mod.templates.getTemplate("choice")!, {
      title: "t", question: "q", options: Array.from({ length: 11 }, (_, i) => ({ label: `o${i}` })),
    });
    assert.ok(!tooMany.ok && tooMany.errors.some((e) => e.path === "options"));
  });

  it("parseTemplateData accepts JSON text or objects", () => {
    assert.deepEqual(mod.schema.parseTemplateData('{"a":1}'), { data: { a: 1 } });
    assert.deepEqual(mod.schema.parseTemplateData({ a: 1 }), { data: { a: 1 } });
    assert.ok("error" in mod.schema.parseTemplateData("[1]"));
    assert.ok("error" in mod.schema.parseTemplateData("{bad"));
  });
});

describe("template rendering", () => {
  it("every template's example passes prepare and renders valid A2UI (open + closed)", () => {
    const keys = mod.templates.listTemplates().map((t) => t.key);
    assert.deepEqual(keys, ["choice", "form", "item_list", "confirm", "info"]);
    for (const tpl of mod.templates.TEMPLATES) {
      const p = mod.templates.prepareTemplateData(tpl, structuredClone(tpl.example));
      assert.ok(p.ok, `${tpl.key}: ${JSON.stringify(!p.ok && p.errors)}`);
      assert.deepEqual(p.warnings, [], tpl.key);
      for (const closed of [false, true]) {
        const msgs = mod.builder.buildTemplateMessages(tpl, p.data, { closed }, "s1", { revision: 1 }) as any[];
        const res = mod.validate.validateA2uiMessages(msgs);
        assert.deepEqual(res.errors, [], `${tpl.key} closed=${closed}`);
        assert.ok(msgs.every((m) => m.version === "v1.0"));
        assert.equal(msgs[0].createSurface.catalogId, "https://yuanbao.tencent.com/specification/v1_0/catalogs/xcard/catalog.json");
        const comps = msgs[1].updateComponents.components;
        assert.equal(comps.find((c: any) => c.id === "root").component, "Card");
        assert.deepEqual(comps.find((c: any) => c.id === "body").enabled, { call: "not", args: { value: { path: "/ui/closed" } } });
        assert.equal(modelOf(msgs).ui.closed, closed);
        // Every event button fires an event declared by the template
        for (const c of comps) {
          const name = c.action?.event?.name;
          if (name) assert.ok(name in tpl.events, `${tpl.key}: undeclared event ${name}`);
        }
      }
      assert.ok(tpl.fallbackText(p.data).length > 0);
    }
  });

  it("choice: structure is identical across states, DataModel carries the result", () => {
    const { tpl, data } = prepare("choice", DINNER);
    const open = mod.builder.buildTemplateMessages(tpl, data, { closed: false }, "s", {}) as any[];
    const last = { action: "select", context: { optionId: "bbq", optionLabel: "烧烤" }, summary: "", operatorUserId: OWNER, at: 0, revision: 1 } as any;
    const closed = mod.builder.buildTemplateMessages(tpl, data, { closed: true, last }, "s", {}) as any[];
    assert.deepEqual(closed[1], open[1]);
    assert.equal(modelOf(closed).state.selectedId, "bbq");
    assert.deepEqual(modelOf(closed).ui, { closed: true, hasResult: true, resultText: "已选择：烧烤" });
    const btn = open[1].updateComponents.components.find((c: any) => c.component === "Button");
    assert.deepEqual(btn.action.event.context, { optionId: { path: "id" } });
  });

  it("info: url buttons use openUrl, others fire click", () => {
    const { tpl, data } = prepare("info", {
      title: "公告",
      content: "周五团建",
      buttons: [{ label: "详情", url: "https://example.com/a" }, { label: "收到" }],
    });
    const comps = (mod.builder.buildTemplateMessages(tpl, data, { closed: false }, "s", {}) as any[])[1].updateComponents.components;
    const buttons = comps.filter((c: any) => c.component === "Button");
    assert.equal(buttons.length, 2);
    assert.deepEqual(buttons[0].action, { functionCall: { call: "openUrl", args: { url: "https://example.com/a" } } });
    assert.equal(buttons[1].action.event.name, "click");
  });
});

describe("card lifecycle + events", () => {
  it("create sends only the TIMCustomElem card", async () => {
    const client = fakeClient();
    const rec = await createCard(client);
    const sends = client.calls.filter((c) => c.method === "send");
    assert.equal(sends.length, 1);
    assert.ok(isCard(sends[0]!.data));
    assert.equal(sends[0]!.data.im_msg_type, undefined, "no IM-level message type");
    const elem = JSON.parse(sends[0]!.data.msg_body[0].msg_content.data);
    assert.equal(elem.elem_type, 1013);
    assert.equal(rec.revision, 1);
    assert.equal(rec.template, "choice");
    assert.equal(rec.mode, "once");
    const ext = contentOf(sends[0]!)[0].createSurface.metadata.extensions.com_tencent_yuanbao_openclaw;
    assert.equal(ext.template, "choice");
    assert.ok(ext.actionSchemas.select);
  });

  it("refused card falls back to text once per question; retries don't re-send it", async () => {
    const client = fakeClient(() => ({ code: 10002, message: "龙虾发送消息体为空" }));
    for (let i = 0; i < 3; i++) {
      await assert.rejects(createCard(client), (e: any) => {
        assert.ok(e instanceof mod.service.XCardSendError);
        assert.equal(e.kind, "rejected");
        assert.equal(e.fallbackSent, true);
        return true;
      });
    }
    const texts = client.calls.filter((c) => c.method === "send" && !isCard(c.data));
    assert.equal(texts.length, 1);
    assert.match(texts[0]!.data.msg_body[0].msg_content.text, /1\. 火锅/);
    assert.equal(mod.registry.listSurfaces("acct").length, 0);
  });

  it("card over the IM packet budget is rejected before sending", async () => {
    const client = fakeClient();
    const long = "中".repeat(200);
    const fields = Array.from({ length: 12 }, (_, i) => ({ label: `字段${i}`, value: long }));
    await assert.rejects(
      createTemplate(client, "info", { title: "公告", content: "中".repeat(1000), fields }),
      (e: any) => e instanceof mod.service.XCardSendError && e.kind === "too_large",
    );
    assert.equal(client.calls.filter((c) => c.method === "send").length, 0);
    assert.equal(mod.registry.listSurfaces("acct").length, 0);
  });

  it("code 0 + 'bot rate limited' is a failure and sends no fallback", async () => {
    const client = fakeClient(() => ({ code: 0, message: "bot rate limited" }));
    await assert.rejects(createCard(client), (e: any) => e.kind === "rate_limited" && e.fallbackSent === false);
    assert.equal(client.calls.filter((c) => c.method === "send").length, 1);
    assert.equal(mod.registry.listSurfaces("acct").length, 0);
  });

  it("waiting tool call is resolved directly, without the session queue; card closes", async () => {
    const client = fakeClient();
    const rec = await createCard(client);
    const waiting = mod.registry.waitForSurfaceAction(rec, 5000);
    await handleEventPush(pushBytes({ requestId: "r1", surfaceId: rec.surfaceId }), client);
    const outcome = await waiting;
    assert.equal(outcome.status, "action");
    assert.ok(outcome.status === "action");
    assert.equal(outcome.result.context.optionLabel, "烧烤");
    assert.equal(outcome.result.summary, "选择了「烧烤」");
    assert.equal(enqueued.length, 0);
    assert.deepEqual(receipts(client), ["accepted"]);
    const receipt = envelopeOf(client.calls.find((c) => c.method === "receipt")!).content;
    assert.equal(receipt.protocol_version, "1.0");
    assert.equal(receipt.card_message_id, "card-message");
    assert.equal(receipt.surface_id, rec.surfaceId);
    assert.deepEqual(receipt.action_ack, {
      event_id: "r1", success: true, error_code: "", error_message: "",
    });
    const upd = client.calls.find((c) => c.method === "update")!;
    assert.equal(modelOf(contentOf(upd)).ui.resultText, "已选择：烧烤");
    assert.equal(rec.state, "completed");
    assert.equal(rec.revision, 2);
  });

  it("without a waiter the event wakes the group session as a new turn", async () => {
    const client = fakeClient();
    const rec = await createCard(client);
    await handleEventPush(pushBytes({ requestId: "r1", surfaceId: rec.surfaceId }), client);
    assert.deepEqual(enqueued, [{ accountId: "acct", groupCode: GROUP }]);
    assert.equal(executed.length, 1);
    const ctx = executed[0]!;
    assert.equal(ctx.fromAccount, OWNER);
    assert.equal(ctx.raw.msg_id, undefined);
    assert.equal(ctx.raw.msg_key, undefined);
    assert.equal(typeof ctx.raw.msg_seq, "number");
    assert.match(ctx.rewrittenBody, /卡片「晚饭」上选择了「烧烤」/);
    assert.match(ctx.rewrittenBody, /"kind":"yuanbao_xcard_action"/);
    assert.match(ctx.rewrittenBody, /"optionId":"bbq"/);
    assert.deepEqual(receipts(client), ["accepted"]);
  });

  it("rejects non-owner, stale revision, bad option/event, replays duplicates, closed card and unknown surface", async () => {
    const client = fakeClient();
    const rec = await createCard(client);
    const h = (p: Parameters<typeof pushBytes>[0]) => handleEventPush(pushBytes(p), client);

    await h({ requestId: "a", surfaceId: rec.surfaceId, operator: OTHER });
    await h({ requestId: "b", surfaceId: rec.surfaceId, revision: 7 });
    await h({ requestId: "c", surfaceId: rec.surfaceId, optionId: "nope" });
    await h({ requestId: "c2", surfaceId: rec.surfaceId, action: "submit" });
    await h({ requestId: "d", surfaceId: rec.surfaceId, epoch: "old-epoch" });
    await h({ requestId: "e", surfaceId: rec.surfaceId, protocol: "other/1" });
    await h({ requestId: "f", surfaceId: "missing" });
    assert.deepEqual(receipts(client), [
      "rejected:permission_denied",
      "rejected:stale_revision",
      "rejected:invalid_context",
      "rejected:invalid_action",
      "rejected:epoch_expired",
      "rejected:invalid_payload",
      "rejected:unknown_surface",
    ]);
    assert.equal(enqueued.length, 0);

    client.calls.length = 0;
    await h({ requestId: "ok", surfaceId: rec.surfaceId });
    await h({ requestId: "ok", surfaceId: rec.surfaceId }); // duplicate → replay settled status
    await h({ requestId: "late", surfaceId: rec.surfaceId, revision: 2 }); // after once-close
    assert.deepEqual(receipts(client), ["accepted", "accepted", "rejected:surface_closed"]);
    assert.equal(executed.length, 1);
  });

  it("audience=anyone accepts other members", async () => {
    const client = fakeClient();
    const rec = await createCard(client, "anyone");
    await handleEventPush(pushBytes({ requestId: "r", surfaceId: rec.surfaceId, operator: OTHER }), client);
    assert.deepEqual(receipts(client), ["accepted"]);
    assert.equal(executed[0]?.fromAccount, OTHER);
  });

  it("does not bind cardMessageId from a rejected event", async () => {
    const client = fakeClient();
    const rec = await createCard(client);
    await handleEventPush(pushBytes({
      requestId: "rejected",
      surfaceId: rec.surfaceId,
      operator: OTHER,
      messageId: "attacker-card",
    }), client);
    assert.equal(rec.cardMessageId, undefined);

    await handleEventPush(pushBytes({
      requestId: "accepted",
      surfaceId: rec.surfaceId,
      messageId: "real-card",
    }), client);
    assert.equal(rec.cardMessageId, "real-card");
    assert.deepEqual(receipts(client), ["rejected:permission_denied", "accepted"]);
    const update = envelopeOf(client.calls.filter((call) => call.method === "update")[0]!);
    assert.equal(update.content.card_message_id, "real-card");
  });

  it("waiter times out, aborts, and is cancelled by group /stop", async () => {
    const client = fakeClient();
    const rec = await createCard(client);
    assert.deepEqual(await mod.registry.waitForSurfaceAction(rec, 20), { status: "timeout" });

    const ac = new AbortController();
    const p = mod.registry.waitForSurfaceAction(rec, 5000, ac.signal);
    assert.equal(mod.registry.hasGroupWaiter("acct", GROUP), true);
    ac.abort();
    assert.deepEqual(await p, { status: "cancelled", reason: "aborted" });
    assert.equal(mod.registry.hasGroupWaiter("acct", GROUP), false);

    const q = mod.registry.waitForSurfaceAction(rec, 5000);
    const directPrepared = prepare("choice", DINNER);
    const direct = await mod.service.createTemplateCard({
      account,
      wsClient: client as any,
      groupCode: GROUP,
      isGroup: false,
      sessionKey: `agent:main:yuanbao:direct:${GROUP}`,
      ownerUserId: OWNER,
      audience: "requester",
      template: directPrepared.tpl,
      data: directPrepared.data,
    });
    const directWait = mod.registry.waitForSurfaceAction(direct, 5000);
    abortListener?.("acct", GROUP);
    assert.deepEqual(await q, { status: "cancelled", reason: "stopped" });
    assert.equal(mod.registry.hasSessionWaiter("acct", direct.sessionKey), true);
    mod.registry.cancelWaiter(direct, "test_cleanup");
    assert.deepEqual(await directWait, { status: "cancelled", reason: "test_cleanup" });
  });

  it("hasConversationWaiter separates direct peers sharing the main session key", async () => {
    const mk = (peer: string) => mod.registry.registerSurface({
      surfaceId: `surface-${peer}`,
      accountId: "acct",
      isGroup: false,
      groupCode: peer,
      sessionKey: "agent:main:main",
      kind: "generated",
      title: "t",
      data: {},
      ownerUserId: peer,
      audience: "requester",
      mode: "once",
      fallbackText: "t",
      revision: 1,
    });
    const a = mk("peer-a");
    mk("peer-b");
    const waitA = mod.registry.waitForSurfaceAction(a, 5000);
    // Both peers share sessionKey agent:main:main, yet only peer-a has a waiter.
    assert.equal(mod.registry.hasConversationWaiter("acct", false, "peer-a"), true);
    assert.equal(mod.registry.hasConversationWaiter("acct", false, "peer-b"), false);
    mod.registry.cancelWaiter(a, "test_cleanup");
    assert.deepEqual(await waitA, { status: "cancelled", reason: "test_cleanup" });
    assert.equal(mod.registry.hasConversationWaiter("acct", false, "peer-a"), false);
  });

  it("updateTemplateCard re-renders with new data; failure rolls back", async () => {
    const client = fakeClient();
    const rec = await createCard(client);
    rec.cardMessageId = "card-message";
    const { tpl, data } = prepare("choice", { ...DINNER, question: "改成午饭？" });
    await mod.service.updateTemplateCard(rec, tpl, data, account, client as any);
    assert.equal(rec.revision, 2);
    assert.equal(modelOf(contentOf(client.calls.at(-1)!)).question, "改成午饭？");

    client.sendGroupMessage = async () => ({ msgId: "ws", code: 500, message: "boom" });
    const next = prepare("choice", { ...DINNER, title: "失败" });
    await assert.rejects(mod.service.updateTemplateCard(rec, next.tpl, next.data, account, client as any));
    assert.equal(rec.title, "晚饭");
    assert.equal((rec.data as any).question, "改成午饭？");
    assert.equal(rec.revision, 2);
  });
});

describe("template events", () => {
  const ev = (rec: { surfaceId: string }, requestId: string, action: string, context: Record<string, unknown>, revision = 1) =>
    pushBytes({ requestId, surfaceId: rec.surfaceId, action, context, revision });

  it("choice multiple: empty submit keeps the card open; picked submit closes", async () => {
    const client = fakeClient();
    const rec = await createTemplate(client, "choice", { ...DINNER, multiple: true });
    await handleEventPush(ev(rec, "r1", "submit", { optionIds: [] }), client);
    assert.equal(rec.state, "active");
    await handleEventPush(ev(rec, "r2", "submit", { optionIds: ["hotpot", "bbq"] }), client);
    assert.equal(rec.state, "completed");
    assert.deepEqual(receipts(client), ["accepted", "accepted"]);
    assert.deepEqual(executed[1]!.rewrittenBody.match(/"optionLabels":\[[^\]]*\]/)?.[0], '"optionLabels":["火锅","烧烤"]');
  });

  it("form: missing required keeps open and reports, complete submit closes with values", async () => {
    const client = fakeClient();
    const rec = await createTemplate(client, "form", {
      title: "报名",
      fields: [
        { key: "name", label: "姓名", required: true },
        { key: "size", label: "尺码", type: "select", options: [{ value: "m", label: "M" }, { value: "l", label: "L" }] },
        { key: "agree", label: "同意条款", type: "checkbox", required: true },
        { key: "count", label: "人数", type: "number" },
      ],
    });
    await handleEventPush(ev(rec, "r1", "submit", { name: "", size: ["l"], agree: false }), client);
    assert.equal(rec.state, "active");
    assert.match(executed[0]!.rewrittenBody, /缺少必填项：姓名、同意条款/);
    assert.match(executed[0]!.rewrittenBody, /"missing":\["name","agree"\]/);

    await handleEventPush(ev(rec, "r2", "submit", { name: "张三", size: ["m"], agree: true, count: "3" }), client);
    assert.equal(rec.state, "completed");
    assert.match(executed[1]!.rewrittenBody, /"values":\{"name":"张三","size":"m","agree":true,"count":3\}/);
    const closed = contentOf(client.calls.filter((c) => c.method === "update").at(-1)!);
    assert.equal(modelOf(closed).state.values.name, "张三");
    assert.equal(modelOf(closed).ui.resultText, "已提交");
  });

  it("confirm: cancel closes with result text", async () => {
    const client = fakeClient();
    const rec = await createTemplate(client, "confirm", { title: "删除", content: "确定删除？" });
    await handleEventPush(ev(rec, "r1", "cancel", {}), client);
    assert.equal(rec.state, "completed");
    assert.equal(modelOf(contentOf(client.calls.filter((c) => c.method === "update").at(-1)!)).ui.resultText, "已取消");
  });

  it("item_list: select returns the item, unknown item rejected", async () => {
    const client = fakeClient();
    const rec = await createTemplate(client, "item_list", {
      title: "附近门店",
      items: [{ id: "s1", title: "A 店" }, { id: "s2", title: "B 店" }],
    });
    await handleEventPush(ev(rec, "r0", "select", { itemId: "zz" }), client);
    await handleEventPush(ev(rec, "r1", "select", { itemId: "s2" }), client);
    assert.deepEqual(receipts(client), ["rejected:invalid_context", "accepted"]);
    assert.match(executed[0]!.rewrittenBody, /"itemTitle":"B 店"/);
  });

  it("info: perRevision accepts one click per revision and re-sends the card for the next", async () => {
    const client = fakeClient();
    const rec = await createTemplate(client, "info", { title: "公告", content: "x", buttons: [{ label: "收到" }] });
    await handleEventPush(ev(rec, "r1", "click", { buttonId: "btn1" }), client);
    assert.equal(rec.revision, 2);
    const upd = contentOf(client.calls.filter((c) => c.method === "update").at(-1)!);
    assert.equal(upd.some((message) => message.createSurface), false);
    assert.equal(envelopeOf(client.calls.filter((c) => c.method === "update").at(-1)!).content.state_update.state_seq, 2);
    await handleEventPush(ev(rec, "r2", "click", { buttonId: "btn1" }), client); // still revision 1
    await handleEventPush(ev(rec, "r3", "click", { buttonId: "btn1" }, 2), client);
    assert.deepEqual(receipts(client), ["accepted", "rejected:stale_revision", "accepted"]);
    assert.equal(rec.state, "active");
    assert.equal(rec.revision, 3);
    assert.equal(executed.length, 2);
    assert.match(executed[0]!.rewrittenBody, /"buttonLabel":"收到"/);
  });
});

describe("AI-authored generated surfaces", () => {
  const generatedMessages = () => [
    {
      version: "v1.0",
      createSurface: {
        surfaceId: "ai-chosen-id",
        catalogId: "https://yuanbao.tencent.com/specification/v1_0/catalogs/xcard/catalog.json",
        metadata: { extensions: { author: "xcard-generator" } },
      },
    },
    {
      version: "v1.0",
      updateComponents: {
        surfaceId: "ai-chosen-id",
        components: [
          { id: "root", component: "Column", children: ["title", "pick"] },
          { id: "title", component: "Text", text: { path: "/title" }, variant: "h4" },
          {
            id: "pick",
            component: "Button",
            child: "pick-label",
            action: { event: { name: "pick", context: { choice: "a" } } },
          },
          { id: "pick-label", component: "Text", text: "选择 A" },
        ],
      },
    },
    {
      version: "v1.0",
      updateDataModel: { surfaceId: "ai-chosen-id", path: "/", value: { title: "AI 自由卡片" } },
    },
  ] as any[];

  it("parses JSONL, enforces the self-contained subset and extracts actions", () => {
    const lines = generatedMessages().map((m) => JSON.stringify(m)).join("\n");
    const parsed = mod.generated.parseGeneratedMessages(lines);
    assert.ok("messages" in parsed);
    assert.equal(mod.generated.validateGeneratedMessages(parsed.messages).ok, true);
    assert.deepEqual(mod.generated.extractGeneratedActions(parsed.messages), ["pick"]);

    const web = generatedMessages();
    web[1].updateComponents.components[0] = { id: "root", component: "WebCard", uriPath: "/x" };
    const rejected = mod.generated.validateGeneratedMessages(web);
    assert.equal(rejected.ok, false);
    assert.match(rejected.errors.join("\n"), /自包含卡片/);
  });

  it("assigns a trusted surface id, injects metadata and accepts declared events", async () => {
    const client = fakeClient();
    const rec = await mod.service.createGeneratedCard({
      account,
      wsClient: client as any,
      groupCode: GROUP,
      sessionKey: `agent:main:yuanbao:group:${GROUP}`,
      ownerUserId: OWNER,
      audience: "requester",
      mode: "once",
      title: "AI 自由卡片",
      fallbackText: "请选择 A",
      messages: generatedMessages(),
    });
    assert.equal(rec.kind, "generated");
    assert.notEqual(rec.surfaceId, "ai-chosen-id");
    assert.deepEqual(rec.actions, ["pick"]);

    const sent = contentOf(client.calls[0]!);
    assert.equal(sent[0].createSurface.surfaceId, rec.surfaceId);
    assert.equal(sent[1].updateComponents.surfaceId, rec.surfaceId);
    assert.equal(sent[2].updateDataModel.surfaceId, rec.surfaceId);
    assert.deepEqual(sent[3].updateDataModel, {
      surfaceId: rec.surfaceId,
      path: "/__openclaw",
      value: {
        state: "active",
        completed: false,
        revision: 1,
        action: "",
        context: {},
        resultText: "",
      },
    });
    const ext = sent[0].createSurface.metadata.extensions.com_tencent_yuanbao_openclaw;
    assert.equal(ext.source, "generated");
    assert.deepEqual(Object.keys(ext.actionSchemas), ["pick"]);

    await handleEventPush(
      pushBytes({
        requestId: "generated-r1",
        surfaceId: rec.surfaceId,
        action: "pick",
        context: { choice: "a", resultText: "已选择 A" },
      }),
      client,
    );
    assert.deepEqual(receipts(client), ["accepted"]);
    assert.equal(rec.state, "completed");
    assert.equal(executed.length, 1);
    assert.match(executed[0]!.rewrittenBody, /"source":"generated"/);
    assert.match(executed[0]!.rewrittenBody, /"choice":"a"/);
    const updated = contentOf(client.calls.filter((call) => call.method === "update").at(-1)!);
    assert.equal(updated[0].updateComponents.components[0].enabled, false);
    assert.deepEqual(updated.at(-1).updateDataModel, {
      surfaceId: rec.surfaceId,
      path: "/__openclaw",
      value: {
        state: "completed",
        completed: true,
        revision: 2,
        action: "pick",
        context: { choice: "a", resultText: "已选择 A" },
        resultText: "已选择 A",
      },
    });
    assert.equal(generatedMessages()[1].updateComponents.components[0].enabled, undefined);
  });

  it("updates a generated card in place without another createSurface", async () => {
    const client = fakeClient();
    const rec = await mod.service.createGeneratedCard({
      account,
      wsClient: client as any,
      groupCode: GROUP,
      sessionKey: `agent:main:yuanbao:group:${GROUP}`,
      ownerUserId: OWNER,
      audience: "requester",
      mode: "perRevision",
      title: "五子棋",
      fallbackText: "初始棋盘",
      messages: generatedMessages(),
    });
    rec.cardMessageId = "server-card-id";
    const replacement = generatedMessages();
    replacement[1].updateComponents.components[2].action.event.name = "gomoku_move";
    replacement[2].updateDataModel.value.title = "五子棋 · 第 2 回合";

    await mod.service.updateGeneratedCard(
      rec,
      replacement,
      "五子棋 · 第 2 回合",
      "棋盘已更新",
      account,
      client as any,
    );

    assert.equal(rec.revision, 2);
    assert.equal(rec.title, "五子棋 · 第 2 回合");
    assert.equal(rec.fallbackText, "棋盘已更新");
    assert.deepEqual(rec.actions, ["gomoku_move"]);
    assert.equal(client.calls.filter((call) => call.method === "send").length, 1);
    assert.equal(client.calls.filter((call) => call.method === "update").length, 1);
    const updated = contentOf(client.calls.filter((call) => call.method === "update")[0]!);
    assert.equal(updated.some((message) => message.createSurface), false);
    assert.equal(updated[0].updateComponents.surfaceId, rec.surfaceId);
    assert.equal(updated[1].updateDataModel.value.title, "五子棋 · 第 2 回合");
  });

  it("creates, operates, and updates a generated card in a direct conversation", async () => {
    const client = fakeClient();
    const sessionKey = `agent:main:yuanbao:direct:${OWNER}`;
    const rec = await mod.service.createGeneratedCard({
      account,
      wsClient: client as any,
      groupCode: OWNER,
      isGroup: false,
      sessionKey,
      ownerUserId: OWNER,
      audience: "requester",
      mode: "perRevision",
      title: "私聊卡片",
      fallbackText: "请选择 A",
      messages: generatedMessages(),
    });
    assert.equal(rec.isGroup, false);
    assert.equal(client.calls[0]?.method, "c2c");
    assert.equal(client.calls[0]?.data.to_account, OWNER);

    const outer = JSON.parse(new TextDecoder().decode(pushBytes({
      requestId: "direct-r1",
      surfaceId: rec.surfaceId,
      messageId: "direct-card-id",
      action: "pick",
      context: { choice: "a" },
    })));
    await mod.events.handleXCardUpEvent(
      { from_account: OWNER } as any,
      JSON.parse(outer.payload),
      deps(client),
      false,
    );

    assert.deepEqual(receipts(client), ["accepted"]);
    assert.equal(rec.revision, 2);
    assert.equal(executed[0]?.isGroup, false);
    for (const call of client.calls.filter((item) => item.method === "receipt" || item.method === "update")) {
      assert.equal(call.data.to_account, OWNER);
      assert.equal(call.data.group_code, undefined);
    }
  });

  it("rejects an event not declared by the generated component tree", async () => {
    const client = fakeClient();
    const rec = await mod.service.createGeneratedCard({
      account,
      wsClient: client as any,
      groupCode: GROUP,
      sessionKey: `agent:main:yuanbao:group:${GROUP}`,
      ownerUserId: OWNER,
      audience: "requester",
      mode: "perRevision",
      title: "AI 自由卡片",
      fallbackText: "请选择 A",
      messages: generatedMessages(),
    });
    await handleEventPush(
      pushBytes({ requestId: "generated-bad", surfaceId: rec.surfaceId, action: "delete_all", context: {} }),
      client,
    );
    assert.deepEqual(receipts(client), ["rejected:invalid_action"]);
    assert.equal(rec.state, "active");
    assert.equal(executed.length, 0);
  });

  it("perRevision generated cards accept one declared event per revision", async () => {
    const client = fakeClient();
    const rec = await mod.service.createGeneratedCard({
      account,
      wsClient: client as any,
      groupCode: GROUP,
      sessionKey: `agent:main:yuanbao:group:${GROUP}`,
      ownerUserId: OWNER,
      audience: "anyone",
      mode: "perRevision",
      title: "AI 自由卡片",
      fallbackText: "请选择 A",
      messages: generatedMessages(),
    });
    const previousExpiry = Date.now() + 1_000;
    rec.expiresAt = previousExpiry;
    const submit = (requestId: string, revision: number) => handleEventPush(
      pushBytes({ requestId, surfaceId: rec.surfaceId, action: "pick", context: { choice: "a" }, revision, operator: OTHER }),
      client,
    );
    await submit("generated-v1", 1);
    await submit("generated-stale", 1);
    await submit("generated-v2", 2);
    assert.deepEqual(receipts(client), ["accepted", "rejected:stale_revision", "accepted"]);
    assert.equal(rec.state, "active");
    assert.equal(rec.revision, 3);
    assert.ok(rec.expiresAt > previousExpiry);
    assert.equal(executed.length, 2);
    const updated = contentOf(client.calls.filter((call) => call.method === "update").at(-1)!);
    assert.equal(updated[0].updateComponents.components[0].enabled, undefined);
    assert.deepEqual(updated.at(-1).updateDataModel.value, {
      state: "active",
      completed: false,
      revision: 3,
      action: "pick",
      context: { choice: "a" },
      resultText: "触发了事件「pick」",
    });
  });
});

describe("im1007 transport", () => {
  const acct1007 = { accountId: "acct", botId: "bot-1" } as any;
  const elemOf = (call: Call) => JSON.parse(call.data.msg_body[0].msg_content.data);
  const envelopeOf = (call: Call) => JSON.parse(elemOf(call).text);
  const downEvents = (client: ReturnType<typeof fakeClient>) =>
    client.calls.filter((c) => ["receipt", "update"].includes(c.method)).map((c) => envelopeOf(c).content);
  const carrier = (text: string) => ({
    msg_body: [{ msg_type: "TIMCustomElem", msg_content: { data: JSON.stringify({ elem_type: 1013, text }) } }],
  }) as any;
  const upEventMsg = (payload: unknown, from = OWNER, content: unknown = payload) => ({
    group_code: GROUP,
    from_account: from,
    ...carrier(JSON.stringify({ extend_type: 102, content })),
  }) as any;
  const payloadOf = (rec: { surfaceId: string }, requestId: string, revision = 1) => ({
    protocol: "yuanbao.openclaw.xcard/1",
    requestId,
    surfaceId: rec.surfaceId,
    binding: { pluginEpoch: mod.registry.PLUGIN_EPOCH, revision, messageId: "im-card" },
    event: { version: "v1.0", action: { name: "select", surfaceId: rec.surfaceId, context: { optionId: "bbq" } } },
  });

  async function create1007(client: ReturnType<typeof fakeClient>) {
    const p = prepare("choice", DINNER);
    return mod.service.createTemplateCard({
      account: acct1007,
      wsClient: client as any,
      groupCode: GROUP,
      sessionKey: `agent:main:yuanbao:group:${GROUP}`,
      ownerUserId: OWNER,
      audience: "requester",
      template: p.tpl,
      data: p.data,
    });
  }

  it("card is a 1013 elem whose text envelope has extend_type 101 and the A2UI array as content", async () => {
    const client = fakeClient(() => ({ code: 0, message: "" })); // no IM id returned
    const rec = await create1007(client);
    const el = elemOf(client.calls[0]!);
    assert.equal(el.elem_type, 1013);
    assert.deepEqual(Object.keys(el), ["elem_type", "text"]);
    const env = JSON.parse(el.text);
    assert.equal(env.extend_type, 101);
    assert.ok(Array.isArray(env.content), "content is embedded, not serialized again");
    assert.equal(env.content[0].createSurface.surfaceId, rec.surfaceId);
    assert.equal(mod.im1007.im1007Transport.canUpdate(rec), false);
    rec.cardMessageId = "im-card";
    assert.equal(mod.im1007.im1007Transport.canUpdate(rec), true);
  });

  it("parses only extend_type 102 upevents; plain 1013 / link 1007 and other elems are left alone", () => {
    const p = { requestId: "r" };
    assert.deepEqual(mod.im1007.parseIm1007UpEvent(upEventMsg(p)), p);
    const clientPayload = {
      protocol_version: "1.0",
      event_id: "client-r",
      card_message_id: "im-card",
      surface_id: "surface-client",
      event_name: "select",
      context_json: JSON.stringify({ date: "10/16", weekday: "周五" }),
      card_revision: 2,
      source_component_id: "option",
      user_message: "我选了：烧烤",
    };
    const clientMsg = upEventMsg(clientPayload);
    clientMsg.msg_body[0].msg_type = "TIMTextElem"; // production proxy's current label
    assert.deepEqual(mod.im1007.parseIm1007UpEvent(clientMsg), {
      protocol: "yuanbao.openclaw.xcard/1",
      requestId: "client-r",
      surfaceId: "surface-client",
      binding: { revision: 2, messageId: "im-card" },
      event: {
        version: "1.0",
        action: {
          name: "select",
          surfaceId: "surface-client",
          context: { date: "10/16", weekday: "周五" },
          sourceComponentId: "option",
          userMessage: "我选了：烧烤",
        },
      },
    });
    assert.deepEqual(mod.im1007.parseIm1007UpEvent(upEventMsg(p, OWNER, "not an object")), {});
    const link = { msg_body: [{ msg_type: "TIMCustomElem", msg_content: { data: JSON.stringify({ elem_type: 1007, content: "{\"link\":\"https://a.b\"}" }) } }] } as any;
    assert.equal(mod.im1007.parseIm1007UpEvent(link), null);
    assert.equal(mod.im1007.parseIm1007UpEvent(carrier(JSON.stringify({ extend_type: 101, content: [] }))), null);
    // ordinary markdown cards, including markdown whose text happens to be JSON
    assert.equal(mod.im1007.parseIm1007UpEvent(carrier("**hi**")), null);
    assert.equal(mod.im1007.parseIm1007UpEvent(carrier("{\"a\":1}")), null);
    assert.equal(mod.im1007.parseIm1007UpEvent({ msg_body: [{ msg_type: "TIMTextElem", msg_content: { text: "hi" } }] } as any), null);
  });

  it("accepts the production snake_case 102 payload end-to-end", async () => {
    const client = fakeClient();
    const rec = await create1007(client);
    const msg = upEventMsg({
      protocol_version: "1.0",
      event_id: "client-event",
      card_message_id: "server-card-id",
      surface_id: rec.surfaceId,
      event_name: "select",
      event_context: { optionId: "bbq" },
      card_revision: 1,
    });
    msg.msg_body[0].msg_type = "TIMTextElem";
    const payload = mod.im1007.parseIm1007UpEvent(msg);
    assert.ok(payload);
    await mod.events.handleXCardUpEvent(msg, payload, { ...deps(client), account: acct1007 });
    const evs = downEvents(client);
    assert.equal(evs[0].card_message_id, "server-card-id");
    assert.equal(evs[0].action_ack.event_id, "client-event");
    assert.equal(evs[0].action_ack.success, true);
    assert.equal(evs[1].state_update.operation, "snapshot");
    assert.equal(evs[1].state_update.state_seq, 2);
    assert.equal(evs[1].state_update.content.some((message: any) => message.createSurface), false);
    assert.equal(rec.state, "completed");
  });

  it("upevent → downevent receipt + downevent update; sender is the operator", async () => {
    const client = fakeClient();
    const rec = await create1007(client);
    const d = { ...deps(client), account: acct1007 };
    await mod.events.handleXCardUpEvent(upEventMsg(payloadOf(rec, "r0"), OTHER), payloadOf(rec, "r0"), d);
    await mod.events.handleXCardUpEvent(upEventMsg(payloadOf(rec, "r1")), payloadOf(rec, "r1"), d);
    const evs = downEvents(client);
    assert.deepEqual(
      evs.map((e) => e.action_ack
        ? `ack:${e.action_ack.success ? "accepted" : `rejected:${e.action_ack.error_code}`}`
        : `state:${e.state_update.state_seq}`),
      ["ack:rejected:permission_denied", "ack:accepted", "state:2"],
    );
    assert.equal(evs[1].action_ack.event_id, "r1");
    assert.equal(evs[2].surface_id, rec.surfaceId);
    assert.equal(evs[2].card_message_id, "im-card");
    assert.equal(evs[2].state_update.content.some((message: any) => message.createSurface), false);
    assert.equal(rec.state, "completed");
    assert.equal(executed.length, 1);
  });

  it("original link-understanding extraction ignores xCard carrier elems", () => {
    assert.equal(mod.linkCard.extractLinkCard({ elem_type: 1013, text: JSON.stringify({ extend_type: 102, content: { requestId: "r" } }) }), undefined);
    assert.match(mod.linkCard.extractLinkCard({ elem_type: 1007, content: "{\"link\":\"https://a.b\"}" }) ?? "", /https:\/\/a\.b/);
  });
});

describe("A2UI validation", () => {
  const S = "x";
  const base = (components: unknown[]) => [
    { version: "v1.0", createSurface: { surfaceId: S, catalogId: "https://yuanbao.tencent.com/specification/v1_0/catalogs/xcard/catalog.json" } },
    { version: "v1.0", updateComponents: { surfaceId: S, components } },
  ];

  it("rejects structural mistakes", () => {
    const v = (msgs: any[], maxBytes?: number) => mod.validate.validateA2uiMessages(msgs, maxBytes);
    assert.equal(v(base([{ id: "root", component: "Text", text: "hi" }])).ok, true);
    assert.equal(v(base([{ id: "main", component: "Text", text: "hi" }])).ok, false, "missing root");
    assert.equal(v(base([{ id: "root", component: { Text: { text: "x" } } }])).ok, false, "nested v0.8 shape");
    assert.equal(v(base([{ id: "root", component: "Foo" }])).ok, false, "unknown component");
    assert.equal(v(base([{ id: "root", component: "Column", children: ["nope"] }])).ok, false, "dangling ref");
    assert.equal(v([{ version: "v0.9", createSurface: { surfaceId: S } }]).ok, false, "old version");
    assert.equal(v(base([{ id: "root", component: "Text" }]).reverse()).ok, false, "createSurface not first");
    const basic = base([{ id: "root", component: "Text", text: "hi" }]);
    (basic[0] as any).createSurface.catalogId = "https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json";
    assert.equal(v(basic).ok, false, "non-xcard catalog");
    assert.equal(v(base([{ id: "root", component: "Text", text: "x".repeat(200) }]), 100).ok, false, "too large");
  });
});

describe("renderer errors", () => {
  it("rejects a renderer error submitted from a different conversation", async () => {
    const client = fakeClient();
    const rec = await createCard(client, "anyone");
    const outer = JSON.parse(new TextDecoder().decode(pushBytes({
      requestId: "cross-conversation-error",
      surfaceId: rec.surfaceId,
      event: {
        version: "v1.0",
        error: {
          code: "MIN_RENDERER_VERSION_NOT_SATISFIED",
          surfaceId: rec.surfaceId,
          message: "need 2.0",
        },
      },
    })));

    await mod.events.handleXCardUpEvent(
      { from_account: OWNER } as any,
      JSON.parse(outer.payload),
      deps(client),
      false,
    );

    assert.deepEqual(receipts(client), ["rejected:permission_denied"]);
    assert.equal(rec.state, "active");
    assert.equal(rec.lastError, undefined);
    assert.equal(client.calls.some((c) => c.method === "update"), false);
  });

  it("MIN_RENDERER_VERSION_NOT_SATISFIED closes the card, sends fallback, ends the waiter", async () => {
    const client = fakeClient();
    const rec = await createCard(client);
    const waiting = mod.registry.waitForSurfaceAction(rec, 5000);
    await handleEventPush(pushBytes({
      requestId: "e1",
      surfaceId: rec.surfaceId,
      event: { version: "v1.0", error: { code: "MIN_RENDERER_VERSION_NOT_SATISFIED", surfaceId: rec.surfaceId, message: "need 2.0" } },
    }), client);
    assert.deepEqual(await waiting, { status: "cancelled", reason: "renderer_error:MIN_RENDERER_VERSION_NOT_SATISFIED" });
    assert.equal(rec.state, "cancelled");
    assert.equal(rec.lastError?.code, "MIN_RENDERER_VERSION_NOT_SATISFIED");
    assert.ok(client.calls.some((c) => c.method === "update"));
    const text = client.calls.find((c) => c.method === "send" && !isCard(c.data));
    assert.match(text!.data.msg_body[0].msg_content.text, /1\. 火锅/);
    assert.deepEqual(receipts(client), ["accepted"]);
    assert.equal(executed.length, 0);
  });

  it("other renderer errors are recorded only", async () => {
    const client = fakeClient();
    const rec = await createCard(client);
    await handleEventPush(pushBytes({
      requestId: "e2",
      surfaceId: rec.surfaceId,
      event: { version: "v1.0", error: { code: "VALIDATION_FAILED", surfaceId: rec.surfaceId, message: "bad", path: "/x" } },
    }), client);
    assert.equal(rec.state, "active");
    assert.equal(rec.lastError?.code, "VALIDATION_FAILED");
    assert.equal(client.calls.filter((c) => c.method !== "receipt").length, 1);
  });
});

describe("reply heartbeat pause", () => {
  it("skips RUNNING ticks for a paused group and resumes after release", async () => {
    const hb = await import("../outbound/heartbeat.js");
    let sent = 0;
    const wsClient = {
      async sendGroupHeartbeat() {
        sent++;
        return { code: 0, message: "" };
      },
    };
    const ctrl = hb.createReplyHeartbeatController({
      meta: { ctx: { wsClient } as any, account: { accountId: "acct", botId: "bot-1" } as any, toAccount: OWNER, groupCode: GROUP },
      runningIntervalMs: 10,
    });
    const release = hb.pauseGroupReplyHeartbeat("acct", GROUP);
    ctrl.emit(1);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(sent, 0);
    release();
    release(); // idempotent
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(sent > 0);
    ctrl.stop();
  });
});
