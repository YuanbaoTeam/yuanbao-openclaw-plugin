/** Command sync — collects bot/plugin commands and builds the sync payload for the backend. */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { getPluginVersion, getOpenclawVersion } from "../../../infra/env.js";
import { createLog } from "../../../logger.js";

type ChatCommandDefinition = {
  key: string;
  description: string;
  textAliases?: string[];
};

type CommandListModule = {
  listChatCommandsForConfig?: (cfg: OpenClawConfig) => ChatCommandDefinition[];
  listChatCommands?: () => ChatCommandDefinition[];
};

type CommandImporter = () => Promise<CommandListModule>;

/**
 * 2026.10 removed `plugin-sdk/command-auth`. Newer hosts list commands from
 * `command-auth-native`; older hosts still expose `listChatCommandsForConfig`
 * on the retired subpath.
 */
export async function resolveListChatCommands(
  importNative: CommandImporter = () => import("openclaw/plugin-sdk/command-auth-native"),
  importLegacy: CommandImporter = () => import("openclaw/plugin-sdk/command-auth"),
): Promise<(cfg: OpenClawConfig) => ChatCommandDefinition[]> {
  try {
    const native = await importNative();
    if (typeof native.listChatCommandsForConfig === "function") {
      const list = native.listChatCommandsForConfig;
      return (cfg) => list(cfg);
    }
    if (typeof native.listChatCommands === "function") {
      const list = native.listChatCommands;
      return () => list();
    }
  } catch {
    // Hosts that predate the native command list.
  }

  try {
    const legacy = await importLegacy();
    if (typeof legacy.listChatCommandsForConfig === "function") {
      const list = legacy.listChatCommandsForConfig;
      return (cfg) => list(cfg);
    }
  } catch {
    // 2026.10 removed this subpath.
  }

  return () => [];
}

const listChatCommands = resolveListChatCommands();

export type CommandItem = {
  name: string;
  description: string;
};

export const SYNC_INFORMATION_TYPE = {
  UNSPECIFIED: 0,
  COMMANDS: 1,
} as const;

async function getBotCommands(config?: OpenClawConfig): Promise<ChatCommandDefinition[] | null> {
  const log = createLog("command-sync");

  try {
    const list = await listChatCommands;
    const commands = list(config ?? ({} as OpenClawConfig));
    log.debug(`获取命令列表: ${commands.length} 个命令`);
    if (commands.length > 0) {
      log.debug("命令原始结构示例:", {
        sample: commands.slice(0, 3).map(c => ({
          key: c.key,
          description: c.description,
          textAliases: c.textAliases,
        })),
      });
    }
    return commands;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn(`获取命令列表失败: ${msg}`);
    return null;
  }
}

function resolveBotCommandItems(commands: ChatCommandDefinition[]): CommandItem[] {
  const log = createLog("command-sync");
  const result: CommandItem[] = [];

  for (const cmd of commands) {
    // Prefer first entry in textAliases (usually the primary command name, with /)
    const aliases = cmd.textAliases ?? [];
    let name = "";
    if (aliases.length > 0) {
      [name] = aliases;
    } else {
      name = cmd.key;
    }

    if (!name) {
      continue;
    }
    if (!name.startsWith("/")) {
      name = `/${name}`;
    }
    if (name.length <= 1) {
      continue;
    }

    result.push({
      name,
      description: cmd.description,
    });
  }

  log.debug(`resolveBotCommandItems 转换结果: ${result.length} 个命令`);
  return result;
}

const pluginCommands: CommandItem[] = [];

export function registerPluginCommand(name: string, description: string): void {
  const fullName = name.startsWith("/") ? name : `/${name}`;
  // Deduplicate
  if (!pluginCommands.some(c => c.name === fullName)) {
    pluginCommands.push({ name: fullName, description });
  }
}

export function getPluginCommands(): ReadonlyArray<CommandItem> {
  return pluginCommands;
}

export type SyncInformationPayload = {
  syncType: number;
  botVersion: string;
  pluginVersion: string;
  commandData: {
    botCommands: Array<{ name: string; description: string }>;
    pluginCommands: Array<{ name: string; description: string }>;
  };
};

export async function buildSyncCommandsPayload(config?: OpenClawConfig): Promise<SyncInformationPayload> {
  const botVersion = getOpenclawVersion() || "0.0.0";
  const pluginVersion = getPluginVersion() || "0.0.0";

  const rawBotCommands = await getBotCommands(config);
  const botCommands = rawBotCommands ? resolveBotCommandItems(rawBotCommands) : [];

  return {
    syncType: SYNC_INFORMATION_TYPE.COMMANDS,
    botVersion,
    pluginVersion,
    commandData: {
      botCommands: botCommands.map(c => ({ name: c.name, description: c.description })),
      pluginCommands: pluginCommands.map(c => ({ name: c.name, description: c.description })),
    },
  };
}
