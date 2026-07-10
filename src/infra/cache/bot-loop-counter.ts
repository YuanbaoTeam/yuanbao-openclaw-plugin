/**
 * BotLoopCounter — sliding-window counter used to break BOT↔BOT reply loops.
 *
 * A BOT running in a group can be trapped into an infinite reply loop when
 * another BOT in the same group keeps triggering it via keyword matches.
 * This counter tracks how many messages from *other bots* have been received
 * per `(groupCode, botAccountId)` pair inside a rolling window; once the
 * threshold is exceeded we enter a mute period during which every inbound
 * message is silently dropped (no user-visible notice, to avoid triggering
 * the peer bot again).
 *
 * The counter is pure in-memory, O(1) per operation, and self-clears expired
 * entries lazily on read/write paths.
 */

export interface BotLoopRecordResult {
  /** Whether the (group, bot) pair is currently muted. */
  muted: boolean;
  /** True when this call just transitioned into the muted state. */
  justEnteredMute: boolean;
  /** Current window count (including this call). */
  count: number;
}

export interface BotLoopCounterOptions {
  /** Number of other-bot messages within one window that trips the mute. */
  threshold: number;
  /** Rolling window length in ms. */
  windowMs: number;
  /** Mute duration in ms once threshold is reached. */
  muteMs: number;
  /** Injectable clock (for tests). Defaults to `Date.now`. */
  now?: () => number;
  /** Minimum interval between opportunistic cleanup scans. */
  cleanupMinIntervalMs?: number;
}

interface CounterEntry {
  count: number;
  windowStartAt: number;
  mutedUntil: number;
}

const DEFAULT_CLEANUP_INTERVAL_MS = 60_000;

export class BotLoopCounter {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly muteMs: number;
  private readonly now: () => number;
  private readonly cleanupMinIntervalMs: number;
  private readonly store = new Map<string, CounterEntry>();
  private lastCleanupAt = 0;

  constructor(opts: BotLoopCounterOptions) {
    this.threshold = Math.max(1, opts.threshold);
    this.windowMs = Math.max(0, opts.windowMs);
    this.muteMs = Math.max(0, opts.muteMs);
    this.now = opts.now ?? Date.now;
    this.cleanupMinIntervalMs = Math.max(0, opts.cleanupMinIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS);
  }

  /**
   * Record one other-bot message. Callers should invoke this only when the
   * inbound sender has been identified as a bot (userType 2/3) — human-user
   * messages must be gated out before this call.
   */
  record(groupCode: string, botAccountId: string): BotLoopRecordResult {
    const key = this.makeKey(groupCode, botAccountId);
    const now = this.now();
    this.maybeCleanup(now);

    const existing = this.store.get(key);

    // Already muted -> just report muted, don't advance the counter.
    if (existing && existing.mutedUntil > now) {
      return { muted: true, justEnteredMute: false, count: existing.count };
    }

    // Reset window when missing, expired, or previous mute has lapsed.
    if (!existing || now - existing.windowStartAt >= this.windowMs || existing.mutedUntil > 0) {
      const fresh: CounterEntry = { count: 1, windowStartAt: now, mutedUntil: 0 };
      // Trigger mute immediately when threshold == 1 (edge case).
      if (fresh.count >= this.threshold) {
        fresh.mutedUntil = now + this.muteMs;
        this.store.set(key, fresh);
        return { muted: true, justEnteredMute: true, count: fresh.count };
      }
      this.store.set(key, fresh);
      return { muted: false, justEnteredMute: false, count: fresh.count };
    }

    // Same window, not muted -> bump count.
    existing.count += 1;
    if (existing.count >= this.threshold) {
      existing.mutedUntil = now + this.muteMs;
      return { muted: true, justEnteredMute: true, count: existing.count };
    }
    return { muted: false, justEnteredMute: false, count: existing.count };
  }

  /** Read-only mute check (does not advance counters). */
  isMuted(groupCode: string, botAccountId: string): boolean {
    const entry = this.store.get(this.makeKey(groupCode, botAccountId));
    if (!entry) {
      return false;
    }
    return entry.mutedUntil > this.now();
  }

  /** Testing helper: reset one or all entries. */
  reset(groupCode?: string, botAccountId?: string): void {
    if (groupCode === undefined || botAccountId === undefined) {
      this.store.clear();
      this.lastCleanupAt = 0;
      return;
    }
    this.store.delete(this.makeKey(groupCode, botAccountId));
  }

  /** Testing helper. */
  size(): number {
    return this.store.size;
  }

  private makeKey(groupCode: string, botAccountId: string): string {
    return `${groupCode}::${botAccountId}`;
  }

  private maybeCleanup(now: number): void {
    if (now - this.lastCleanupAt < this.cleanupMinIntervalMs) {
      return;
    }
    this.lastCleanupAt = now;
    for (const [key, entry] of this.store) {
      // Entry is dead when both mute has expired and window has expired.
      const muteDead = entry.mutedUntil <= now;
      const windowDead = now - entry.windowStartAt >= this.windowMs;
      if (muteDead && windowDead) {
        this.store.delete(key);
      }
    }
  }
}

/**
 * Default runtime configuration — overridable per bot via
 * `ResolvedYuanbaoAccount.botLoop`.
 */
export const DEFAULT_BOT_LOOP_CONFIG = {
  enabled: true,
  threshold: 5,
  windowMs: 10 * 60 * 1000,
  muteMs: 30 * 60 * 1000,
} as const;

let singleton: BotLoopCounter | null = null;
let singletonKey = "";

/**
 * Process-wide singleton keyed by (threshold, windowMs, muteMs).
 * When config changes we rebuild (rare — restart-level change).
 */
export function getBotLoopCounter(opts?: Partial<BotLoopCounterOptions>): BotLoopCounter {
  const threshold = opts?.threshold ?? DEFAULT_BOT_LOOP_CONFIG.threshold;
  const windowMs = opts?.windowMs ?? DEFAULT_BOT_LOOP_CONFIG.windowMs;
  const muteMs = opts?.muteMs ?? DEFAULT_BOT_LOOP_CONFIG.muteMs;
  const key = `${threshold}::${windowMs}::${muteMs}`;
  if (!singleton || singletonKey !== key) {
    singleton = new BotLoopCounter({ threshold, windowMs, muteMs });
    singletonKey = key;
  }
  return singleton;
}

/** Testing helper: drop the singleton so a subsequent call rebuilds it. */
export function resetBotLoopCounterSingleton(): void {
  singleton = null;
  singletonKey = "";
}
