/**
 * Eval runner: loads fixtures, drives each through the harness, compares
 * (or generates) snapshots, and prints a report.
 *
 * CLI:
 *   tsx test/eval/inbound/runner.ts [--update-snapshots] [--filter=tag1,tag2]
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatReport } from "./report.js";
import { diffCapture, loadSnapshot, saveSnapshot } from "./snapshot.js";
import { runFixture } from "./harness.js";
import type { Fixture, HarnessResult } from "./types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(HERE, "fixtures");

/** Load all fixtures (sorted by id for stable run order). */
function loadFixtures(): Fixture[] {
  const files = readdirSync(FIXTURES_DIR)
    .filter(f => f.endsWith(".json"))
    .sort();
  return files.map(f => JSON.parse(readFileSync(join(FIXTURES_DIR, f), "utf-8")) as Fixture);
}

interface CliOptions {
  updateSnapshots: boolean;
  filter: string[] | null;
}

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { updateSnapshots: false, filter: null };
  for (const arg of argv) {
    if (arg === "--update-snapshots" || arg === "-u") {
      opts.updateSnapshots = true;
    } else if (arg.startsWith("--filter=")) {
      opts.filter = arg.slice("--filter=".length).split(",").map(s => s.trim()).filter(Boolean);
    }
  }
  return opts;
}

export interface RunOutcome {
  results: HarnessResult[];
  generated: Set<string>;
  exitCode: number;
}

/** Run all (or filtered) fixtures; generate or compare snapshots. */
export async function runAll(opts: CliOptions): Promise<RunOutcome> {
  let fixtures = loadFixtures();
  if (opts.filter) {
    fixtures = fixtures.filter(f => f.tags?.some(t => opts.filter!.includes(t)));
  }

  const results: HarnessResult[] = [];
  const generated = new Set<string>();

  for (const fixture of fixtures) {
    const errors: string[] = [];
    let actual;
    let durationMs = 0;
    let capture;

    try {
      const run = await runFixture(fixture);
      capture = run.capture;
      actual = run.actual;
      durationMs = run.durationMs;
      errors.push(...run.errors);
    } catch (err) {
      results.push({
        fixtureId: fixture.id,
        description: fixture.description,
        passed: false,
        capture: { called: false, callCount: 0, params: null },
        actual: {} as never,
        errors: [`harness threw: ${String(err)}`],
        durationMs: 0,
      });
      continue;
    }

    const snapshot = loadSnapshot(fixture.id);
    const shouldGenerate = opts.updateSnapshots || snapshot === null;

    if (shouldGenerate) {
      saveSnapshot(fixture.id, actual);
      generated.add(fixture.id);
      // Generation run: no snapshot diff, but still check expected.shouldDispatch.
    } else {
      const diffs = diffCapture(snapshot!.captured, actual);
      errors.push(...diffs);
    }

    // Advisory hard-check: if the fixture declares expected.shouldDispatch,
    // flag any divergence from reality (surfaces design-doc-vs-code drift).
    if (fixture.expected?.shouldDispatch !== undefined) {
      if (actual.shouldDispatch !== fixture.expected.shouldDispatch) {
        errors.push(
          `expected shouldDispatch=${fixture.expected.shouldDispatch}, got ${actual.shouldDispatch}`,
        );
      }
    }

    results.push({
      fixtureId: fixture.id,
      description: fixture.description,
      passed: errors.length === 0,
      capture,
      actual,
      errors,
      durationMs,
    });
  }

  const exitCode = results.every(r => r.passed) ? 0 : 1;
  return { results, generated, exitCode };
}

// CLI entry point
const opts = parseArgs(process.argv.slice(2));
const outcome = await runAll(opts);
console.log(formatReport(outcome.results, outcome.generated));
if (outcome.generated.size > 0) {
  console.log("");
  console.log(`${outcome.generated.size} snapshot(s) generated — review and commit snapshots/.`);
}
process.exit(outcome.exitCode);
