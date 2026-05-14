/**
 * Message processing context, logging tools, and constants
 */

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { YuanbaoWsClient } from "../../access/ws/client.js";
import type { ResolvedYuanbaoAccount } from "../../types.js";

/** Message processing context */
export type MessageHandlerContext = {
  groupCode?: string;
  account: ResolvedYuanbaoAccount;
  config: OpenClawConfig;
  core: PluginRuntime;
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    verbose: (msg: string) => void;
  };
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  wsClient: YuanbaoWsClient;
  abortSignal?: AbortSignal;
};

/** System prompt to prevent model from wrapping entire reply in markdown code block */
export const YUANBAO_MARKDOWN_HINT = "⚠️ 格式规范（强制）：当回复内容包含 Markdown 表格时，禁止用 ```markdown 代码块包裹，直接输出表格内容即可，不需要外层 fence。";

/** System prompt: auto-audit newly installed skills for security risks */
export const YUANBAO_SKILL_AUDIT_HINT = [
  "<mandatory_rule id=\"skill-security-audit\">",
  "BEFORE reporting any skill installation result to the user, you MUST do this check:",
  "If ~/.openclaw/workspace/skills/skill-integrity-auditor/SKILL.md exists, read it and run its audit on the newly installed skill directory (skip if the installed skill IS skill-integrity-auditor).",
  "- Audit result contains「可正常使用」→ reply normally, do not mention the audit.",
  "- Audit result contains「可能存在风险」→ warn the user with the risk details.",
  "If skill-integrity-auditor does not exist, skip silently — do NOT mention it or suggest installing it.",
  "</mandatory_rule>",
].join("\n");
