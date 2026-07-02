/**
 * Extract a flat, snapshot-friendly view from the captured dispatch params
 * and the post-pipeline PipelineContext.
 *
 * The dispatch params carry `ctxPayload` (Body/SessionKey/MediaPaths/…) but
 * route/quoteInfo/commandParts live on the PipelineContext itself, so this
 * merges both sources into one AssertableParams object.
 */

import type { PipelineContext } from "../../../src/business/pipeline/types.js";
import type { AssertableParams, DispatchCapture } from "./types.js";

/**
 * Read a string field from ctxPayload, tolerating undefined.
 * ctxPayload is `finalizeInboundContext`'s return value — a record of mixed types.
 */
function str(ctxPayload: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = ctxPayload?.[key];
  return typeof v === "string" ? v : undefined;
}

function strArr(ctxPayload: Record<string, unknown> | undefined, key: string): string[] {
  const v = ctxPayload?.[key];
  return Array.isArray(v) ? (v as string[]) : [];
}

/**
 * Normalize a media path to its basename so snapshots stay deterministic.
 *
 * c2c-image uses a real local file; downloadMediasToLocalFiles writes it to a
 * temp dir whose absolute path varies by HOME. Keeping only the basename
 * (e.g. "sample.png") makes the snapshot stable while still asserting that the
 * media propagated through to ctxPayload.MediaPaths.
 */
function normalizeMediaPath(p: string): string {
  const parts = String(p).split("/");
  return parts[parts.length - 1] || String(p);
}

function normalizeMediaPaths(paths: string[]): string[] {
  return paths.map(normalizeMediaPath);
}

/**
 * Build the AssertableParams snapshot from a dispatch capture + the final ctx.
 *
 * When `capture.called` is false (a gate middleware aborted), ctxPayload is
 * unavailable but the ctx fields filled before the abort (e.g. rawBody,
 * isAtBot, quoteInfo, commandParts) are still asserted — this is what lets the
 * snapshot explain *why* a message was dropped.
 */
export function extractAssertableParams(
  capture: DispatchCapture,
  ctx: PipelineContext,
): AssertableParams {
  const ctxPayload = capture.params?.ctx as Record<string, unknown> | undefined;

  const route = ctx.route;
  const quoteInfo = ctx.quoteInfo;
  const traceContext = ctx.traceContext;

  return {
    shouldDispatch: capture.called,
    agentId: route?.agentId,
    sessionKey: route?.sessionKey ?? str(ctxPayload, "SessionKey"),
    accountId: route?.accountId,
    chatType: str(ctxPayload, "ChatType"),
    isGroup: ctx.isGroup,
    fromAccount: ctx.fromAccount ?? str(ctxPayload, "SenderId"),
    senderName: str(ctxPayload, "SenderName"),
    groupCode: ctx.groupCode,
    rawBody: ctx.rawBody,
    rewrittenBody: ctx.rewrittenBody,
    commandBody: str(ctxPayload, "CommandBody"),
    commandParts: ctx.commandParts ?? [],
    hasControlCommand: ctx.hasControlCommand,
    commandAuthorized: ctx.commandAuthorized,
    quotePresent: quoteInfo !== undefined,
    quoteDesc: quoteInfo?.desc,
    quoteSenderId: quoteInfo?.sender_id,
    quoteSenderNickname: quoteInfo?.sender_nickname,
    quoteId: quoteInfo?.id,
    isAtBot: ctx.isAtBot,
    effectiveWasMentioned: ctx.effectiveWasMentioned,
    mediaCount: ctx.medias.length,
    mediaPaths: normalizeMediaPaths(
      ctx.mediaPaths.length > 0 ? ctx.mediaPaths : strArr(ctxPayload, "MediaPaths"),
    ),
    mediaTypes: ctx.mediaTypes.length > 0 ? ctx.mediaTypes : strArr(ctxPayload, "MediaTypes"),
    ctxBody: str(ctxPayload, "Body"),
    ctxBodyForAgent: str(ctxPayload, "BodyForAgent"),
    ctxRawBody: str(ctxPayload, "RawBody"),
    ctxMessageSid: str(ctxPayload, "MessageSid"),
    traceId: traceContext?.traceId,
    seqId: traceContext?.seqId,
  };
}
