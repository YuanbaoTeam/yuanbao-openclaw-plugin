export type YuanbaoDmConfig = {
  policy?: "pairing" | "allowlist" | "open" | "disabled";
  allowFrom?: Array<string | number>;
};

export type YuanbaoOverflowPolicy = "stop" | "split";
export type YuanbaoReplyToMode = "off" | "first" | "all";
export type YuanbaoLogInfoExt = {
  trace_id?: string;
};

export type YuanbaoConnectionMode = "websocket";

export type YuanbaoAccountConfig = {
  name?: string;
  enabled?: boolean;

  appKey?: string;
  appSecret?: string;
  apiDomain?: string; // API domain
  logUploadApiUrl?: string; // issue-log upload API URL
  wsUrl?: string; // WebSocket URL
  /** Skips automatic ticket signing if provided */
  token?: string;

  dm?: YuanbaoDmConfig;
  overflowPolicy?: YuanbaoOverflowPolicy;
  /** off=no quote, first=quote only first reply per inbound message, all=quote every reply */
  replyToMode?: YuanbaoReplyToMode;
  routeEnv?: string;

  /** Default 20 */
  mediaMaxMb?: number;

  /** 0=disabled, defaults to SDK built-in value */
  historyLimit?: number;

  /** Default false */
  disableBlockStreaming?: boolean;
  /** Default true */
  requireMention?: boolean;
  /** Automatically sent to the user when the AI model returns no reply content */
  fallbackReply?: string;
  /** Default true; prevents model from wrapping entire reply in ```markdown fences */
  markdownHintEnabled?: boolean;
  /** Logs for whitelisted bots are not sanitized */
  debugBotIds?: string[];
  /**
   * Directory holding per-topic soul.md files, one per topic.
   *
   * Layout: `<topicSoulDir>/<topicId>.md`
   *
   * Supports `~` prefix (home directory). Defaults to `~/.openclaw/topic-souls/`
   * when unset. Used by the topic-judge middleware (L2 self-judge) to decide
   * whether the bot should reply inside a topic when not explicitly @-mentioned.
   */
  topicSoulDir?: string;

  /**
   * LLM judge configuration for topic self-judge Phase 2.
   *
   * When enabled (and a topic's soul.md has a `## Auto Reply` section), the
   * bot will run a lightweight judge call **through OpenClaw's own agent
   * pipeline** (see topic-judge/llm-judge.ts::createOpenclawJudgeInvoker) to
   * decide whether to reply in a topic even when rule matching doesn't hit.
   *
   * No external API endpoint / key is required — the judge shares the same
   * agent backend as regular replies, isolated by a `:judge`-suffixed peer id.
   * Operators who want a cheaper model for judge can bind a distinct agent to
   * that peer at the OpenClaw config level.
   *
   * Can also be configured via environment variables:
   * - `YUANBAO_LLM_JUDGE_ENABLED` — "true"/"1" to enable, "false"/"0" to disable
   * - `YUANBAO_LLM_JUDGE_TIMEOUT_MS` — timeout in ms (default: 3000)
   */
  llmJudge?: {
    enabled?: boolean;
    timeoutMs?: number;
  };
};

export type YuanbaoConfig = YuanbaoAccountConfig & {
  accounts?: Record<string, YuanbaoAccountConfig>;
  defaultAccount?: string;
  routeEnv?: string;
};

export type ResolvedYuanbaoAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  appKey?: string;
  appSecret?: string;
  botId?: string;
  /** Cached after WS connect via QueryBotInfoReq; takes priority over per-message bot_owner_id */
  botOwnerId?: string;
  apiDomain?: string; // API domain
  wsUrl?: string; // WebSocket URL
  token?: string;
  wsGatewayUrl: string;
  wsHeartbeatInterval?: number;
  wsMaxReconnectAttempts: number;
  overflowPolicy: YuanbaoOverflowPolicy;
  replyToMode: YuanbaoReplyToMode;
  mediaMaxMb: number;
  historyLimit: number;
  disableBlockStreaming: boolean;
  /** Default true */
  requireMention: boolean;
  /** Automatically sent to the user when the AI model returns no reply content */
  fallbackReply?: string;
  markdownHintEnabled: boolean;
  config: YuanbaoAccountConfig;
};

// Image info array element
export type ImImageInfoArrayItem = {
  type?: number; // original image
  size?: number;
  width?: number;
  height?: number;
  url?: string;
};

// Tencent IM message body element
export type YuanbaoMsgBodyElement = {
  msg_type: string;
  msg_content: {
    text?: string; // text chat content
    uuid?: string; // image
    image_format?: number; // image format
    data?: string; // extension data
    desc?: string; // description
    ext?: string; // extension field
    sound?: string; // voice
    image_info_array?: ImImageInfoArrayItem[]; // image content
    index?: number; // emoji index
    url?: string; // file download URL
    file_size?: number; // file size (bytes)
    file_name?: string; // file name
    /** Extension map, e.g. WeChat forwarded chat record detail for elem_type 1009. */
    ext_map?: Record<string, string>;
    // Extensible fields for other message types
    [key: string]: unknown;
  };
};

// Cloud IM message sequence number (used for message recall)
export type ImMsgSeq = {
  msg_seq?: number;
  msg_id?: string;
  msgId?: string;
};

// Message type enum
export enum EnumCLawMsgType {
  CLAW_MSG_UNKNOWN = 0,
  CLAW_MSG_GROUP = 1,
  CLAW_MSG_PRIVATE = 2,
}

// Tencent IM inbound message
export type YuanbaoInboundMessage = {
  callback_command?: string;
  from_account?: string;
  to_account?: string;
  sender_nickname?: string;
  group_id?: string;
  group_code?: string;
  group_name?: string;
  msg_seq?: number;
  msg_random?: number;
  msg_time?: number;
  msg_key?: string;
  msg_id?: string;
  online_only_flag?: number;
  send_msg_result?: number;
  error_info?: string;
  msg_body?: YuanbaoMsgBodyElement[];
  cloud_custom_data?: string;
  event_time?: number;
  bot_owner_id?: string;
  /** Message sequence number list carried during recall (Group/C2C.CallbackAfterMsgWithDraw) */
  recall_msg_seq_list?: ImMsgSeq[];
  claw_msg_type?: EnumCLawMsgType;
  /** Identifies which group the user initiated the DM from */
  private_from_group_code?: string;
  /** Plugin side generates a fallback when missing */
  trace_id?: string;
  /** Prefers real msg_seq; serves as trace correlation auxiliary field */
  seq_id?: string;
};

// Quote message info (from cloud_custom_data.quote)
export type QuoteInfo = {
  id?: string;
  seq?: number;
  /** Unix seconds */
  time?: number;
  type?: number;
  status?: number;
  desc?: string;
  sender_id?: string;
  sender_nickname?: string;
};

// Parsed structure of cloud_custom_data
export type CloudCustomData = {
  env?: string;
  message_type?: number;
  quote?: QuoteInfo;
  source_group?: string;
  /** Topic id — messages in the same topic share an independent OpenClaw session. */
  topicId?: string;
  /** When true, bot must not reply in this topic (overrides even @mention). */
  botMuted?: boolean;
  [key: string]: unknown;
};

// Tencent IM send message request
export type YuanbaoSendMsgRequest = {
  sync_other_machine?: number;
  from_account?: string;
  to_account: string;
  msg_seq?: number;
  msg_random: number;
  msg_body: YuanbaoMsgBodyElement[];
  log_ext?: YuanbaoLogInfoExt;
  cloud_custom_data?: string;
  offline_push_info?: {
    push_flag?: number;
    desc?: string;
    ext?: string;
  };
};

// Tencent IM send message response
export type YuanbaoSendMsgResponse = {
  action_status: string;
  error_code: number;
  error_info: string;
  msg_time?: number;
  msg_key?: string;
  msg_id?: string;
  msg_seq?: number;
  stream_msg_id?: string;
};

export type YuanbaoSendGroupMsgRequest = {
  group_code: string;
  random: number;
  msg_seq?: number;
  msg_body: YuanbaoMsgBodyElement[];
  from_account?: string;
  log_ext?: YuanbaoLogInfoExt;
  msg_priority?: string;
  cloud_custom_data?: string;
};
