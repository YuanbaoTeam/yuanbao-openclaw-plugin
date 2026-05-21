/**
 * Shared COS SDK loader.
 *
 * cos-nodejs-sdk-v5 uses CommonJS `module.exports =` syntax.  When loaded
 * through OpenClaw's stageRuntimeDependencies bundler the CJS export may be
 * double-wrapped in ESM namespace objects, e.g.
 *   import() → { default: { default: COS_fn } }
 * We loop-unwrap `.default` until we reach the actual constructor.
 */

import type { CosUploadConfig } from "../access/api.js";

export interface CosClient {
  putObject: (params: Record<string, unknown>) => Promise<unknown>;
}

export async function createCosClient(config: CosUploadConfig): Promise<CosClient> {
  let COS: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    COS = require("cos-nodejs-sdk-v5");
  } catch {
    try {
      const pkg = await import("cos-nodejs-sdk-v5" as string);
      COS = pkg.default ?? pkg;
    } catch {
      throw new Error("Missing dependency cos-nodejs-sdk-v5. Run: pnpm add cos-nodejs-sdk-v5");
    }
  }
  while (COS && typeof COS !== "function" && (COS as Record<string, unknown>).default) {
    COS = (COS as Record<string, unknown>).default;
  }
  if (typeof COS !== "function") {
    throw new Error(`cos-nodejs-sdk-v5 loaded but export is not a constructor (got ${typeof COS})`);
  }

  return new (COS as new (opts: Record<string, unknown>) => CosClient)({
    FileParallelLimit: 10,
    getAuthorization(_: unknown, callback: (cred: object) => void) {
      callback({
        TmpSecretId: config.encryptTmpSecretId,
        TmpSecretKey: config.encryptTmpSecretKey,
        SecurityToken: config.encryptToken,
        StartTime: config.startTime,
        ExpiredTime: config.expiredTime,
        ScopeLimit: true,
      });
    },
    UseAccelerate: true,
  });
}
