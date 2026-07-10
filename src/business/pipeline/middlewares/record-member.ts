/**
 * Middleware: record group member info for AI tool queries.
 * Only effective in group chat scenarios.
 *
 * Note: inbound message events do NOT carry sender `userType`, so the record
 * written here is nickname-only. `userType` is populated later by
 * `GroupMember.getGroupMemberList()` (WS query) and merged into the same
 * session cache entry.
 */

import { getMember } from "../../../infra/cache/member.js";
import type { MiddlewareDescriptor } from "../types.js";

export const recordMember: MiddlewareDescriptor = {
  name: "record-member",
  when: ctx => ctx.isGroup,
  handler: async (ctx, next) => {
    const groupCode = ctx.groupCode!;
    const cache = getMember(ctx.account.accountId);
    const before = cache.session.lookupUserById(groupCode, ctx.fromAccount);

    cache.recordUser(groupCode, ctx.fromAccount, ctx.senderNickname || ctx.fromAccount);

    ctx.log.debug(
      `[record-member] recorded sender groupCode=${groupCode} userId=${ctx.fromAccount} `
        + `nickname=${ctx.senderNickname ?? "-"} preexisting=${before !== undefined} `
        + `userType=${before?.userType ?? "unknown"}`,
    );

    await next();
  },
};
