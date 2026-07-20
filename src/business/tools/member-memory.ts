/**
 * Member memory tool (member_memory).
 *
 * Gives the agent a per-member fact store scoped to the current group ("派/Pai"),
 * so it can remember "who is who" inside a shared group session.
 *
 * Why: the group `SessionKey` is shared across all members (shared context is
 * intentional — A's messages must stay visible when B asks about them), so the
 * agent has no built-in per-member state. This tool buckets facts by
 * `groupCode + userId` on top of that shared session, letting the agent recall
 * member-specific info (e.g. "a 叫小明", "b 叫小张") without isolating the
 * conversation. See `infra/cache/member-memory.ts` for the store.
 *
 * Resolution rules for the target member:
 * - `userId` supplied  -> target that member.
 * - no `userId`        -> default to the current sender (`requesterSenderId`),
 *   which is what makes "我叫什么" recall the caller's own facts.
 * `nickname` is an enrichment hint stored on the record, not a lookup target.
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getMember } from "../../infra/cache/member.js";
import { getMemberMemory } from "../../infra/cache/member-memory.js";
import { createLog } from "../../logger.js";
import { extractGroupCode, type OpenClawPluginToolContext, json } from "../utils/utils.js";

/** Compact fact shape returned to the model. */
type FactOut = { content: string; updatedAt: string };

/** Compact member shape returned by `list`. */
type MemberOut = {
  userId: string;
  nickname?: string;
  factCount: number;
  recentFacts: FactOut[];
};

function toFactOut(content: string, updatedAt: number): FactOut {
  return { content, updatedAt: new Date(updatedAt).toISOString() };
}

/**
 * Resolve a target userId for the current group from (userId | self).
 *
 * `nickname` is treated purely as an enrichment hint for the stored record
 * (never as a lookup target): if the model wants to target another member by
 * name, it should first resolve the name to a userId via `query_session_members`
 * and pass `userId` here. This keeps self-targeting unambiguous — "我叫什么"
 * always recalls the caller's own facts.
 *
 * Returns `{ userId, nickname }` or `null` when no sender can be resolved.
 */
function resolveTarget(
  groupCode: string,
  accountId: string,
  userIdParam: string | undefined,
  nicknameParam: string | undefined,
  selfSenderId: string | undefined,
): { userId: string; nickname?: string } | null {
  // Explicit userId wins; enrich nickname from the member cache when available.
  const userId = (userIdParam ?? "").trim();
  if (userId) {
    const cached = getMember(accountId).lookupUsers(groupCode).find(u => u.userId === userId);
    return { userId, nickname: cached?.nickName || (nicknameParam?.trim() || undefined) };
  }

  // Default to the current sender.
  const self = (selfSenderId ?? "").trim();
  if (self) {
    const cached = getMember(accountId).lookupUsers(groupCode).find(u => u.userId === self);
    return { userId: self, nickname: cached?.nickName || (nicknameParam?.trim() || undefined) };
  }
  return null;
}

/** Build the tool definition. Returns null for non-yuanbao channels. */
function createMemberMemoryTool(ctx: OpenClawPluginToolContext) {
  const log = createLog("tools.member-memory");
  if (!ctx.messageChannel?.includes("yuanbao")) return null;

  const sessionKey: string = ctx.sessionKey ?? "";
  const accountId: string = ctx.agentAccountId ?? "";
  const selfSenderId: string | undefined = ctx.requesterSenderId;

  return {
    name: "member_memory",
    label: "Member Memory",
    description:
      'Remember and recall facts about individual members in the current group (called "派/Pai" in the app). '
      + "The group conversation is shared, so use this tool to keep per-member info straight — "
      + "e.g. store each member self-introduction under their own id, then recall it for whoever is asking. "
      + "When no userId/nickname is given, the action targets the current sender."
      + "\nActions: remember — store a fact about a member; "
      + "recall — retrieve all stored facts for a member; "
      + "list — list every member with stored facts in this group; "
      + "forget — clear a member's stored facts.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["remember", "recall", "list", "forget"],
          description:
            "remember — store a fact about a member (requires `fact`); "
            + "recall — retrieve all stored facts for a member; "
            + "list — list all members with stored facts in this group; "
            + "forget — clear a member's stored facts.",
        },
        fact: {
          type: "string",
          description:
            'The fact to store, e.g. "self-introduction: 我叫小明". '
            + "Required for action=remember; ignored otherwise.",
        },
        userId: {
          type: "string",
          description:
            "Target member's userId. If omitted, the action targets the current sender. "
            + "To target another member by name, first resolve their userId with query_session_members.",
        },
        nickname: {
          type: "string",
          description:
            "Optional nickname hint to store/refresh on the member's record (display only). "
            + "Not used to look up a target — pass `userId` to target a specific member.",
        },
      },
      required: ["action"],
    },
    /**
     * Execute member memory action.
     *
     * 1. No groupCode -> inform model no group context
     * 2. Resolve target member (userId | self sender); `nickname` is enrichment only
     * 3. Dispatch to action handler (list needs no target)
     */
    async execute(toolCallId: string, params: Record<string, unknown>) {
      log.debug("execute", { toolCallId });

      const action = typeof params.action === "string" ? params.action : "";
      const fact = typeof params.fact === "string" ? params.fact : "";
      const userIdParam = typeof params.userId === "string" ? params.userId : "";
      const nicknameParam = typeof params.nickname === "string" ? params.nickname : "";
      const groupCode = extractGroupCode(sessionKey);

      if (!groupCode) {
        return json({
          success: false,
          msg: "No group context available, unable to manage member memory.",
        });
      }

      const memory = getMemberMemory(accountId);

      // `list` does not need a target member.
      if (action === "list") {
        const records = memory.list(groupCode);
        if (records.length === 0) {
          return json({ success: true, msg: "No member memories recorded in this group yet.", members: [] });
        }
        const members: MemberOut[] = records.map(r => ({
          userId: r.userId,
          ...(r.nickname ? { nickname: r.nickname } : {}),
          factCount: r.facts.length,
          recentFacts: r.facts.slice(-5).map(f => toFactOut(f.content, f.updatedAt)),
        }));
        return json({
          success: true,
          msg: `Found ${members.length} member(s) with stored memories in this group.`,
          members,
        });
      }

      const target = resolveTarget(groupCode, accountId, userIdParam, nicknameParam, selfSenderId);
      if (!target) {
        return json({
          success: false,
          msg: "Could not resolve the target member. Pass a `userId`, a known `nickname`, or call from a group session.",
        });
      }

      switch (action) {
        case "remember": {
          const trimmed = fact.trim();
          if (!trimmed) {
            return json({ success: false, msg: "action=remember requires a non-empty `fact`." });
          }
          memory.remember(groupCode, target.userId, trimmed, target.nickname);
          return json({
            success: true,
            msg: `Remembered for ${target.nickname ?? target.userId}: "${trimmed}".`,
            userId: target.userId,
            ...(target.nickname ? { nickname: target.nickname } : {}),
          });
        }
        case "recall": {
          const record = memory.recall(groupCode, target.userId);
          if (!record) {
            return json({
              success: false,
              msg: `No stored memories for ${target.nickname ?? target.userId}.`,
              userId: target.userId,
              ...(target.nickname ? { nickname: target.nickname } : {}),
              facts: [],
            });
          }
          return json({
            success: true,
            msg: `Recalled ${record.facts.length} fact(s) for ${record.nickname ?? record.userId}.`,
            userId: record.userId,
            ...(record.nickname ? { nickname: record.nickname } : {}),
            facts: record.facts.map(f => toFactOut(f.content, f.updatedAt)),
          });
        }
        case "forget": {
          const removed = memory.forget(groupCode, target.userId);
          return json({
            success: removed,
            msg: removed
              ? `Cleared memories for ${target.nickname ?? target.userId}.`
              : `No stored memories to clear for ${target.nickname ?? target.userId}.`,
            userId: target.userId,
            ...(target.nickname ? { nickname: target.nickname } : {}),
          });
        }
        default:
          return json({
            success: false,
            msg: `Unsupported action "${action}". Valid actions: remember, recall, list, forget.`,
          });
      }
    },
  };
}

/**
 * Register the member_memory tool.
 *
 * Marked optional so a non-yuanbao session (factory returns null) does not
 * block tool registration for other channels.
 */
export function registerMemberMemoryTools(api: OpenClawPluginApi): void {
  const log = createLog("tools.member-memory");
  log.info("register tool", { name: "member_memory", optional: true });
  api.registerTool(createMemberMemoryTool, { name: "member_memory", optional: true });
}
