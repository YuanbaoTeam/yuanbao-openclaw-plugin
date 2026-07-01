import { createScopedDmSecurityResolver } from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-plugin-common";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/channel-plugin-common";
import { createComputedAccountStatusAdapter } from "openclaw/plugin-sdk/status-helpers";
import { startYuanbaoWsGateway } from "./access/ws/index.js";
import { handleAction, yuanbaoMessageActions } from "./business/actions/index.js";
import type { ActionParams } from "./business/actions/resolve-target.js";
import { mdAtomic } from "./business/utils/markdown.js";
import { buildMessageToolHints, normalizeTarget } from "./business/messaging/targets.js";
import {
  yuanbaoCapabilities,
  yuanbaoConfigAdapter,
  yuanbaoConfigSchema,
  yuanbaoMeta,
  yuanbaoReload,
  yuanbaoSetupAdapter,
  yuanbaoSetupWizard,
  YUANBAO_CHANNEL_ID,
} from "./channel-shared.js";
import { createLog, setDebugBotIds } from "./logger.js";
import { getYuanbaoRuntime } from "./runtime.js";
import type { ResolvedYuanbaoAccount, YuanbaoConfig } from "./types.js";

/**
 * Full Yuanbao channel plugin — used at runtime after the channel starts.
 *
 * Pulls in heavyweight runtime modules (WebSocket gateway, HTTP client,
 * protobuf, message actions). Keep setup/onboard-only wiring in
 * `channel.setup.ts` and shared metadata/config in `channel-shared.ts`.
 */
export const yuanbaoPlugin: ChannelPlugin<ResolvedYuanbaoAccount> = createChatChannelPlugin({
  base: {
    id: YUANBAO_CHANNEL_ID,
    meta: { ...yuanbaoMeta },
    setupWizard: yuanbaoSetupWizard,
    setup: yuanbaoSetupAdapter,
    actions: yuanbaoMessageActions as ChannelMessageActionAdapter,
    capabilities: { ...yuanbaoCapabilities },
    reload: { ...yuanbaoReload },
    configSchema: yuanbaoConfigSchema,
    config: { ...yuanbaoConfigAdapter },

    groups: {
      resolveRequireMention: () => true,
    },

    messaging: {
      normalizeTarget,
      targetResolver: {
        looksLikeId: raw => Boolean(raw.trim()),
        hint: "<userId> or group:<groupCode>",
      },
    },

    agentPrompt: {
      messageToolHints() {
        return buildMessageToolHints();
      },
    },

    // Configure the OpenClaw built-in block-streaming coalescer:
    // deliver only after 2800 characters or 1s idle.
    streaming: {
      blockStreamingCoalesceDefaults: {
        minChars: 2800,
        idleMs: 1000,
      },
    },

    status: createComputedAccountStatusAdapter<ResolvedYuanbaoAccount>({
      defaultRuntime: {
        accountId: DEFAULT_ACCOUNT_ID,
        running: false,
        connected: false,
        lastConnectedAt: null,
        lastError: null,
        lastInboundAt: null,
        lastOutboundAt: null,
      },
      buildChannelSummary: ({ snapshot }) => ({
        configured: snapshot.configured ?? false,
        tokenSource: snapshot.tokenSource ?? "none",
        running: snapshot.running ?? false,
        connected: snapshot.connected ?? false,
        lastConnectedAt: snapshot.lastConnectedAt ?? null,
        lastError: snapshot.lastError ?? null,
      }),
      probeAccount: async () => ({ ok: true }),
      resolveAccountSnapshot: ({ account, runtime: _runtime }) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
        name: account.name,
        extra: {
          // Framework uses tokenStatus to determine channel status; missing this field causes "no token" + SETUP
          tokenStatus: account.configured ? "available" : "missing",
          // token is only set when user explicitly configures a static token; in normal ticket-signing mode token is undefined
          ...(account.token ? { token: account.token } : {}),
          dmPolicy: account.config.dm?.policy ?? "open",
        },
      }),
    }),

    gateway: {
      startAccount: async (ctx) => {
        const { account } = ctx;
        const slog = createLog("gateway", ctx.log);

        slog.debug("starting account", account as unknown as Record<string, unknown>);

        if (!account.configured) {
          slog.warn("yuanbao not configured; skipping");
          ctx.setStatus({ accountId: account.accountId, running: false, configured: false });
          return;
        }

        // Initialize debug whitelist from top-level yuanbao config.
        const yuanbaoTopConfig = ctx.cfg.channels?.yuanbao as YuanbaoConfig | undefined;
        if (yuanbaoTopConfig?.debugBotIds?.length) {
          setDebugBotIds(yuanbaoTopConfig.debugBotIds);
        }

        ctx.setStatus({
          accountId: account.accountId,
          running: true,
          configured: true,
          lastStartAt: Date.now(),
        });

        return startYuanbaoWsGateway({
          account,
          config: ctx.cfg,
          abortSignal: ctx.abortSignal,
          log: ctx.log,
          runtime: getYuanbaoRuntime(),
          statusSink: patch => ctx.setStatus({ accountId: ctx.accountId, ...patch }),
        });
      },
      stopAccount: async (ctx) => {
        // Outbound queue lifecycle is managed by pipeline middleware; no global destruction needed.
        ctx.setStatus({
          accountId: ctx.account.accountId,
          running: false,
          lastStopAt: Date.now(),
        });
      },
    },
  },

  // Use createScopedDmSecurityResolver to simplify DM security policy resolution.
  security: {
    resolveDmPolicy: createScopedDmSecurityResolver<ResolvedYuanbaoAccount>({
      channelKey: YUANBAO_CHANNEL_ID,
      resolvePolicy: account => account.config.dm?.policy,
      resolveAllowFrom: account => account.config.dm?.allowFrom,
      defaultPolicy: "open",
      normalizeEntry: raw => raw.trim().toLowerCase(),
    }),
  },

  // Group chat reply-to strategy.
  threading: {
    resolveReplyToMode: () => "all",
  },

  // Outbound message configuration.
  outbound: {
    deliveryMode: "direct",
    chunkerMode: "markdown",
    textChunkLimit: 3000,
    chunker: (text, limit) => {
      const chunkMarkdownText = getYuanbaoRuntime()?.channel.text.chunkMarkdownText;
      if (!chunkMarkdownText) return [text];
      return mdAtomic.chunkAware(text, limit, chunkMarkdownText);
    },
    sendText: async (params) => {
      const slog = createLog("channel.outbound");
      const { accountId, to } = params;
      slog.info("sendText", { accountId, to });
      try {
        await handleAction(params as unknown as ActionParams);
        return { channel: "yuanbao", ok: true, messageId: "" };
      } catch (err) {
        slog.error("outbound.sendText error", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          channel: "yuanbao",
          ok: false,
          messageId: "",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
    sendMedia: async (params) => {
      const slog = createLog("channel.outbound");
      const { accountId, to } = params;
      slog.info("sendMedia", { accountId, to });
      try {
        await handleAction(params as unknown as ActionParams);
        return { channel: "yuanbao", ok: true, messageId: "" };
      } catch (err) {
        slog.error("outbound.sendMedia error", {
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          channel: "yuanbao",
          ok: false,
          messageId: "",
          error: err instanceof Error ? err : new Error(String(err)),
        };
      }
    },
  },
});
