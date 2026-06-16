#!/usr/bin/env node
/**
 * Install the repo pre-commit hook into the local git hooks dir.
 *
 * Why not husky? This machine/org sets a global `core.hooksPath` whose
 * pre-commit is a *dispatcher* that forwards to `<repo>/.git/hooks/pre-commit`.
 * Husky would override `core.hooksPath` and bypass that dispatcher (dropping the
 * org's pre-push and other hooks). Installing a forwarder at .git/hooks/pre-commit
 * runs our checks AND keeps all org hooks intact.
 *
 * Runs automatically via the `prepare` script on `pnpm install`. Idempotent.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

try {
  // Use the REAL .git dir (NOT --git-path hooks, which honors core.hooksPath and
  // would point at the org's global hooks dir). The org dispatcher forwards to
  // "<gitdir>/hooks/pre-commit", which is what we install here.
  const gitDir = resolve(
    process.cwd(),
    execFileSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8" }).trim(),
  );
  const hooksDir = resolve(gitDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });

  const hookPath = resolve(hooksDir, "pre-commit");
  // Thin forwarder → versioned hook script in .githooks/. exec keeps the exit code.
  const forwarder = `#!/usr/bin/env sh
# Auto-installed by scripts/install-hooks.mjs — do not edit.
root="$(git rev-parse --show-toplevel)"
[ -x "$root/.githooks/pre-commit" ] && exec "$root/.githooks/pre-commit" "$@"
exit 0
`;
  writeFileSync(hookPath, forwarder);
  chmodSync(hookPath, 0o755);
  console.log(`[install-hooks] pre-commit hook installed at ${hookPath}`);
} catch (e) {
  // Never fail install because of hooks (e.g. CI without a .git dir).
  console.warn(`[install-hooks] skipped: ${e.message?.split("\n")[0]}`);
}
