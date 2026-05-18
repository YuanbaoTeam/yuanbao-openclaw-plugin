/**
 * Group info tools.
 *
 * Contains:
 * - query_group_info: Query basic info of the current group (name, owner, member count)
 *
 * Fetches group info via the queryGroupInfo interface (WS protocol).
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getMember } from "../../infra/cache/member.js";
import { createLog } from "../../logger.js";
import { extractGroupCode, type OpenClawPluginToolContext, json } from "../utils/utils.js";

/**
 * Create the query_group_info tool definition.
 *
 * Queries basic group info including name, owner (userId + nickname), and member count.
 */
function createQueryGroupInfoTool(ctx: OpenClawPluginToolContext) {
  const log = createLog("tools.group");
  if (!ctx.messageChannel?.includes('yuanbao')) return null;

  const sessionKey: string = ctx.sessionKey ?? "";
  const accountId: string = ctx.agentAccountId ?? "";

  return {
    name: "query_group_info",
    label: "Query Group Info",
    description:
      'Query basic info about the current group (called "派/Pai" in the app), '
      + "including group name, group owner, and member count.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    /**
     * Execute group info query.
     *
     * 1. No groupCode -> inform model no group context
     * 2. Call queryGroupInfo to get basic group info
     */
    async execute(toolCallId: string, _params: Record<string, unknown>) {
      log.debug("execute", { toolCallId });

      const groupCode = extractGroupCode(sessionKey);

      // 1. No groupCode -> cannot locate group
      if (!groupCode) {
        return json({
          success: false,
          msg: "No group context available, unable to query group info.",
        });
      }

      // Get Member instance for current account
      const memberInst = getMember(accountId);

      // 2. Call queryGroupInfo to get group info
      const groupInfo = await memberInst.queryGroupInfo(groupCode);
      if (!groupInfo) {
        return json({
          success: false,
          msg: "Failed to query group info. The API may be unavailable.",
        });
      }

      return json({
        success: true,
        msg: "Group info retrieved.",
        note: 'The group is called "派 (Pai)" in the app.',
        groupInfo: {
          groupName: groupInfo.groupName,
          groupSize: groupInfo.groupSize,
          owner: {
            nickname: groupInfo.ownerNickName,
            userId: groupInfo.ownerUserId,
          },
        },
      });
    },
  };
}

/**
 * Register all tools under the "group info" category.
 *
 * Currently contains:
 * - query_group_info: Query basic group info (always available)
 */
export function registerGroupTools(api: OpenClawPluginApi): void {
  const log = createLog("tools.group");
  log.info("register tool", { name: "query_group_info", optional: false });
  api.registerTool(createQueryGroupInfoTool, { name: "query_group_info", optional: false });
}
