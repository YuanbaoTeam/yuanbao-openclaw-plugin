/**
 * Middleware: command authorization guard using SDK resolveControlCommandGate.
 * Checks for control commands and applies DM allowFrom + useAccessGroups policies.
 */

import { resolveControlCommandGate } from "openclaw/plugin-sdk/command-auth";
import type { MiddlewareDescriptor, PipelineContext } from "../types.js";

/** Read commands.useAccessGroups without depending on CommandsConfig (removed in openclaw 2026.8.1). */
function readUseAccessGroups(commands: unknown): boolean {
  if (!commands || typeof commands !== "object") {
    return true;
  }
  return (commands as { useAccessGroups?: unknown }).useAccessGroups !== false;
}

/** Extract pure text content from msg_body (TIMTextElem only, skipping @mention custom elements). */
function extractTextOnly(ctx: PipelineContext): string {
  if (!ctx.raw.msg_body) return ctx.rawBody;
  return ctx.raw.msg_body
    .filter(e => e.msg_type === "TIMTextElem")
    .map(e => e.msg_content?.text ?? "")
    .join("")
    .trim() || ctx.rawBody;
}

export const guardCommand: MiddlewareDescriptor = {
  name: "guard-command",
  handler: async (ctx, next) => {
    const { core, config, rawBody, fromAccount, account } = ctx;

    // Group chat: extract TIMTextElem-only text for command detection
    // (rawBody includes @mention custom elements which break command matching).
    const commandText = ctx.isGroup ? extractTextOnly(ctx) : rawBody;

    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg: config,
      surface: "yuanbao",
    });
    const rawHasControlCommand = core.channel.text.hasControlCommand(commandText, config);
    const hasControlCommand = ctx.isGroup ? rawHasControlCommand && ctx.isAtBot : rawHasControlCommand;
    ctx.hasControlCommand = hasControlCommand;

    if (!hasControlCommand) {
      await next();
      return;
    }

    // Build DM policy allowFrom
    const dmPolicy = account.config.dm?.policy ?? "open";
    const rawAllowFrom = (account.config.dm?.allowFrom ?? []).map(String);
    const effectiveAllowFrom = dmPolicy === "open" && !rawAllowFrom.includes("*") ? [...rawAllowFrom, "*"] : rawAllowFrom;
    const senderAllowed = effectiveAllowFrom.includes("*") || effectiveAllowFrom.includes(fromAccount);
    // 2026.8.1 dropped useAccessGroups from CommandsConfig; still honor it when present.
    const useAccessGroups = readUseAccessGroups(config.commands);

    const { commandAuthorized, shouldBlock } = resolveControlCommandGate({
      useAccessGroups,
      authorizers: [{ configured: effectiveAllowFrom.length > 0, allowed: senderAllowed }],
      allowTextCommands,
      hasControlCommand,
    });

    ctx.commandAuthorized = commandAuthorized;

    if (shouldBlock) {
      ctx.log.info(`[guard-command] control command unauthorized, discarding <- ${ctx.isGroup ? `group:${ctx.groupCode}` : ""} from: ${fromAccount}`);
      return;
    }

    ctx.commandParts = commandText.trim().split(/\s+/);
    await next();
  },
};
