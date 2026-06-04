#!/usr/bin/env node
/**
 * Changed-lines coverage gate (no Python / diff-cover dependency).
 *
 * Reads coverage/lcov.info + a git diff, then computes line coverage over ONLY
 * the added/modified *executable* lines (lines that appear in lcov, so excluded
 * files and comments/types are naturally ignored). Fails when below --min.
 *
 * Usage:
 *   node scripts/diff-coverage.mjs --base origin/main --min 80   # branch vs base (CI)
 *   node scripts/diff-coverage.mjs --staged --min 80             # staged changes (pre-commit)
 *
 * Exit code 1 when below threshold or on error; 0 when passing or when there
 * are no changed executable lines.
 */

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { relative, resolve } from "node:path";

function parseArgs(argv) {
  const args = { base: null, staged: false, min: 80, lcov: "coverage/lcov.info" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--staged") args.staged = true;
    else if (a === "--base") args.base = argv[++i];
    else if (a === "--min") args.min = Number(argv[++i]);
    else if (a === "--lcov") args.lcov = argv[++i];
  }
  return args;
}

const cwd = process.cwd();

/** Parse lcov into Map<relPath, Map<line, hits>>. */
function parseLcov(file) {
  const cov = new Map();
  if (!existsSync(file)) {
    console.error(`[diff-coverage] lcov not found: ${file} (run pnpm test:coverage first)`);
    process.exit(1);
  }
  let cur = null;
  for (const raw of readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (line.startsWith("SF:")) {
      const rel = relative(cwd, resolve(line.slice(3)));
      cur = new Map();
      cov.set(rel, cur);
    } else if (line.startsWith("DA:") && cur) {
      const [ln, hits] = line.slice(3).split(",");
      cur.set(Number(ln), Number(hits));
    } else if (line === "end_of_record") {
      cur = null;
    }
  }
  return cov;
}

/** Return Map<relPath, Set<addedLineNumbers>> from a unified=0 diff. */
function parseDiff(diffText) {
  const changed = new Map();
  let file = null;
  let newLine = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++ b/")) {
      file = line.slice(6);
      if (!changed.has(file)) changed.set(file, new Set());
    } else if (line.startsWith("@@")) {
      // @@ -a,b +c,d @@  → new-file hunk starts at c
      const m = /\+(\d+)(?:,\d+)?/.exec(line);
      newLine = m ? Number(m[1]) : 0;
    } else if (file && line.startsWith("+") && !line.startsWith("+++")) {
      changed.get(file).add(newLine);
      newLine++;
    } else if (file && !line.startsWith("-") && !line.startsWith("\\")) {
      newLine++;
    }
  }
  return changed;
}

function getDiff(args) {
  const common = ["diff", "--unified=0", "--no-color", "--diff-filter=AM"];
  if (args.staged) {
    return execFileSync("git", [...common, "--cached"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  }
  const base = args.base ?? "origin/main";
  // three-dot: changes on HEAD since it diverged from base
  return execFileSync("git", [...common, `${base}...HEAD`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cov = parseLcov(args.lcov);

  let diffText;
  try {
    diffText = getDiff(args);
  } catch (e) {
    console.error(`[diff-coverage] git diff failed: ${e.message?.split("\n")[0]}`);
    process.exit(1);
  }
  const changed = parseDiff(diffText);

  let total = 0;
  let covered = 0;
  const misses = [];
  for (const [file, lines] of changed) {
    const fileCov = cov.get(file);
    if (!fileCov) continue; // not an instrumented/covered file (test, excluded, non-src, type-only)
    for (const ln of lines) {
      if (!fileCov.has(ln)) continue; // non-executable line (comment/blank/type)
      total++;
      if (fileCov.get(ln) > 0) covered++;
      else misses.push(`${file}:${ln}`);
    }
  }

  if (total === 0) {
    console.log("[diff-coverage] no changed executable lines to check — pass");
    return;
  }
  const pct = (covered / total) * 100;
  console.log(`[diff-coverage] changed-line coverage: ${covered}/${total} = ${pct.toFixed(1)}% (min ${args.min}%)`);
  if (pct + 1e-9 < args.min) {
    console.error(`[diff-coverage] FAIL: ${misses.length} uncovered changed line(s):`);
    for (const m of misses.slice(0, 40)) console.error(`  - ${m}`);
    if (misses.length > 40) console.error(`  ... and ${misses.length - 40} more`);
    process.exit(1);
  }
  console.log("[diff-coverage] PASS");
}

main();
