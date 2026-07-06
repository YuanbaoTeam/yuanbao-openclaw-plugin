/**
 * Middleware: resolve agent route using SDK resolveAgentRoute + resolveInboundSessionEnvelopeContext.
 *
 * When the inbound message carries a topicId (populated by resolve-mention),
 * the peer.id is suffixed with `:topic:<topicId>` so different topics inside
 * the same group get isolated OpenClaw sessions (independent history + agent
 * state per topic). extractGroupCode / extractGroupFromChannelId are already
 * aware of this shape and still return the plain groupCode for IM tools.
 */

import { resolveInboundSessionEnvelopeContext } from "openclaw/plugin-sdk/channel-inbound";
import type { MiddlewareDescriptor } from "../types.js";

export const resolveRoute: MiddlewareDescriptor = {
  name: "resolve-route",
  handler: async (ctx, next) => {
    const { core, config, account, isGroup, fromAccount, groupCode, topicId } = ctx;

    // Group + topic → topic-scoped peer id; otherwise unchanged.
    const groupPeerId = isGroup && topicId ? `${groupCode!}:topic:${topicId}` : groupCode!;

    const route = core.channel.routing.resolveAgentRoute({
      cfg: config,
      channel: "yuanbao",
      accountId: account.accountId,
      peer: isGroup ? { kind: "group", id: groupPeerId } : { kind: "direct", id: fromAccount },
    });

    ctx.route = route;

    // Use SDK API to resolve storePath + envelopeOptions + previousTimestamp
    const { storePath, envelopeOptions, previousTimestamp } = resolveInboundSessionEnvelopeContext({
      cfg: config,
      agentId: route.agentId,
      sessionKey: route.sessionKey,
    });

    ctx.storePath = storePath;
    ctx.envelopeOptions = envelopeOptions;
    ctx.previousTimestamp = previousTimestamp;

    ctx.log.debug(
      `[resolve-route] route resolved, agentId=${route.agentId}, sessionKey=${route.sessionKey}`
      + (topicId ? `, topicId=${topicId}` : ""),
    );

    await next();
  },
};
