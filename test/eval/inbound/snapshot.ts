/**
 * Snapshot I/O + comparison for the eval system.
 *
 * Snapshots are JSON files (snapshots/<fixtureId>.snap.json) capturing the
 * AssertableParams produced by a real pipeline run. First run generates them;
 * subsequent runs diff against them — any difference is a failure.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AssertableParams, SnapshotData } from "./types.js";

const SNAPSHOTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "snapshots");
const SNAPSHOT_VERSION = 1;

/** Path to a fixture's snapshot file. */
function snapshotPath(fixtureId: string): string {
  return join(SNAPSHOTS_DIR, `${fixtureId}.snap.json`);
}

/** Load a snapshot; returns null if absent (first run). */
export function loadSnapshot(fixtureId: string): SnapshotData | null {
  const path = snapshotPath(fixtureId);
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf-8")) as SnapshotData;
}

/** Persist a snapshot (pretty-printed for readable diffs in code review). */
export function saveSnapshot(fixtureId: string, captured: AssertableParams): void {
  const data: SnapshotData = {
    fixtureId,
    snapshotVersion: SNAPSHOT_VERSION,
    captured,
  };
  writeFileSync(snapshotPath(fixtureId), JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/**
 * Deep-compare two AssertableParams objects; returns a list of human-readable
 * diff lines keyed by field path. Empty array = identical.
 */
export function diffCapture(
  expected: AssertableParams,
  actual: AssertableParams,
): string[] {
  const diffs: string[] = [];
  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const key of keys) {
    const e = (expected as Record<string, unknown>)[key];
    const a = (actual as Record<string, unknown>)[key];
    if (!deepEqual(e, a)) {
      diffs.push(`  ${key}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
    }
  }
  return diffs;
}

/** Structural deep-equal (handles arrays/objects/primitives; treats undefined === missing key). */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object" && typeof b === "object" && a && b) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every(k => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}
