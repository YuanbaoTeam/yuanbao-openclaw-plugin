import { dirname } from "node:path";
import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk/run-command";

/**
 * Build child process env: prepend Node.js bin directory to PATH.
 *
 * Reads PATH / execPath only to make sure spawned `npm` / `openclaw` CLIs
 * can find Node-adjacent binaries. The result is passed to
 * `runPluginCommandWithTimeout`, never sent over the network.
 */
export function makeEnv(): NodeJS.ProcessEnv {
  const nodeBinDir = dirname(process.execPath);
  const currentPath = process.env.PATH ?? "";
  return {
    ...process.env,
    PATH: currentPath.includes(nodeBinDir) ? currentPath : `${nodeBinDir}:${currentPath}`,
  };
}

/**
 * Resolve npm executable path co-located with the current Node.js process.
 */
export async function resolveNpmBin(): Promise<string> {
  try {
    const result = await runPluginCommandWithTimeout({
      argv: ["which", "npm"],
      timeoutMs: 5000,
      env: makeEnv(),
    });
    const resolved = result.stdout.trim();
    if (result.code === 0 && resolved) {
      return resolved;
    }
  } catch {
    // Fallback when which fails
  }
  return "npm";
}

/**
 * Resolve openclaw executable absolute path via `which openclaw`.
 * Falls back to 'openclaw' (relies on PATH) if which fails.
 */
export async function resolveOpenClawBin(): Promise<string> {
  try {
    const result = await runPluginCommandWithTimeout({
      argv: ["which", "openclaw"],
      timeoutMs: 5000,
      env: makeEnv(),
    });
    const resolved = result.stdout.trim();
    if (result.code === 0 && resolved) {
      return resolved;
    }
  } catch {
    // Fallback when which fails
  }
  return "openclaw";
}

/** Node.js binary path, exposed so callers can log it without reading process.execPath themselves. */
export function nodeExecPath(): string {
  return process.execPath;
}
