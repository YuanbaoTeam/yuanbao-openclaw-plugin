/**
 * Member memory module — per-member fact store for group chat ("派/Pai").
 *
 * Why this exists: group chat sessions share one `SessionKey`
 * (`agent:<agentId>:yuanbao:group:<groupCode>`) so the conversation context is
 * shared across all members (A's messages stay visible when B asks about them).
 * That shared context is intentional, but it means the agent has no built-in
 * way to keep per-member state — "我叫小明" from A and "我叫小张" from B land in
 * the same shared turn and the latest one overwrites the earlier one.
 *
 * This store gives the agent an explicit per-member memory bucket, keyed by
 * `(accountId, groupCode, userId)`, so it can remember "who is who" without
 * breaking the shared group context. The agent reaches it via the
 * `member_memory` tool (see `business/tools/member-memory.ts`).
 *
 * Storage is in-memory with a TTL (like `member.ts` SessionMember / chat
 * history); facts do not survive a process restart, which matches the existing
 * yuanbao plugin cache contracts.
 */

import { createLog } from "../../logger.js";

/** A single fact stored for a member. */
export type MemberFact = {
  content: string;
  updatedAt: number;
};

/** All facts stored for one member within one group. */
export type MemberMemoryRecord = {
  userId: string;
  nickname?: string;
  facts: MemberFact[];
  updatedAt: number;
};

/** TTL for a member's memory bucket. Refreshed on any write. */
const MEMORY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Cap facts per member to bound memory growth; oldest evicted first. */
const MAX_FACTS_PER_MEMBER = 50;

/**
 * Per-account member memory store.
 *
 * Buckets are keyed by `groupCode` -> `userId`, mirroring the SessionMember
 * layout in `member.ts`. Each bucket holds a deduplicated list of facts.
 */
export class MemberMemory {
  private readonly groupMembers = new Map<string, Map<string, MemberMemoryRecord>>();
  private readonly log = createLog("member-memory");

  /** Record (or refresh) a fact for a member. Dedupes on exact content. */
  remember(groupCode: string, userId: string, fact: string, nickname?: string): void {
    const trimmed = fact.trim();
    if (!groupCode || !userId || !trimmed) {
      return;
    }

    const members = this.getOrCreateGroup(groupCode);
    const now = Date.now();
    let record = members.get(userId);
    if (!record) {
      record = { userId, nickname, facts: [], updatedAt: now };
      members.set(userId, record);
    }

    // Refresh nickname whenever supplied so later lookups stay accurate.
    if (nickname) {
      record.nickname = nickname;
    }

    // Dedupe by exact content: bump timestamp of the existing fact instead of
    // adding a duplicate, so recall doesn't surface the same fact twice.
    const existing = record.facts.find(f => f.content === trimmed);
    if (existing) {
      existing.updatedAt = now;
    } else {
      record.facts.push({ content: trimmed, updatedAt: now });
    }

    // Bound the list: drop oldest when over capacity.
    if (record.facts.length > MAX_FACTS_PER_MEMBER) {
      record.facts.sort((a, b) => a.updatedAt - b.updatedAt);
      record.facts.splice(0, record.facts.length - MAX_FACTS_PER_MEMBER);
    }

    record.updatedAt = now;
    this.cleanExpired();

    this.log.debug(`remember: user=${userId} in group=${groupCode} facts=${record.facts.length}`);
  }

  /** Recall all facts for a member. Returns undefined if none stored. */
  recall(groupCode: string, userId: string): MemberMemoryRecord | undefined {
    this.cleanExpired();
    const record = this.groupMembers.get(groupCode)?.get(userId);
    if (!record || record.facts.length === 0) {
      return undefined;
    }
    return record;
  }

  /** List all members with stored facts in a group, most recently updated first. */
  list(groupCode: string): MemberMemoryRecord[] {
    this.cleanExpired();
    const members = this.groupMembers.get(groupCode);
    if (!members) {
      return [];
    }
    return Array.from(members.values())
      .filter(r => r.facts.length > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** Clear all facts for a member. Returns true if anything was removed. */
  forget(groupCode: string, userId: string): boolean {
    const members = this.groupMembers.get(groupCode);
    if (!members) {
      return false;
    }
    const removed = members.delete(userId);
    if (members.size === 0) {
      this.groupMembers.delete(groupCode);
    }
    if (removed) {
      this.log.debug(`forget: user=${userId} in group=${groupCode}`);
    }
    return removed;
  }

  /** Test helper: total bucket count across all groups. */
  size(): number {
    this.cleanExpired();
    let total = 0;
    for (const members of this.groupMembers.values()) {
      total += members.size;
    }
    return total;
  }

  private getOrCreateGroup(groupCode: string): Map<string, MemberMemoryRecord> {
    let members = this.groupMembers.get(groupCode);
    if (!members) {
      members = new Map();
      this.groupMembers.set(groupCode, members);
    }
    return members;
  }

  private cleanExpired(): void {
    const now = Date.now();
    for (const [groupCode, members] of this.groupMembers) {
      for (const [userId, record] of members) {
        if (now - record.updatedAt > MEMORY_TTL_MS) {
          members.delete(userId);
        }
      }
      if (members.size === 0) {
        this.groupMembers.delete(groupCode);
      }
    }
  }
}

// Multi-instance Runtime — Managed by accountId, mirroring member.ts

const activeMemories = new Map<string, MemberMemory>();
const runtimeLog = createLog("member-memory:runtime");

/** Get (or lazily create) the MemberMemory instance for an account. */
export function getMemberMemory(accountId: string): MemberMemory {
  let inst = activeMemories.get(accountId);
  if (!inst) {
    inst = new MemberMemory();
    activeMemories.set(accountId, inst);
    runtimeLog.debug(`created MemberMemory instance for account=${accountId}`);
  }
  return inst;
}

/** Remove the MemberMemory instance for an account (test/cleanup helper). */
export function removeMemberMemory(accountId: string): void {
  activeMemories.delete(accountId);
  runtimeLog.debug(`removed MemberMemory instance for account=${accountId}`);
}
