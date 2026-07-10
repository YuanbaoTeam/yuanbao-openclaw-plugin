/**
 * Middleware: guard against BOT↔BOT reply loops.
 *
 * When two (or more) bots in the same group keep triggering each other via
 * keyword matches they can spam the room indefinitely. This guard keeps a
 * sliding-window counter of inbound messages that originate from *other bots*
 * (identified by IM `userType` 2 = yuanbao / 3 = bot). Once the count exceeds
 * the configured threshold we enter a mute period during which every inbound
 * message is silently dropped — no user-visible notice, so we don't trigger
 * the peer bot again.
 *
 * Design notes:
 * - Group-only (`when: ctx => ctx.isGroup`); DMs bypass this guard entirely.
 * - Self-messages are already filtered by `skipSelf` upstream.
 * - Sender userType is resolved from the in-memory session cache; when the
 *   entry is missing we conservatively treat the sender as a human (no
 *   counting, no muting) to avoid false positives.
 * - Config lives on `ctx.account.botLoop`; `enabled=false` short-circuits.
 * - Read path is O(1) and never triggers WS API calls (no `queryMembers`).
 */

import { BotLoopCounter, DEFAULT_BOT_LOOP_CONFIG, getBotLoopCounter } from "../../../infra/cache/bot-loop-counter.js";
import { getMember } from "../../../infra/cache/member.js";
import type { MiddlewareDescriptor } from "../types.js";

/** IM userType values that identify a bot-controlled account. */
const BOT_USER_TYPES = new Set<number>([2, 3]);

/**
 * Injectable counter accessor — swappable in tests.
 * Default: process-wide singleton keyed by (threshold, windowMs, muteMs).
 */
let counterProvider: (opts: {
  threshold: number;
  windowMs: number;
  muteMs: number;
}) => BotLoopCounter = getBotLoopCounter;

/** Testing helper: inject a custom counter provider. */
export function setBotLoopCounterProvider(
  provider: (opts: { threshold: number; windowMs: number; muteMs: number }) => BotLoopCounter,
): void {
  counterProvider = provider;
}

/** Testing helper: restore the default (singleton) provider. */
export function resetBotLoopCounterProvider(): void {
  counterProvider = getBotLoopCounter;
}

export const guardBotLoop: MiddlewareDescriptor = {
  name: "guard-bot-loop",
  when: ctx => ctx.isGroup,
  handler: async (ctx, next) => {
    const cfg = ctx.account.botLoop;
    // Default enabled unless explicitly disabled.
    if (cfg?.enabled === false) {
      await next();
      return;
    }

    const groupCode = ctx.groupCode;
    if (!groupCode) {
      // Group message must carry groupCode; missing = malformed, skip guard.
      await next();
      return;
    }

    const botAccountId = ctx.account.botId ?? ctx.account.accountId;
    const threshold = cfg?.threshold ?? DEFAULT_BOT_LOOP_CONFIG.threshold;
    const windowMs = cfg?.windowMs ?? DEFAULT_BOT_LOOP_CONFIG.windowMs;
    const muteMs = cfg?.muteMs ?? DEFAULT_BOT_LOOP_CONFIG.muteMs;

    const counter = counterProvider({ threshold, windowMs, muteMs });

    // 1) Already muted -> silently drop, do not advance the counter.
    if (counter.isMuted(groupCode, botAccountId)) {
      ctx.log.debug(
        `[guard-bot-loop] muted, dropping inbound message groupCode=${groupCode} bot=${botAccountId} sender=${ctx.fromAccount}`,
      );
      return;
    }

    // 2) Identify sender: is it a bot?
    const sender = getMember(ctx.account.accountId).session.lookupUserById(groupCode, ctx.fromAccount);
    const senderUserType = sender?.userType;
    const senderIsBot = senderUserType !== undefined && BOT_USER_TYPES.has(senderUserType);

    // Observability: log sender identity resolution for every group inbound.
    // userType semantics: 1=human, 2=yuanbao, 3=bot; "unknown" = session cache miss
    // or member record without userType (only queryMembers/getGroupMemberList
    // populates userType — plain inbound events do not carry it).
    ctx.log.info(
      `[guard-bot-loop] sender identity groupCode=${groupCode} sender=${ctx.fromAccount} `
        + `nickname=${ctx.senderNickname ?? "-"} userType=${senderUserType ?? "unknown"} `
        + `isBot=${senderIsBot} cacheHit=${sender !== undefined}`,
    );

    // Non-bot (or unknown userType — treated as human): pass through.
    if (!senderIsBot) {
      await next();
      return;
    }

    // 3) Count this bot-originated message.
    const result = counter.record(groupCode, botAccountId);

    if (result.justEnteredMute) {
      ctx.log.info(
        `[guard-bot-loop] entering mute state groupCode=${groupCode} bot=${botAccountId} count=${result.count} threshold=${threshold} muteMs=${muteMs}`,
      );
      return; // Abort — do not reply to the message that tripped the mute.
    }
    if (result.muted) {
      // Shouldn't happen (isMuted was false above) but keep guard for safety.
      return;
    }

    ctx.log.debug(
      `[guard-bot-loop] bot-origin message counted groupCode=${groupCode} bot=${botAccountId} count=${result.count}/${threshold}`,
    );
    await next();
  },
};
