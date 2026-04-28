import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-plugin-common";
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
import type { ResolvedYuanbaoAccount } from "./types.js";

/**
 * Setup-only Yuanbao plugin — lightweight subset used during `openclaw onboard`
 * and `openclaw configure` without pulling the full runtime dependencies
 * (WebSocket gateway, HTTP client, protobuf modules, message actions, etc.).
 *
 * Runtime surfaces (gateway/outbound/actions/agentPrompt/...) live in
 * `channel.ts` and are only loaded when the channel is actually started.
 */
export const yuanbaoSetupPlugin: ChannelPlugin<ResolvedYuanbaoAccount> = {
  id: YUANBAO_CHANNEL_ID,
  meta: { ...yuanbaoMeta },
  setupWizard: yuanbaoSetupWizard,
  setup: yuanbaoSetupAdapter,
  capabilities: { ...yuanbaoCapabilities },
  reload: { ...yuanbaoReload },
  configSchema: yuanbaoConfigSchema,
  config: { ...yuanbaoConfigAdapter },
};
