export type { ChannelPlugin, OpenClawPluginApi, PluginRuntime } from "openclaw/plugin-sdk/core";
export type { OpenClawConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
export type {
  OpenClawPluginService,
  OpenClawPluginServiceContext,
  PluginLogger,
} from "openclaw/plugin-sdk/core";
export type { ResolvedYuanbaoAccount } from "./src/types.js";
export { getYuanbaoRuntime, setYuanbaoRuntime } from "./src/runtime.js";
