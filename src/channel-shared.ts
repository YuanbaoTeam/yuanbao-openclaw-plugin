/**
 * Shared building blocks for the Yuanbao channel plugin.
 *
 * Both the full `yuanbaoPlugin` (used at runtime) and the lightweight
 * `yuanbaoSetupPlugin` (used during `openclaw onboard` / `openclaw configure`)
 * consume these helpers. Keeping them out of `channel.ts` prevents the setup
 * surface from pulling in the full runtime dependencies (WS gateway, message
 * actions, HTTP clients, protobuf, etc.).
 */

import {
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  setAccountEnabledInConfigSection,
} from "openclaw/plugin-sdk/channel-plugin-common";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import {
  listYuanbaoAccountIds,
  resolveDefaultYuanbaoAccountId,
  resolveYuanbaoAccount,
} from "./accounts.js";
import { yuanbaoConfigSchema } from "./config-schema.js";
import { yuanbaoSetupAdapter } from "./setup-core.js";
import { yuanbaoSetupWizard } from "./setup-surface.js";
import type { ResolvedYuanbaoAccount } from "./types.js";

export const YUANBAO_CHANNEL_ID = "openclaw-plugin-yuanbao" as const;

export const yuanbaoMeta = {
  id: YUANBAO_CHANNEL_ID,
  label: "Yuanbao",
  selectionLabel: "Yuanbao (腾讯元宝)",
  detailLabel: "Yuanbao",
  docsPath: "/plugins/community#yuanbao",
  docsLabel: "yuanbao",
  blurb: "Tencent Yuanbao AI assistant conversation channel",
  aliases: ["yb", "tencent-yuanbao", "元宝"],
  order: 85,
  quickstartAllowFrom: true,
} as const;

export const yuanbaoCapabilities = {
  chatTypes: ["direct", "group"] as Array<"direct" | "group">,
  media: true,
  reactions: true,
  threads: false,
  polls: false,
  nativeCommands: true,
};

export const yuanbaoReload: { configPrefixes: string[] } = {
  configPrefixes: ["channels.yuanbao"],
};

/**
 * Config adapter shared by the full plugin and the setup-only plugin.
 *
 * Note: only imports from `accounts.js`, which stays lightweight (no WS/HTTP
 * runtime). Keep it that way — heavy runtime imports belong in `channel.ts`.
 */
export const yuanbaoConfigAdapter = {
  listAccountIds: (cfg: OpenClawConfig) => listYuanbaoAccountIds(cfg),
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) =>
    resolveYuanbaoAccount({ cfg, accountId: accountId ?? undefined }),
  defaultAccountId: (cfg: OpenClawConfig) => resolveDefaultYuanbaoAccountId(cfg),
  setAccountEnabled: ({
    cfg,
    accountId,
    enabled,
  }: {
    cfg: OpenClawConfig;
    accountId: string;
    enabled: boolean;
  }) =>
    setAccountEnabledInConfigSection({
      cfg,
      sectionKey: YUANBAO_CHANNEL_ID,
      accountId,
      enabled,
      allowTopLevel: true,
    }),
  deleteAccount: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) =>
    deleteAccountFromConfigSection({
      cfg,
      sectionKey: YUANBAO_CHANNEL_ID,
      accountId,
      clearBaseFields: [
        "name",
        "appKey",
        "appSecret",
        "token",
        "overflowPolicy",
        "replyToMode",
        "outboundQueueStrategy",
        "mediaMaxMb",
        "historyLimit",
        "disableBlockStreaming",
        "fallbackReply",
      ],
    }),
  isConfigured: (account: ResolvedYuanbaoAccount | undefined) =>
    Boolean(account?.configured),
  describeAccount: (account: ResolvedYuanbaoAccount | undefined) => ({
    accountId: account?.accountId ?? DEFAULT_ACCOUNT_ID,
    name: account?.name,
    enabled: account?.enabled ?? false,
    configured: account?.configured ?? false,
    tokenStatus: account?.configured ? "available" : "missing",
  }),
  resolveAllowFrom: ({
    cfg,
    accountId,
  }: {
    cfg: OpenClawConfig;
    accountId?: string | null;
  }) => {
    const account = resolveYuanbaoAccount({ cfg, accountId: accountId ?? undefined });
    return (account.config.dm?.allowFrom ?? []).map((entry) => String(entry));
  },
  formatAllowFrom: ({ allowFrom }: { allowFrom: Array<string | number> | undefined | null }) =>
    (allowFrom ?? [])
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map((entry) => entry.toLowerCase()),
};

/** Re-export the shared setup adapter / wizard for call sites that pull them from one place. */
export { yuanbaoSetupAdapter, yuanbaoSetupWizard };

/** Shared config schema re-export. */
export { yuanbaoConfigSchema };
