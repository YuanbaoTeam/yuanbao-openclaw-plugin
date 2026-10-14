/**
 * Default message processing pipeline factory.
 *
 * Register middleware by stage, building the complete message processing pipeline.
 */

import { MessagePipeline } from "./engine.js";
import {
  extractContent,
  skipSelf,
  skipPlaceholder,
  skipXCardEcho,
  resolveQuote,
  recordMember,
  guardSpecialCommand,
  guardCommand,
  resolveMention,
  guardGroupCommand,
  guardSendAccess,
  rewriteBody,
  downloadMedia,
  resolveRoute,
  resolveTrace,
  buildContext,
  prepareSender,
  dispatchReply,
} from "./middlewares/index.js";

export function createPipeline(): MessagePipeline {
  return (
    new MessagePipeline()
      // Phase 1: Message parsing
      .use(extractContent) // Extract text/media/@info
      .use(skipSelf) // Skip bot's own messages
      .use(skipPlaceholder) // Skip placeholder/empty messages
      .use(skipXCardEcho) // Skip group echo of an xCard button's userMessage
      .use(resolveQuote) // Parse quoted messages
      .use(recordMember) // Record group member info (group chat)
      // Phase 2: Guards
      .use(guardSpecialCommand) // Upgrade command / issue-log owner guard
      .use(guardCommand) // SDK resolveControlCommandGate (command-auth)
      .use(resolveMention) // SDK resolveInboundMentionDecision (group chat)
      .use(guardGroupCommand) // Group command whitelist (group chat)
      .use(guardSendAccess) // Send access control guard (C2C)
      // Phase 3: Message preprocessing
      .use(rewriteBody) // Command rewrite + quote concat + mentions concat
      .use(downloadMedia) // Media download
      // Phase 4: Routing & context building
      .use(resolveRoute) // SDK resolveAgentRoute + resolveInboundSessionEnvelopeContext
      .use(resolveTrace) // Parse trace context (trace_id / seq_id -> ctx.traceContext)
      .use(buildContext) // SDK finalizeInboundContext + group history context
      // Phase 5: Sender preparation & AI dispatch
      .use(prepareSender)
      .use(dispatchReply)
  ); // ⭐ SDK dispatchInboundReplyWithBase
}

/**
 * Reduced pipeline for xCard operation callbacks (synthetic inbound, already validated).
 *
 * Skips parsing/guards/mention gating/history recording: the event is not a chat message, a
 * non-@ group message would be dropped by resolveMention, and it must not enter group history.
 * Note buildContext still consumes (and clears) pending group history, like an @bot turn.
 */
export function createXCardEventPipeline(): MessagePipeline {
  return new MessagePipeline()
    .use(resolveRoute)
    .use(resolveTrace)
    .use(buildContext)
    .use(prepareSender)
    .use(dispatchReply);
}
