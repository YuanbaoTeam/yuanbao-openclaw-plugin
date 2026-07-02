/**
 * Minimal COS upload client using PUT Object REST API directly.
 *
 * Replaces cos-nodejs-sdk-v5 SDK to avoid dependency conflicts (request → uuid)
 * in environments where npm hoists incompatible transitive dependency versions.
 *
 * @see https://cloud.tencent.com/document/product/436/7749  PUT Object
 * @see https://cloud.tencent.com/document/product/436/7778  Request Signature
 */

import { createHash, createHmac } from "node:crypto";
import type { CosUploadConfig } from "../access/api.js";
import { createLog } from "../logger.js";

export interface CosClient {
  putObject: (params: {
    Bucket: string;
    Region: string;
    Key: string;
    Body: Buffer;
    Headers?: Record<string, string>;
  }) => Promise<void>;
}

function hmacSha1(key: string, message: string): string {
  return createHmac("sha1", key).update(message).digest("hex");
}

function sha1Hex(data: string): string {
  return createHash("sha1").update(data).digest("hex");
}

/**
 * Generate COS request authorization header.
 * @see https://cloud.tencent.com/document/product/436/7778
 */
function signCosRequest(params: {
  secretId: string;
  secretKey: string;
  method: string;
  pathname: string;
  headers: Record<string, string>;
  startTime: number;
  expiredTime: number;
}): string {
  const { secretId, secretKey, method, pathname, startTime, expiredTime } = params;
  const keyTime = `${startTime};${expiredTime}`;
  const signKey = hmacSha1(secretKey, keyTime);

  const sortedHeaderKeys = Object.keys(params.headers)
    .map(k => k.toLowerCase())
    .sort();
  const headerList = sortedHeaderKeys.join(";");
  const httpHeaders = sortedHeaderKeys
    .map(k => `${k}=${encodeURIComponent(params.headers[Object.keys(params.headers).find(h => h.toLowerCase() === k)!])}`)
    .join("&");

  const httpString = `${method.toLowerCase()}\n${pathname}\n\n${httpHeaders}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1Hex(httpString)}\n`;
  const signature = hmacSha1(signKey, stringToSign);

  return [
    `q-sign-algorithm=sha1`,
    `q-ak=${secretId}`,
    `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`,
    `q-header-list=${headerList}`,
    `q-url-param-list=`,
    `q-signature=${signature}`,
  ].join("&");
}

export function createCosClient(config: CosUploadConfig, options?: { endpoint?: string }): CosClient {
  return {
    async putObject(params) {
      const pathname = params.Key.startsWith("/") ? params.Key : `/${params.Key}`;
      const host = `${params.Bucket}.cos.${params.Region}.myqcloud.com`;
      const ep = options?.endpoint?.trim();
      const override = ep ? new URL(ep) : undefined;
      const protocol = override?.protocol ?? "https:";
      const signHost = override?.host ?? host;

      // Headers used for signature (includes Host / Content-Length per COS spec)
      const signHeaders: Record<string, string> = {
        host: signHost,
        "content-length": String(params.Body.length),
      };
      // Extra headers sent on the wire (Content-Type, Pic-Operations, etc.)
      const extraHeaders: Record<string, string> = { ...params.Headers };
      if (config.encryptToken) {
        const tokenKey = "x-cos-security-token";
        signHeaders[tokenKey] = config.encryptToken;
        extraHeaders[tokenKey] = config.encryptToken;
      }

      const authorization = signCosRequest({
        secretId: config.encryptTmpSecretId,
        secretKey: config.encryptTmpSecretKey,
        method: "PUT",
        pathname,
        headers: signHeaders,
        startTime: config.startTime,
        expiredTime: config.expiredTime,
      });

      // fetch auto-sets Host and Content-Length; passing them triggers undici UND_ERR_INVALID_ARG
      const url = `${protocol}//${signHost}${pathname}`;
      const log = createLog("cos");
      let res: Response;
      try {
        res = await fetch(url, {
          method: "PUT",
          headers: { ...extraHeaders, Authorization: authorization },
          body: params.Body as unknown as BodyInit,
        });
      } catch (err) {
        const cause = err instanceof Error ? (err as NodeJS.ErrnoException).cause ?? err.message : err;
        log.error("COS PUT network error", { url, cause });
        throw new Error("COS upload failed: network error");
      }

      if (!res.ok) {
        const body = await res.text();
        log.error("COS PUT request failed", { url, status: res.status, body });
        throw new Error(`COS upload failed: ${res.status}`);
      }
    },
  };
}
