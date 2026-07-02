/**
 * Format eval results into a human-readable report (design doc §4.2 format).
 */

import type { HarnessResult } from "./types.js";

/** Derive a category label from the fixture id prefix. */
function categoryOf(fixtureId: string): string {
  if (fixtureId.startsWith("c2c-")) return "C2C";
  if (fixtureId.startsWith("group-")) return "Group";
  if (fixtureId.startsWith("cmd-")) return "Command";
  return "Edge";
}

/** Pad/truncate a string to a fixed width for aligned report columns. */
function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

/**
 * Render the eval report.
 *
 * @param results  one per fixture, in run order
 * @param generatedSnapshots  fixture ids whose snapshot was (re)generated this run
 */
export function formatReport(
  results: HarnessResult[],
  generatedSnapshots: Set<string> = new Set(),
): string {
  const lines: string[] = [];
  const now = new Date().toISOString().replace("T", " ").slice(0, 19);

  const total = results.length;
  const passed = results.filter(r => r.passed).length;
  const failed = total - passed;

  lines.push("════════════════════════════════════════");
  lines.push("  Inbound Pipeline Eval Report");
  lines.push(`  ${now}`);
  lines.push("════════════════════════════════════════");
  lines.push("");
  lines.push(`Total: ${total} | Passed: ${passed} | Failed: ${failed}`);
  lines.push("");

  for (const r of results) {
    const icon = r.passed ? "✅" : "❌";
    const suffix = generatedSnapshots.has(r.fixtureId) ? " (snapshot generated)" : "";
    lines.push(`${icon} ${pad(r.fixtureId, 24)} (${r.durationMs}ms)${suffix}`);
    if (!r.passed) {
      for (const err of r.errors) {
        lines.push(`   └─ ${err}`);
      }
    }
  }

  // Category summary
  const categories = new Map<string, { passed: number; total: number }>();
  for (const r of results) {
    const cat = categoryOf(r.fixtureId);
    const entry = categories.get(cat) ?? { passed: 0, total: 0 };
    entry.total++;
    if (r.passed) entry.passed++;
    categories.set(cat, entry);
  }

  lines.push("");
  lines.push("Summary:");
  for (const [cat, { passed: p, total: t }] of categories) {
    lines.push(`  ${pad(cat, 12)} ${p}/${t} passed`);
  }

  return lines.join("\n");
}
