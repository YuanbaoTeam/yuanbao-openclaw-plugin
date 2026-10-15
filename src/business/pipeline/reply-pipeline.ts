/**
 * Reply pipeline lookup across OpenClaw hosts.
 *
 * 2026.8.1+ exports `createChannelMessageReplyPipeline` from
 * `plugin-sdk/channel-outbound`. 2026.10 removed the old
 * `plugin-sdk/channel-reply-pipeline` facade. Hosts before 2026.8.1 only have
 * the facade. Specifiers stay non-literal so `tsc` against 2026.5.7 does not
 * require the newer subpath.
 */

const MODERN_SDK = "openclaw/plugin-sdk/channel-outbound";
const LEGACY_SDK = "openclaw/plugin-sdk/channel-reply-pipeline";

export type ReplyPipelineParams = {
  cfg: unknown;
  agentId: string;
  channel?: string;
  accountId?: string;
};

export type ReplyPipeline = {
  /** Passed through to the host dispatcher; the context shape stays on the SDK. */
  onModelSelected?: (ctx: any) => void;
  [key: string]: unknown;
};

export type CreateReplyPipeline = (params: ReplyPipelineParams) => ReplyPipeline;

type PipelineImporter = () => Promise<unknown>;

function readFactory(mod: unknown, name: string): CreateReplyPipeline | null {
  if (!mod || typeof mod !== "object") return null;
  const fn = (mod as Record<string, unknown>)[name];
  return typeof fn === "function" ? (fn as CreateReplyPipeline) : null;
}

/**
 * Prefer the 2026.8.1+ outbound helper. Fall back to the removed facade only
 * when that helper is absent, so 2026.10 never evaluates the missing subpath.
 */
export async function resolveCreateChannelReplyPipeline(
  importModern: PipelineImporter = () => import(MODERN_SDK),
  importLegacy: PipelineImporter = () => import(LEGACY_SDK),
): Promise<CreateReplyPipeline> {
  try {
    const modern = readFactory(await importModern(), "createChannelMessageReplyPipeline");
    if (modern) return modern;
  } catch {
    // Hosts before 2026.8.1 do not export channel-outbound.
  }

  try {
    const legacy = readFactory(await importLegacy(), "createChannelReplyPipeline");
    if (legacy) return legacy;
  } catch {
    // 2026.10 removed channel-reply-pipeline.
  }

  throw new Error("当前 OpenClaw 未提供回复管线");
}
