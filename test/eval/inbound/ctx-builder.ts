/**
 * Build a real PipelineContext from an abstract fixture input.
 *
 * Synthesizes `ctx.raw.msg_body` (TIMTextElem / TIMImageElem / TIMCustomElem)
 * so the REAL extractContent middleware parses it exactly as it would a live
 * inbound message. Fields filled by later middlewares (route, ctxPayload, …)
 * are intentionally left empty — the eval's value is watching them get filled.
 */

import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PipelineContext } from "../../../src/business/pipeline/types.js";
import type {
  ResolvedYuanbaoAccount,
  YuanbaoInboundMessage,
  YuanbaoMsgBodyElement,
} from "../../../src/types.js";
import type { FixtureConfig, FixtureInput } from "./types.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Silent logger matching the ModuleLog shape used by mock-ctx.ts. */
const SILENT_LOG = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  verbose: () => {},
};

/** Build a TIMCustomElem @mention element (elem_type 1002). */
function buildMentionElement(text: string, userId: string): YuanbaoMsgBodyElement {
  return {
    msg_type: "TIMCustomElem",
    msg_content: {
      data: JSON.stringify({ elem_type: 1002, text, user_id: userId }),
    },
  };
}

/** Build a TIMImageElem from a fixture attachment. */
function buildImageElement(att: FixtureInput["attachments"] extends Array<infer T> ? T : never): YuanbaoMsgBodyElement {
  return {
    msg_type: "TIMImageElem",
    msg_content: {
      uuid: att.filename ?? "image",
      image_info_array: [
        {
          type: 1,
          url: resolveAttachmentUrl(att.url),
          width: att.width,
          height: att.height,
          size: att.size,
        },
      ],
    },
  };
}

/**
 * Resolve a fixture attachment URL.
 *
 * `fixture:<name>` → absolute `file://` URL pointing at `fixtures/<name>`,
 * so downloadMediaForYuanbao reads the real local file (no network). This
 * keeps fixtures portable (no machine-specific absolute paths) while exercising
 * the real downloadMedia middleware path. Any other URL passes through as-is.
 */
function resolveAttachmentUrl(url: string): string {
  if (url.startsWith("fixture:")) {
    const name = url.slice("fixture:".length);
    return `file://${join(FIXTURES_DIR, name)}`;
  }
  return url;
}

/** Build the YuanbaoInboundMessage (raw) from fixture input. */
function buildRawMessage(input: FixtureInput, config: FixtureConfig): YuanbaoInboundMessage {
  const botName = config.botName ?? "元宝";
  const msgBody: YuanbaoMsgBodyElement[] = [];

  // @mentions first (custom elements), then text, then images — matches IM order.
  if (input.mentionBot) {
    msgBody.push(buildMentionElement(`@${botName}`, config.botUid));
  }
  for (const m of input.mentionOthers ?? []) {
    msgBody.push(buildMentionElement(m.text, m.userId));
  }
  if (input.content) {
    msgBody.push({ msg_type: "TIMTextElem", msg_content: { text: input.content } });
  }
  for (const att of input.attachments ?? []) {
    msgBody.push(buildImageElement(att));
  }

  const msgId = input.msgId ?? `${input.fromAccount}-${input.msgSeq ?? 1}`;

  return {
    from_account: input.fromAccount,
    sender_nickname: input.senderNickname,
    group_code: input.messageType === "group" ? input.groupCode : undefined,
    group_name: input.groupName,
    msg_seq: input.msgSeq ?? 1,
    msg_id: msgId,
    msg_key: msgId,
    msg_time: 1700000000,
    msg_body: msgBody,
    cloud_custom_data: input.quote ? JSON.stringify({ quote: input.quote }) : undefined,
    // Deterministic default so snapshots are stable without per-fixture traceId.
    trace_id: input.traceId ?? "trace-eval-fixed",
    seq_id: input.traceId ?? "trace-eval-fixed",
    bot_owner_id: config.botOwnerId ?? input.botOwnerId,
  };
}

/** Build a ResolvedYuanbaoAccount with eval-safe defaults (no fallbackReply). */
function buildAccount(config: FixtureConfig, input: FixtureInput): ResolvedYuanbaoAccount {
  return {
    accountId: "bot-eval",
    enabled: true,
    configured: true,
    botId: config.botUid,
    botOwnerId: config.botOwnerId ?? input.botOwnerId,
    wsGatewayUrl: "ws://eval-stub",
    wsHeartbeatInterval: 0,
    wsMaxReconnectAttempts: 0,
    overflowPolicy: "stop",
    replyToMode: "off",
    mediaMaxMb: 20,
    historyLimit: config.historyLimit ?? 10,
    disableBlockStreaming: config.disableBlockStreaming ?? false,
    requireMention: config.requireMention ?? true,
    markdownHintEnabled: config.markdownHintEnabled ?? true,
    // No fallbackReply — avoids triggering sender.sendText WS I/O when dispatch
    // capture returns void and queueSession.flush() reports no content.
    config: {
      dm: {
        policy: config.dmPolicy ?? "open",
        allowFrom: config.dmAllowFrom ?? [],
      },
    },
  } as ResolvedYuanbaoAccount;
}

/**
 * Assemble a PipelineContext from a fixture input + eval core mock.
 *
 * The returned ctx is ready for `pipeline.execute(ctx)`. extractContent will
 * populate fromAccount/rawBody/medias/isAtBot from `raw.msg_body`; downstream
 * middlewares fill the rest.
 */
export function buildPipelineContext(
  input: FixtureInput,
  config: FixtureConfig,
  core: PluginRuntime,
): PipelineContext {
  const raw = buildRawMessage(input, config);
  const account = buildAccount(config, input);
  const openclawConfig = {
    commands: { useAccessGroups: config.useAccessGroups ?? true },
  } as PipelineContext["config"];

  return {
    raw,
    flushedItems: [],
    isGroup: input.messageType === "group",
    account,
    config: openclawConfig,
    core,
    wsClient: {} as PipelineContext["wsClient"],
    log: SILENT_LOG,
    // Pre-extraction defaults — extractContent overwrites these from raw.
    fromAccount: "",
    senderNickname: undefined,
    groupCode: undefined,
    rawBody: "",
    medias: [],
    isAtBot: false,
    mentions: [],
    linkUrls: [],
    quoteInfo: undefined,
    commandAuthorized: false,
    rewrittenBody: "",
    hasControlCommand: false,
    commandParts: [],
    effectiveWasMentioned: false,
    mediaPaths: [],
    mediaTypes: [],
    route: undefined,
    storePath: undefined,
    envelopeOptions: undefined,
    previousTimestamp: undefined,
    traceContext: undefined,
    ctxPayload: undefined,
    sender: undefined,
    queueSession: undefined,
    action: undefined,
  } as PipelineContext;
}
