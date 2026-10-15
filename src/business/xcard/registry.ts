/**
 * In-memory xCard surface registry (per process).
 *
 * Holds everything needed to validate and route a user operation back to the right place:
 * owning account/group/session, revision, audience, quota state, request-id dedupe, and at most
 * one waiting tool call.
 *
 * Constraints:
 * - Not persisted. `PLUGIN_EPOCH` changes on every process start, and is embedded in the card's
 *   binding metadata, so events for cards created by a previous process are answered `unknown`
 *   instead of being mis-routed.
 * - Every state transition for one surface (event validation/acceptance, update, close, waiter
 *   resolution) runs under `withSurfaceLock`, so the waiting path and the wake-a-new-turn path
 *   see the same quota and dedupe decisions.
 * - Only one waiting card per (account, group): a second wait request is downgraded by the
 *   caller (see `hasGroupWaiter`).
 */

import { randomUUID } from "node:crypto";
import {
  MAX_SEEN_REQUEST_IDS,
  MAX_SURFACES_PER_ACCOUNT,
  SURFACE_TTL_MS,
  USER_MESSAGE_ECHO_TTL_MS,
} from "./constants.js";
import type { TemplateData } from "./templates/types.js";
import type { A2uiMessage } from "./validate.js";

export const PLUGIN_EPOCH = randomUUID().replace(/-/g, "").slice(0, 16);

/** completed = closed after an accepted operation; cancelled = closed without one (or unrenderable) */
export type SurfaceState = "active" | "completed" | "cancelled" | "expired";
/**
 * once = the first accepted operation closes the card;
 * perRevision = one accepted operation per revision, the card is re-sent at revision+1 afterwards
 */
export type SurfaceMode = "once" | "perRevision";
/** requester = only the user who triggered the tool call; anyone = any group member */
export type SurfaceAudience = "requester" | "anyone";
/** Template key from templates/index.ts */
export type SurfaceTemplate = string;

export interface XCardActionResult {
  requestId: string;
  operatorUserId: string;
  action: string;
  /** Trusted context from the template's decideAction */
  context: Record<string, unknown>;
  /** Human-readable description of the operation */
  summary?: string;
  userMessage?: string;
  sourceComponentId?: string;
  trigger?: string;
  revision: number;
  at: number;
}

export interface XCardRendererError {
  code: string;
  message: string;
  at: number;
}

export type WaitOutcome =
  | { status: "action"; result: XCardActionResult }
  | { status: "timeout" }
  | { status: "cancelled"; reason: string };

interface Waiter {
  resolve: (outcome: WaitOutcome) => void;
}

export interface SurfaceRecord {
  surfaceId: string;
  /** Server-assigned IM id learned from the first 102 event; required by the client for 103 updates. */
  cardMessageId?: string;
  accountId: string;
  /** false for C2C cards; groupCode then stores the direct peer id as the conversation target. */
  isGroup: boolean;
  groupCode: string;
  sessionKey: string;
  /** Template surfaces and AI-authored generated surfaces share routing/state, not rendering. */
  kind: "template" | "generated";
  template?: SurfaceTemplate;
  /** Card name (IM card_name, fallback text title) */
  title: string;
  /** Validated template data; empty for generated surfaces. */
  data: TemplateData;
  /** Validated, self-contained A2UI messages for a generated surface. */
  messages?: A2uiMessage[];
  /** Event names declared by actions in a generated card's component tree. */
  actions?: string[];
  /** Trusted requester of the creating tool call */
  ownerUserId: string;
  audience: SurfaceAudience;
  mode: SurfaceMode;
  fallbackText: string;
  revision: number;
  state: SurfaceState;
  createdAt: number;
  expiresAt: number;
  acceptedRevisions: Set<number>;
  /** requestKey(operator, requestId) → settled receipt status (idempotent replay) */
  seenRequests: Map<string, { status: string; reason?: string }>;
  lastResult?: XCardActionResult;
  /** Recent accepted operations, newest last (multi-mode cards accept many) */
  history?: XCardActionResult[];
  lastError?: XCardRendererError;
  waiter?: Waiter;
}

const MAX_HISTORY = 10;

const surfaces = new Map<string, SurfaceRecord>();
const locks = new Map<string, Promise<unknown>>();
/** `${accountId}\n${conversationKind}\n${targetId}\n${operator}\n${text}` → expiresAt */
const userMessageEchoes = new Map<string, number>();

export function recordAcceptedAction(rec: SurfaceRecord, result: XCardActionResult): void {
  rec.lastResult = result;
  rec.history = [...(rec.history ?? []), result].slice(-MAX_HISTORY);
}

function echoKey(accountId: string, isGroup: boolean, targetId: string, operator: string, text: string): string {
  return [accountId, isGroup ? "group" : "direct", targetId, operator, text.trim()].join("\n");
}

/**
 * Remember a clicked button's userMessage. The client may also post it to the conversation as the
 * user's chat message; that echo must not trigger a second turn on top of the card event.
 */
export function rememberUserMessageEcho(
  accountId: string,
  isGroup: boolean,
  targetId: string,
  operator: string,
  text: string,
): void {
  if (!text.trim()) return;
  const now = Date.now();
  for (const [k, exp] of userMessageEchoes) if (exp < now) userMessageEchoes.delete(k);
  userMessageEchoes.set(echoKey(accountId, isGroup, targetId, operator, text), now + USER_MESSAGE_ECHO_TTL_MS);
}

/** True (and forgets it) when an inbound message is the echo of a recent card click. */
export function consumeUserMessageEcho(
  accountId: string,
  isGroup: boolean,
  targetId: string,
  operator: string,
  text: string,
): boolean {
  const key = echoKey(accountId, isGroup, targetId, operator, text);
  const exp = userMessageEchoes.get(key);
  if (exp === undefined) return false;
  userMessageEchoes.delete(key);
  return exp >= Date.now();
}

export function registerSurface(
  record: Omit<SurfaceRecord, "createdAt" | "expiresAt" | "acceptedRevisions" | "seenRequests" | "state">,
): SurfaceRecord {
  sweepExpired();
  const now = Date.now();
  const full: SurfaceRecord = {
    ...record,
    state: "active",
    createdAt: now,
    expiresAt: now + SURFACE_TTL_MS,
    acceptedRevisions: new Set(),
    seenRequests: new Map(),
  };
  surfaces.set(full.surfaceId, full);
  evictOverflow(full.accountId);
  return full;
}

export function getSurface(surfaceId: string): SurfaceRecord | undefined {
  const rec = surfaces.get(surfaceId);
  if (rec) markExpiredIfDue(rec);
  return rec;
}

export function listSurfaces(accountId: string, groupCode?: string): SurfaceRecord[] {
  return [...surfaces.values()].filter(
    (s) => s.accountId === accountId && (!groupCode || s.groupCode === groupCode),
  );
}

/** Serialize all state transitions of one surface. */
export async function withSurfaceLock<T>(surfaceId: string, fn: () => Promise<T> | T): Promise<T> {
  const prev = locks.get(surfaceId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(surfaceId, tail);
  try {
    return await run;
  } finally {
    if (locks.get(surfaceId) === tail) locks.delete(surfaceId);
  }
}

/** Dedupe key: a requestId is only unique per operator (surface / epoch / account are implied by rec). */
export function requestKey(operatorUserId: string, requestId: string): string {
  return `${operatorUserId}\n${requestId}`;
}

export function rememberRequest(rec: SurfaceRecord, key: string, status: string, reason?: string): void {
  rec.seenRequests.set(key, { status, ...(reason ? { reason } : {}) });
  if (rec.seenRequests.size > MAX_SEEN_REQUEST_IDS) {
    const oldest = rec.seenRequests.keys().next().value;
    if (oldest !== undefined) rec.seenRequests.delete(oldest);
  }
}

export function hasGroupWaiter(accountId: string, groupCode: string): boolean {
  return [...surfaces.values()].some(
    (s) => s.waiter && s.isGroup && s.accountId === accountId && s.groupCode === groupCode,
  );
}

export function hasSessionWaiter(accountId: string, sessionKey: string): boolean {
  return [...surfaces.values()].some(
    (s) => s.waiter && s.accountId === accountId && s.sessionKey === sessionKey,
  );
}

/**
 * Block until the surface receives an accepted operation, the timeout fires, or `signal` aborts.
 * The caller must ensure no waiter is already attached.
 */
export function waitForSurfaceAction(
  rec: SurfaceRecord,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<WaitOutcome> {
  return new Promise<WaitOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: WaitOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (rec.waiter === waiter) delete rec.waiter;
      resolve(outcome);
    };
    const waiter: Waiter = { resolve: finish };
    const onAbort = (): void => finish({ status: "cancelled", reason: "aborted" });
    const timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    rec.waiter = waiter;
  });
}

/** Hand an accepted operation to the waiting tool call. Returns false when nobody is waiting. */
export function resolveWaiter(rec: SurfaceRecord, result: XCardActionResult): boolean {
  const w = rec.waiter;
  if (!w) return false;
  delete rec.waiter;
  w.resolve({ status: "action", result });
  return true;
}

export function cancelWaiter(rec: SurfaceRecord, reason: string): void {
  const w = rec.waiter;
  if (!w) return;
  delete rec.waiter;
  w.resolve({ status: "cancelled", reason });
}

/** Cancel every waiter of a group (group owner /stop). */
export function cancelGroupWaiters(accountId: string, groupCode: string, reason: string): number {
  let n = 0;
  for (const s of surfaces.values()) {
    if (s.waiter && s.isGroup && s.accountId === accountId && s.groupCode === groupCode) {
      cancelWaiter(s, reason);
      n++;
    }
  }
  return n;
}

function markExpiredIfDue(rec: SurfaceRecord): void {
  if (rec.state === "active" && Date.now() > rec.expiresAt) {
    rec.state = "expired";
    cancelWaiter(rec, "expired");
  }
}

function sweepExpired(): void {
  const now = Date.now();
  for (const [id, rec] of surfaces) {
    markExpiredIfDue(rec);
    // Keep terminal records around for one more TTL so late events still get a precise reason
    if (rec.state !== "active" && now > rec.expiresAt + SURFACE_TTL_MS) surfaces.delete(id);
  }
}

function evictOverflow(accountId: string): void {
  const mine = [...surfaces.values()].filter((s) => s.accountId === accountId);
  for (const rec of mine.slice(0, Math.max(0, mine.length - MAX_SURFACES_PER_ACCOUNT))) {
    cancelWaiter(rec, "evicted");
    surfaces.delete(rec.surfaceId);
  }
}

/** Test helper */
export function __resetXCardRegistryForTest(): void {
  for (const rec of surfaces.values()) cancelWaiter(rec, "reset");
  surfaces.clear();
  locks.clear();
  userMessageEchoes.clear();
}
