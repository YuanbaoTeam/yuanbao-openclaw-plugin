/**
 * Message processing pipeline type definitions:
 * pipeline context, middleware function signatures, and descriptors.
 */

import type { EnvelopeFormatOptions } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { FinalizedMsgContext } from "openclaw/plugin-sdk/reply-runtime";
import type { YuanbaoWsClient } from "../../access/ws/client.js";
import type { ModuleLog } from "../../logger.js";
import type { QuoteInfo, YuanbaoInboundMessage, ResolvedYuanbaoAccount } from "../../types.js";
import type { MediaItem, MentionItem } from "../messaging/handlers/types.js";
import type { MessageSender } from "../outbound/types.js";
import type { YuanbaoTraceContext } from "../trace/context.js";
// import type { OutboundReplyPayload } from 'openclaw/plugin-sdk/reply-payload';

/** Message item enqueued by the debouncer */
export interface DebouncerItem {
  msg: YuanbaoInboundMessage;
  isGroup: boolean;
  account: ResolvedYuanbaoAccount;
  config: OpenClawConfig;
  core: PluginRuntime;
  wsClient: YuanbaoWsClient;
  log?:
  | ModuleLog
  | {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    verbose?: (msg: string) => void;
  };
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  abortSignal?: AbortSignal;
}

/** Message processing context — flows through the pipeline, readable/writable by each middleware */
export interface PipelineContext {
  readonly raw: YuanbaoInboundMessage;
  readonly flushedItems: DebouncerItem[];
  readonly isGroup: boolean;
  readonly account: ResolvedYuanbaoAccount;
  readonly config: OpenClawConfig;
  readonly core: PluginRuntime;
  readonly wsClient: YuanbaoWsClient;
  readonly log: ModuleLog;
  readonly abortSignal?: AbortSignal;
  readonly statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;

  // -- Populated by extractContent --
  fromAccount: string;
  senderNickname?: string;
  groupCode?: string;
  rawBody: string;
  medias: MediaItem[];
  isAtBot: boolean;
  mentions: MentionItem[];
  linkUrls: string[];

  // -- Populated by resolveQuote --
  quoteInfo?: QuoteInfo;

  // -- Populated by guardCommand --
  commandAuthorized: boolean;
  rewrittenBody: string;
  hasControlCommand: boolean;
  /** Parsed command parts: [command, ...args], e.g. ["/new"] or ["/reset", "arg1"]. Empty when not a command. */
  commandParts: string[];

  // -- Populated by resolveMention --
  effectiveWasMentioned: boolean;
  /** Topic id parsed from cloud_custom_data (undefined when message is not from a topic). */
  topicId?: string;
  /** True when cloud_custom_data.botMuted === true (L0 — highest-priority skip). */
  isMuted?: boolean;
  /** Records which decision layer produced the final reply/skip verdict. */
  replyDecision?: {
    source: "mute" | "at-mention" | "topic-judge" | "default-gating";
    shouldReply: boolean;
    reason?: string;
  };
  /**
   * Persona text extracted from the topic's soul.md (when the message is
   * scoped to a topic and a soul exists). Injected into the reply agent's
   * `GroupSystemPrompt` by `build-context` so the bot's tone follows the
   * per-topic persona instead of the workspace-level default.
   */
  topicPersona?: string;

  // -- Populated by downloadMedia --
  mediaPaths: string[];
  mediaTypes: string[];

  // -- Populated by resolveRoute --
  route?: {
    agentId: string;
    sessionKey: string;
    accountId: string;
  };
  storePath?: string;
  envelopeOptions?: EnvelopeFormatOptions;
  previousTimestamp?: number;

  // -- Populated by resolveTrace --
  traceContext?: YuanbaoTraceContext;

  // -- Populated by buildContext --
  ctxPayload?: FinalizedMsgContext;

  // -- Populated by prepareSender --
  sender?: MessageSender;

  /** e.g. 'sticker', 'sticker-search', 'react'; undefined for non-action requests */
  action?: string;
}

/** Middleware function signature (onion model) */
export type Middleware = (ctx: PipelineContext, next: () => Promise<void>) => Promise<void>;

export interface MiddlewareDescriptor {
  name: string;
  handler: Middleware;
  /** Skip this middleware when returning false */
  when?: (ctx: PipelineContext) => boolean;
}
