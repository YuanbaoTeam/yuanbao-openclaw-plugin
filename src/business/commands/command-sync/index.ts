/** Command sync — collects bot/plugin commands and builds the sync payload for the backend. */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  listChatCommandsForConfig,
  type ChatCommandDefinition,
} from "openclaw/plugin-sdk/command-auth";
import { getPluginVersion, getOpenclawVersion } from "../../../infra/env.js";
import { createLog } from "../../../logger.js";

export type CommandItem = {
  name: string;
  description: string;
};

export const SYNC_INFORMATION_TYPE = {
  UNSPECIFIED: 0,
  COMMANDS: 1,
} as const;

function getBotCommands(config?: OpenClawConfig): ChatCommandDefinition[] | null {
  const log = createLog("command-sync");

  try {
    const commands = listChatCommandsForConfig(config ?? ({} as OpenClawConfig));
    log.debug(`获取命令列表: ${commands.length} 个命令`);
    if (commands.length > 0) {
      log.debug("命令原始结构示例:", {
        sample: commands.slice(0, 3).map((c) => ({
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
    const aliases = cmd.textAliases;
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
  if (!pluginCommands.some((c) => c.name === fullName)) {
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

export function buildSyncCommandsPayload(
  config?: OpenClawConfig,
): SyncInformationPayload {
  const botVersion = getOpenclawVersion() || "0.0.0";
  const pluginVersion = getPluginVersion() || "0.0.0";

  const rawBotCommands = getBotCommands(config);
  const botCommands = rawBotCommands ? resolveBotCommandItems(rawBotCommands) : [];

  return {
    syncType: SYNC_INFORMATION_TYPE.COMMANDS,
    botVersion,
    pluginVersion,
    commandData: {
      botCommands: botCommands.map((c) => ({ name: c.name, description: c.description })),
      pluginCommands: pluginCommands.map((c) => ({ name: c.name, description: c.description })),
    },
  };
}
