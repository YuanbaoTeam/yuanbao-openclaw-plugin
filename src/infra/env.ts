import { createRequire } from "module";
import os from "os";
import semver from "semver";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

/**
 * Plugin version number.
 */
let _pluginVersion = "";
/**
 * OpenClaw version number.
 */
let _openclawVersion = "";

/**
 * Get current plugin version number.
 */
export const getPluginVersion = () => _pluginVersion;

/**
 * Get current OpenClaw version number.
 */
export const getOpenclawVersion = () => _openclawVersion;

/**
 * Get current operating system.
 */
export const getOperationSystem = () => os.type();

/**
 * Read minHostVersion constraint from package.json (Single Source of Truth).
 */
const getMinHostVersion = (): string | undefined => {
  try {
    const _require = createRequire(import.meta.url);
    const pkg = _require("../../../package.json") as {
      openclaw?: { install?: { minHostVersion?: string } };
    };
    return pkg?.openclaw?.install?.minHostVersion;
  } catch {
    return undefined;
  }
};

/**
 * Runtime guard: throw if the current OpenClaw version does not satisfy
 * the minHostVersion constraint declared in package.json.
 */
const assertHostVersionCompatible = (hostVersion: string): void => {
  const constraint = getMinHostVersion();
  if (!constraint) return;

  if (!semver.satisfies(hostVersion, constraint)) {
    throw new Error(`openclaw-plugin-yuanbao requires openclaw ${constraint}, but current version is ${hostVersion}. Please upgrade openclaw first.`);
  }
};

/**
 * Initialize plugin and OpenClaw version numbers during plugin registration.
 */
export const initEnv = (api: OpenClawPluginApi) => {
  _pluginVersion = api?.version || "";
  _openclawVersion = api?.config?.meta?.lastTouchedVersion || "";

  if (!_pluginVersion || !_openclawVersion) {
    legacyInitEnv();
  }

  // Runtime compatibility guard (Layer 4 defense)
  if (_openclawVersion) {
    assertHostVersionCompatible(_openclawVersion);
  }
};

/**
 * Fallback: resolve versions from package.json relative to the install directory.
 */
const legacyInitEnv = () => {
  try {
    const _require = createRequire(import.meta.url);
    // Read plugin version (build output in dist/ws/get-env.js, two levels up to root)
    const _pluginPkg = _require("../../../package.json") as { version: string };
    const _openclawJson = _require("../../../../../openclaw.json") as {
      meta: { lastTouchedVersion: string };
    };

    _pluginVersion = _pluginPkg.version;
    _openclawVersion = _openclawJson.meta.lastTouchedVersion;
  } catch {
    // Ignore path resolution errors
  }
};
