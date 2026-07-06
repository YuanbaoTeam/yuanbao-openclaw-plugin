/**
 * OpenClaw-native topic-judge invoker.
 *
 * Runs the judge prompt through the same agent pipeline that
 * `dispatch-reply.ts` uses for real replies, but with a fully isolated session
 * (:judge peer suffix, no `recordInboundSession`, no `sender.sendText`).
 * The agent's reply text is captured into a memory buffer and parsed for the
 * JSON verdict `{shouldReply, reason}`.
 *
 * Design principles:
 * - **Never throws** — all errors (timeout, agent failure, parse error) are
 *   caught and mapped to a safe `shouldReply: false` result.
 * - **Strict timeout** (default 3s) — a linked `AbortController` aborts the
 *   dispatcher so a slow agent never blocks the pipeline for too long.
 * - **Session isolation** — the judge session peer id is suffixed `:judge`,
 *   and we never call `recordInboundSession` / `sender.sendText`, so the judge
 *   call leaves zero footprint on the real topic session.
 * - **Minimal SDK coupling** — this module exposes a plain `JudgeInvoker`
 *   function type that callers (topic-judge) depend on; the SDK-heavy
 *   assembly happens inside `createOpenclawJudgeInvoker`.
 */

import type { OpenClawConfig, PluginRuntime } from "openclaw/plugin-sdk/core";
import type { ModuleLog } from "../../../logger.js";

// ─── Public types ───────────────────────────────────────────────────────────

export interface JudgeResult {
  shouldReply: boolean;
  reason: string;
}

/**
 * The abstraction that topic-judge depends on. All SDK details are hidden
 * behind this signature so tests can inject a stub without mocking the world.
 */
export type JudgeInvoker = (input: {
  prompt: string;
  log?: ModuleLog;
}) => Promise<JudgeResult>;

export interface CreateOpenclawJudgeInvokerOptions {
  core: PluginRuntime;
  config: OpenClawConfig;
  /** Original group code — used to derive the isolated judge peer id. */
  groupCode: string;
  /** Topic id — combined with groupCode into a `:judge`-suffixed peer id. */
  topicId: string;
  /** Original message sender — for observability, not for routing. */
  fromAccount: string;
  /** Sender display name for logs. */
  senderNickname?: string;
  /** Account id for OpenClaw route resolution. */
  accountId: string;
  /** Judge timeout in ms (default 3000). */
  timeoutMs?: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 3000;

// ─── Internal helpers ───────────────────────────────────────────────────────

/**
 * Parse the agent's reply text into a structured result.
 *
 * Expects JSON like: `{"shouldReply": true, "reason": "涉及技术讨论"}`
 * Tolerant of markdown code fences, leading/trailing whitespace, and minor
 * variations (e.g. `"reply"` / `"should_reply"` as aliases for `"shouldReply"`).
 */
function parseJudgeResponse(text: string): JudgeResult | null {
  if (!text || typeof text !== "string") return null;

  // Strip markdown code fences if present
  let cleaned = text.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  cleaned = cleaned.trim();

  // Some agents emit extra prose around the JSON — try to locate the first
  // {...} block if a direct parse fails.
  const tryParse = (raw: string): Record<string, unknown> | null => {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  };

  let parsed = tryParse(cleaned);
  if (!parsed) {
    const braceStart = cleaned.indexOf("{");
    const braceEnd = cleaned.lastIndexOf("}");
    if (braceStart !== -1 && braceEnd > braceStart) {
      parsed = tryParse(cleaned.slice(braceStart, braceEnd + 1));
    }
  }
  if (!parsed) return null;

  const reply = parsed.shouldReply ?? parsed.reply ?? parsed.should_reply;
  const reason = typeof parsed.reason === "string" ? parsed.reason : "";

  if (typeof reply === "boolean") {
    return { shouldReply: reply, reason: reason || (reply ? "llm-yes" : "llm-no") };
  }
  // Some models return "true"/"false" as strings
  if (reply === "true" || reply === "yes") {
    return { shouldReply: true, reason: reason || "llm-yes" };
  }
  if (reply === "false" || reply === "no") {
    return { shouldReply: false, reason: reason || "llm-no" };
  }

  return null;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build a JudgeInvoker that runs the prompt through OpenClaw's own agent
 * pipeline with an isolated session, captures the reply text, and parses the
 * JSON verdict.
 *
 * The returned function never throws — any failure resolves to a safe
 * `{ shouldReply: false, reason: "llm-judge-error: <type>" }`.
 */
export function createOpenclawJudgeInvoker(
  opts: CreateOpenclawJudgeInvokerOptions,
): JudgeInvoker {
  const {
    core,
    config,
    groupCode,
    topicId,
    fromAccount,
    senderNickname,
    accountId,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  return async function invokeJudge(
    { prompt, log }: { prompt: string; log?: ModuleLog },
  ): Promise<JudgeResult> {
    const startTime = Date.now();

    // Isolated judge peer id — never collides with the real topic session.
    const judgePeerId = `${groupCode}:topic:${topicId}:judge`;
    const label = `group:${judgePeerId}`;

    try {
      // Resolve a route just for the judge peer. If operators want to bind a
      // cheaper agent to this peer they can do so at OpenClaw config level.
      const route = core.channel.routing.resolveAgentRoute({
        cfg: config,
        channel: "yuanbao",
        accountId,
        peer: { kind: "group", id: judgePeerId },
      });

      // Build a MsgContext specifically for the judge call.
      //   - No InboundHistory: history is already inlined in `prompt`.
      //   - ChatType "direct": avoid group-history injection paths.
      //   - Body / RawBody / BodyForAgent all set to the merged prompt.
      const judgeCtx = core.channel.reply.finalizeInboundContext({
        Body: prompt,
        BodyForAgent: prompt,
        RawBody: prompt,
        CommandBody: prompt,
        From: `yuanbao:${label}`,
        To: `yuanbao:${label}`,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: "direct",
        ConversationLabel: label,
        SenderName: senderNickname || fromAccount,
        SenderId: fromAccount,
        Provider: "yuanbao",
        Surface: "yuanbao",
        MessageSid: `judge:${Date.now()}`,
        OriginatingChannel: "yuanbao",
        OriginatingTo: `yuanbao:${label}`,
        CommandAuthorized: false,
      });

      // Enforce a hard timeout via AbortController.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      // Capture agent output. `onPartialReply` is cumulative (full text so far),
      // so we overwrite; `deliver` is per-block, so we accumulate. Whichever
      // path the agent uses, we end up with the complete text.
      let capturedText = "";
      let capturedFromPartial = "";

      try {
        await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: judgeCtx,
          cfg: config,
          dispatcherOptions: {
            deliver: async (
              payload: Record<string, unknown>,
              info: { kind: string },
            ) => {
              if (controller.signal.aborted) return;
              if (payload.isReasoning || payload.isCompactionNotice) return;
              if (info.kind === "tool") return;
              const text = typeof payload.text === "string" ? payload.text : "";
              if (text) capturedText += text;
            },
            onError: () => {
              // Swallow — we'll surface the failure via the outer catch/timeout
              // once the dispatcher promise settles.
            },
          },
          replyOptions: {
            abortSignal: controller.signal,
            disableBlockStreaming: true,
            onPartialReply: async (payload: { text?: string }) => {
              if (typeof payload.text === "string") {
                capturedFromPartial = payload.text;
              }
            },
          },
        });
      } finally {
        clearTimeout(timer);
      }

      // Prefer partial-reply text when present (it's the canonical full text);
      // fall back to accumulated deliver chunks otherwise.
      const finalText = capturedFromPartial || capturedText;
      const elapsed = Date.now() - startTime;

      const parsed = parseJudgeResponse(finalText);
      if (!parsed) {
        log?.warn?.("[llm-judge] failed to parse agent response", {
          preview: finalText.slice(0, 200),
          elapsed,
        });
        return { shouldReply: false, reason: "llm-judge-error: parse-failed" };
      }

      log?.info?.("[llm-judge] verdict", {
        shouldReply: parsed.shouldReply,
        reason: parsed.reason,
        elapsed,
      });

      return parsed;
    } catch (err: unknown) {
      const elapsed = Date.now() - startTime;
      const isTimeout =
        err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
      const reason = isTimeout ? "llm-judge-error: timeout" : "llm-judge-error: agent-failed";
      log?.warn?.("[llm-judge] invoker failed", {
        reason,
        error: err instanceof Error ? err.message : String(err),
        elapsed,
      });
      return { shouldReply: false, reason };
    }
  };
}

// Exported for testing
export { parseJudgeResponse as __parseJudgeResponseForTests };
