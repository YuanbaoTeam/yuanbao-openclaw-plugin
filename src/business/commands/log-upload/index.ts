import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
  ReplyPayload,
} from "openclaw/plugin-sdk/core";
import { createLog } from "../../../logger.js";
import { performLogExport } from "./perform.js";
import { registerPluginCommand } from "../command-sync/index.js";

export { performLogExport } from "./perform.js";
export { parseCommandArgs } from "./perform.js";

export const logUploadCommandDefinition: OpenClawPluginCommandDefinition = {
  name: "issue-log",
  description: "提取 OpenClaw 日志并打包为本地临时文件（jsonl.gz）",
  acceptsArgs: true,
  requireAuth: false,
  handler: async (ctx: PluginCommandContext): Promise<ReplyPayload> => {
    try {
      const text = await performLogExport(ctx);
      return { text };
    } catch (err) {
      createLog("log-upload").error("log export failed", { error: String(err) });
      return {
        isError: true,
        text: `❌ 日志导出失败：${String(err)}`,
      };
    }
  },
};

// Self-register plugin command metadata for backend sync
registerPluginCommand(logUploadCommandDefinition.name, logUploadCommandDefinition.description);
