/**
 * Type definitions for the inbound pipeline eval system.
 *
 * Fixtures are JSON files describing an inbound message scenario; the harness
 * drives the real 17-middleware pipeline and captures the dispatchReply params
 * for snapshot-based assertion.
 */

/** Fixture message surface: C2C direct message or group chat. */
export type FixtureMessageType = "c2c" | "group";

/** Media attachment attached to the inbound message. */
export type FixtureAttachment = {
  type: "image";
  url: string;
  filename?: string;
  width?: number;
  height?: number;
  size?: number;
};

/** Quoted message info (serialized into raw.cloud_custom_data.quote). */
export type FixtureQuote = {
  id?: string;
  seq?: number;
  time?: number;
  type?: number;
  status?: number;
  desc?: string;
  sender_id?: string;
  sender_nickname?: string;
};

/** A @mention of another user (not the bot). */
export type FixtureMentionOther = {
  userId: string;
  text: string;
};

/** Abstract inbound message input — harness synthesizes the real msg_body. */
export type FixtureInput = {
  messageType: FixtureMessageType;
  /** Group chat: required. C2C: omitted. */
  groupCode?: string;
  /** Sender account id. */
  fromAccount: string;
  senderNickname?: string;
  /** Text body content (→ TIMTextElem). */
  content: string;
  attachments?: FixtureAttachment[];
  quote?: FixtureQuote;
  /** Group chat: whether the message @mentions the bot. */
  mentionBot?: boolean;
  /** Group chat: other users @mentioned (not the bot). */
  mentionOthers?: FixtureMentionOther[];
  /** Explicit trace id; omitted → resolveTrace generates one (normalized in snapshot). */
  traceId?: string;
  /** Bot owner id (for owner-gated commands). */
  botOwnerId?: string;
  msgId?: string;
  msgSeq?: number;
  groupName?: string;
};

/** Per-fixture harness config (overrides the default account). */
export type FixtureConfig = {
  botUid: string;
  botName?: string;
  botOwnerId?: string;
  requireMention?: boolean;
  historyLimit?: number;
  dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
  dmAllowFrom?: Array<string | number>;
  useAccessGroups?: boolean;
  markdownHintEnabled?: boolean;
  disableBlockStreaming?: boolean;
  /** Control commands recognized by the hasControlCommand mock (defaults to /help, /reset). */
  controlCommands?: string[];
};

/** Optional expected outcome — advisory; the snapshot is the hard gate. */
export type FixtureExpected = {
  /** Whether dispatchReply should be invoked. */
  shouldDispatch?: boolean;
};

/** A single eval fixture. */
export type Fixture = {
  id: string;
  description: string;
  input: FixtureInput;
  config: FixtureConfig;
  expected?: FixtureExpected;
  tags?: string[];
};

/** Captured dispatchReply invocation. */
export type DispatchCapture = {
  called: boolean;
  callCount: number;
  /** Raw params passed to dispatchReplyWithBufferedBlockDispatcher. */
  params: DispatchParams | null;
};

/** Shape of dispatchReplyWithBufferedBlockDispatcher params (subset we care about). */
export type DispatchParams = {
  ctx: Record<string, unknown>;
  cfg: unknown;
  dispatcherOptions: Record<string, unknown>;
  replyOptions?: Record<string, unknown>;
};

/** Flattened, snapshot-friendly view of what the pipeline produced. */
export type AssertableParams = {
  shouldDispatch: boolean;
  agentId?: string;
  sessionKey?: string;
  accountId?: string;
  chatType?: string;
  isGroup: boolean;
  fromAccount?: string;
  senderName?: string;
  groupCode?: string;
  rawBody: string;
  rewrittenBody: string;
  commandBody?: string;
  commandParts: string[];
  hasControlCommand: boolean;
  commandAuthorized: boolean;
  quotePresent: boolean;
  quoteDesc?: string;
  quoteSenderId?: string;
  quoteSenderNickname?: string;
  quoteId?: string;
  isAtBot: boolean;
  effectiveWasMentioned: boolean;
  mediaCount: number;
  mediaPaths: string[];
  mediaTypes: string[];
  ctxBody?: string;
  ctxBodyForAgent?: string;
  ctxRawBody?: string;
  ctxMessageSid?: string;
  traceId?: string;
  seqId?: string;
};

/** Result of running one fixture through the harness. */
export type HarnessResult = {
  fixtureId: string;
  description: string;
  passed: boolean;
  capture: DispatchCapture;
  actual: AssertableParams;
  errors: string[];
  durationMs: number;
};

/** Snapshot file format. */
export type SnapshotData = {
  fixtureId: string;
  snapshotVersion: number;
  captured: AssertableParams;
};
