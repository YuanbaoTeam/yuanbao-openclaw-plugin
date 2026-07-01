/**
 * Contract-test export barrel — NOT part of the published package.
 *
 * This file lives outside `src/` on purpose: `tsc` only compiles the paths in
 * the tsconfig `include` list (`index.ts`, `api.ts`, `runtime-api.ts`,
 * `setup-entry.ts`, `src/**`), so it is never emitted into `dist/` and never
 * published. It re-exports the *real* production functions that the
 * yuanbao-bot-spec fixtures pin, so the cross-language contract suite verifies
 * live code instead of a re-implementation.
 *
 * Consumed by yuanbao-bot-spec/compliance/openclaw/adapter.mjs via tsx.
 * It contains no data — only re-exports of existing functions.
 */

export { computeSignature } from "../src/access/http/request.js";
export { decodeConnMsg } from "../src/access/ws/conn-codec.js";
export { mdAtomic } from "../src/business/utils/markdown.js";
export { defaultChunkText } from "../src/business/outbound/streaming-output-session.js";
export { classifyReplyMode } from "../src/infra/reply-classify.js";
export type { ReplyClassification } from "../src/infra/reply-classify.js";
export { resolveMentionGatingWithBypass } from "openclaw/plugin-sdk/channel-inbound";
