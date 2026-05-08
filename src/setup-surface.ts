import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";
import {
  createStandardChannelSetupStatus,
  setSetupChannelEnabled,
  patchTopLevelChannelConfigSection,
} from "openclaw/plugin-sdk/setup";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { resolveYuanbaoAccount } from "./accounts.js";
import type { YuanbaoConfig } from "./types.js";

const CHANNEL = "yuanbao" as const;

/**
 * Declarative setup wizard for the Yuanbao channel.
 *
 * Guides users through configuring appKey and appSecret (Gateway credentials)
 * during `openclaw setup` / onboard flows.
 */
export const yuanbaoSetupWizard: ChannelSetupWizard = {
  channel: CHANNEL,

  status: createStandardChannelSetupStatus({
    channelLabel: "YuanBao Bot",
    configuredLabel: "configured",
    unconfiguredLabel: "needs AppID + AppSecret",
    configuredHint: "configured",
    unconfiguredHint: "needs credentials",
    configuredScore: 2,
    unconfiguredScore: 0,
    includeStatusLine: true,
    resolveConfigured: ({ cfg }) => {
      const account = resolveYuanbaoAccount({ cfg });
      return account.configured;
    },
    resolveExtraStatusLines: async ({ cfg, configured }) => {
      if (!configured) return [];
      const account = resolveYuanbaoAccount({ cfg });
      return [`  AppID: ${account.appKey ?? "?"}`];
    },
  }),

  introNote: {
    title: "YuanBao Bot credentials",
    lines: [
      "You'll need values from YuanBao APP:",
      "",
      "• AppID & AppSecret → Create a robot from your YuanBao APP to obtain.",
    ],
    shouldShow: async ({ cfg }) => {
      const account = resolveYuanbaoAccount({ cfg });
      return !account.configured;
    },
  },

  credentials: [
    {
      inputKey: "token",
      providerHint: "YuanBao APP",
      credentialLabel: "AppID",
      helpTitle: "YuanBao AppID",
      helpLines: [
        "The AppID is obtained from your YuanBao robot application settings.",
        "It is used together with App Secret for WebSocket ticket-signing authentication.",
      ],
      envPrompt: "Use YUANBAO_APP_KEY from environment?",
      keepPrompt: "AppID already configured. Keep it?",
      inputPrompt: "Enter AppID (from bot application settings)",
      preferredEnvVar: "YUANBAO_APP_KEY",
      inspect: ({ cfg }) => {
        const yuanbaoCfg = cfg.channels?.yuanbao as YuanbaoConfig | undefined;
        const currentValue = yuanbaoCfg?.appKey?.trim() || undefined;
        const envValue = process.env.YUANBAO_APP_KEY?.trim() || undefined;
        return {
          accountConfigured: Boolean(currentValue),
          hasConfiguredValue: Boolean(currentValue),
          resolvedValue: currentValue,
          envValue,
        };
      },
      applySet: ({ cfg, value }) => patchTopLevelChannelConfigSection({
        cfg,
        channel: CHANNEL,
        patch: { appKey: value },
      }),
    },
    {
      inputKey: "privateKey",
      providerHint: "YuanBao APP",
      credentialLabel: "App Secret",
      helpTitle: "YuanBao App Secret",
      helpLines: [
        "The App Secret is obtained from your YuanBao robot application settings.",
        "It is used together with App Key for WebSocket ticket-signing authentication.",
      ],
      envPrompt: "Use YUANBAO_APP_SECRET from environment?",
      keepPrompt: "App Secret already configured. Keep it?",
      inputPrompt: "Enter App Secret (from bot application settings)",
      preferredEnvVar: "YUANBAO_APP_SECRET",
      inspect: ({ cfg }) => {
        const yuanbaoCfg = cfg.channels?.yuanbao as YuanbaoConfig | undefined;
        const currentValue = yuanbaoCfg?.appSecret?.trim() || undefined;
        const envValue = process.env.YUANBAO_APP_SECRET?.trim() || undefined;
        return {
          accountConfigured: Boolean(currentValue),
          hasConfiguredValue: Boolean(currentValue),
          resolvedValue: currentValue,
          envValue,
        };
      },
      applySet: ({ cfg, value }) => patchTopLevelChannelConfigSection({
        cfg,
        channel: CHANNEL,
        patch: { appSecret: value },
      }),
    },
  ],

  textInputs: [
    {
      inputKey: "name",
      message: "Bot display name (optional, press Enter to skip)",
      required: false,
      currentValue: ({ cfg }) => {
        const yuanbaoCfg = cfg.channels?.yuanbao as YuanbaoConfig | undefined;
        return yuanbaoCfg?.name?.trim() || undefined;
      },
      applySet: ({ cfg, value }) => patchTopLevelChannelConfigSection({
        cfg,
        channel: CHANNEL,
        patch: { name: value },
      }),
    },
  ],

  finalize: ({ cfg }) => {
    // Ensure the channel is enabled after wizard completes
    const next = setSetupChannelEnabled(cfg, CHANNEL, true);
    return { cfg: next };
  },

  completionNote: {
    title: "YuanBao Bot setup complete",
    lines: [
      "Your YuanBao Bot credentials have been saved.",
      "Run `openclaw start` to connect your bot.",
    ],
  },

  disable: (cfg: OpenClawConfig) => setSetupChannelEnabled(cfg, CHANNEL, false),
};
