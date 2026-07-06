/**
 * Soul.md loader for topic-scoped self-judge (L2).
 *
 * Reads `<topicSoulDir>/<topicId>.md` from disk with an LRU+TTL cache so the
 * pipeline hot path doesn't hit the filesystem on every message. Missing files
 * are treated as "no soul configured" and cached as empty strings (fallback:
 * judge returns `shouldReply=false` — safest default to avoid spam).
 *
 * The loader is intentionally decoupled from the OpenClaw config layer: the
 * caller resolves `topicSoulDir` from `channels.yuanbao.topicSoulDir` (or the
 * default) and passes it in. This keeps the module unit-testable without
 * environment side effects.
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_SOUL_DIR = "~/.openclaw/topic-souls";
const CACHE_SIZE = 32;
const CACHE_TTL_MS = 60 * 1000;

/**
 * Expand a leading `~` to the user's home directory. Non-`~` paths pass through.
 * Kept private — matches the same convention used by `business/utils/media.ts`.
 */
function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
    return homedir() + p.slice(1);
  }
  return p;
}

/**
 * Validate a `topicId` for safe use as a filename segment.
 *
 * Rejects path traversal (`..`), directory separators, absolute paths, and
 * NUL bytes. Returns `null` when unsafe — caller should treat that as "no soul".
 */
function sanitizeTopicId(topicId: string): string | null {
  if (!topicId || typeof topicId !== "string") {
    return null;
  }
  if (topicId.includes("/") || topicId.includes("\\") || topicId.includes("\0")) {
    return null;
  }
  if (topicId === "." || topicId === ".." || topicId.includes("..")) {
    return null;
  }
  // Belt-and-suspenders: reject anything that would resolve outside the dir.
  if (path.isAbsolute(topicId)) {
    return null;
  }
  return topicId;
}

interface CacheEntry {
  soul: string;
  expiresAt: number;
}

/**
 * LRU cache with TTL. Same pattern as `directory.ts`'s `DirectoryLRUCache`,
 * kept local to avoid a cross-module dependency for a 30-line helper.
 */
class SoulLRUCache {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly maxSize: number,
    private readonly ttlMs: number,
  ) {}

  get(key: string): string | undefined {
    const item = this.cache.get(key);
    if (!item) {
      return undefined;
    }
    if (Date.now() > item.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    // Move to end (most recently used).
    this.cache.delete(key);
    this.cache.set(key, item);
    return item.soul;
  }

  set(key: string, soul: string): void {
    this.cache.delete(key);
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { soul, expiresAt: Date.now() + this.ttlMs });
  }

  clear(): void {
    this.cache.clear();
  }
}

const soulCache = new SoulLRUCache(CACHE_SIZE, CACHE_TTL_MS);

/**
 * Clear the in-memory cache. Test-only escape hatch — not exposed via the
 * package barrel.
 */
export function __clearSoulCacheForTests(): void {
  soulCache.clear();
}

export interface LoadSoulOptions {
  /**
   * Directory containing per-topic soul.md files. Supports `~` prefix.
   * Defaults to `~/.openclaw/topic-souls`.
   */
  topicSoulDir?: string;
}

/**
 * Load the soul.md content for a given topic.
 *
 * Returns an empty string when:
 * - `topicId` is unsafe (path traversal attempt)
 * - The file doesn't exist
 * - The file can't be read for any reason (permission, etc.)
 *
 * Never throws. Cached for `CACHE_TTL_MS`, capped at `CACHE_SIZE` entries.
 */
export async function loadSoulForTopic(
  topicId: string,
  options: LoadSoulOptions = {},
): Promise<string> {
  const safeId = sanitizeTopicId(topicId);
  if (!safeId) {
    return "";
  }

  const dir = options.topicSoulDir ?? DEFAULT_SOUL_DIR;
  const cacheKey = `${dir}::${safeId}`;

  const cached = soulCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const filePath = path.join(expandHome(dir), `${safeId}.md`);
  let content = "";
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    // Missing / unreadable → treat as no soul. Cache the miss to avoid
    // re-checking every message for topics without a soul file.
    content = "";
  }

  soulCache.set(cacheKey, content);
  return content;
}
