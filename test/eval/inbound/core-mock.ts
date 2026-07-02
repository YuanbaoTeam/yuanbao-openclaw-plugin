/**
 * PluginRuntime mock for the eval harness.
 *
 * Injects a capture point at `dispatchReplyWithBufferedBlockDispatcher` and
 * stubs the other `core.channel.*` SDK methods with deterministic, no-I/O
 * implementations. The real 17 middlewares run against this mock core.
 */

import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { DispatchCapture, DispatchParams, FixtureConfig } from "./types.js";

/** Default control commands recognized by the hasControlCommand mock. */
const DEFAULT_CONTROL_COMMANDS = ["/help", "/reset", "/status", "/new"];

/**
 * Build a mock PluginRuntime that captures the dispatchReply invocation.
 *
 * @param config  fixture config (bot uid, account overrides, control commands)
 * @returns `{ core, capture }` — core is injected into the PipelineContext,
 *          capture is read after `pipeline.execute()` to inspect dispatch params.
 */
export function createCoreMock(config: FixtureConfig): {
  core: PluginRuntime;
  capture: DispatchCapture;
} {
  const capture: DispatchCapture = { called: false, callCount: 0, params: null };

  const controlCommands = config.controlCommands ?? DEFAULT_CONTROL_COMMANDS;

  const core = {
    channel: {
      commands: {
        shouldHandleTextCommands: () => true,
      },
      text: {
        // Recognized control commands (configurable per fixture); unknown
        // slash commands are NOT control commands and pass through to the AI.
        hasControlCommand: (text: string) => {
          const first = text.trim().split(/\s+/)[0];
          return controlCommands.includes(first);
        },
        convertMarkdownTables: (text: string) => text,
        chunkMarkdownText: (text: string) => [text],
      },
      session: {
        recordInboundSession: async () => {},
      },
      reply: {
        // ⭐ Capture point: record params, do not invoke deliver (no outbound I/O).
        dispatchReplyWithBufferedBlockDispatcher: async (params: DispatchParams) => {
          capture.called = true;
          capture.callCount++;
          capture.params = params;
        },
        // Identity wrappers — match mock-ctx.ts convention so ctxPayload mirrors input.
        formatAgentEnvelope: (opts: Record<string, unknown>) =>
          typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body ?? ""),
        finalizeInboundContext: (opts: Record<string, unknown>) => opts,
      },
      routing: {
        resolveAgentRoute: (input: {
          cfg: unknown;
          channel: string;
          accountId: string;
          peer: { kind: "group" | "direct"; id: string };
        }) => {
          const { kind, id } = input.peer;
          return {
            agentId: "default",
            sessionKey: `${kind}:${id}`,
            accountId: input.accountId,
          };
        },
      },
    },
    media: {
      loadWebMedia: async () => ({ buffer: Buffer.alloc(0), fileName: "stub" }),
    },
  } as unknown as PluginRuntime;

  return { core, capture };
}
