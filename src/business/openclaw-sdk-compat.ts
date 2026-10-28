import { createRequire } from "node:module";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

const requireOpenClawModule = createRequire(import.meta.url);

export type ChatCommandDefinition = {
  key: string;
  description: string;
  textAliases: string[];
};

type CommandAuthModule = {
  listChatCommands?: (config?: OpenClawConfig) => ChatCommandDefinition[];
  listChatCommandsForConfig?: (config: OpenClawConfig) => ChatCommandDefinition[];
};

export type ChannelReplyPipelineOptions = {
  onModelSelected?: (...args: unknown[]) => void;
  [key: string]: unknown;
};

type ChannelReplyPipelineModule = {
  createChannelReplyPipeline?: (params?: unknown) => ChannelReplyPipelineOptions;
};

function loadOpenClawModule<T>(moduleName: string): T | undefined {
  try {
    return requireOpenClawModule(moduleName) as T;
  } catch {
    return undefined;
  }
}

export function listChatCommandsForConfig(config: OpenClawConfig): ChatCommandDefinition[] {
  const legacyModule = loadOpenClawModule<CommandAuthModule>("openclaw/plugin-sdk/command-auth");
  if (typeof legacyModule?.listChatCommandsForConfig === "function") {
    return legacyModule.listChatCommandsForConfig(config);
  }

  const nativeModule = loadOpenClawModule<CommandAuthModule>("openclaw/plugin-sdk/command-auth-native");
  if (typeof nativeModule?.listChatCommands === "function") {
    return nativeModule.listChatCommands(config);
  }

  if (typeof legacyModule?.listChatCommands === "function") {
    return legacyModule.listChatCommands(config);
  }

  return [];
}

export function createChannelReplyPipeline(params?: unknown): ChannelReplyPipelineOptions {
  const legacyModule = loadOpenClawModule<ChannelReplyPipelineModule>("openclaw/plugin-sdk/channel-reply-pipeline");
  if (typeof legacyModule?.createChannelReplyPipeline === "function") {
    return legacyModule.createChannelReplyPipeline(params);
  }

  return {
    onModelSelected: () => {},
  };
}
