/**
 * Eval harness: drive one fixture through the REAL 17-middleware pipeline and
 * capture the dispatchReply invocation.
 *
 * Does NOT perform snapshot comparison — that's the runner's job. This module
 * only sets up deterministic isolation, runs the pipeline, and returns the
 * captured params + a flattened view of the resulting ctx.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPipeline } from "../../../src/business/pipeline/create.js";
import { chatHistories, chatMediaHistories } from "../../../src/business/messaging/chat-history.js";
import { clearRateLimits } from "../../../src/business/pipeline/middlewares/guard-send-access.js";
import { extractAssertableParams } from "./capture.js";
import { buildPipelineContext } from "./ctx-builder.js";
import { createCoreMock } from "./core-mock.js";
import type { AssertableParams, DispatchCapture, Fixture } from "./types.js";

/** Isolated HOME so resolveRoute's session-store read returns undefined. */
const EVAL_HOME = join(tmpdir(), "yuanbao-eval-home");

/**
 * Run a single fixture through the real pipeline.
 *
 * @returns HarnessResult with `capture`/`actual` populated. `passed` is
 *          tentative (true unless the pipeline threw) — the runner overlays
 *          snapshot comparison before reporting.
 */
export async function runFixture(fixture: Fixture): Promise<{
  fixtureId: string;
  description: string;
  capture: DispatchCapture;
  actual: AssertableParams;
  durationMs: number;
  errors: string[];
}> {
  const start = Date.now();
  const errors: string[] = [];

  // 1. Deterministic environment: isolate HOME so resolveRoute's
  //    resolveInboundSessionEnvelopeContext reads a non-existent session store
  //    (→ previousTimestamp undefined) instead of the real user's store.
  process.env.HOME = EVAL_HOME;

  // 2. Clear cross-fixture global state (LRUs, rate limit map).
  chatHistories.clear();
  chatMediaHistories.clear();
  clearRateLimits();

  // 3. Build mock core (with capture point) + real pipeline context.
  const { core, capture } = createCoreMock(fixture.config);
  const ctx = buildPipelineContext(fixture.input, fixture.config, core);
  const pipeline = createPipeline();

  // 4. Drive the real 17-middleware pipeline.
  try {
    await pipeline.execute(ctx);
  } catch (err) {
    errors.push(`pipeline threw: ${String(err)}`);
  }

  // 5. Extract the flattened view (merges dispatch params + ctx fields).
  const actual = extractAssertableParams(capture, ctx);

  return {
    fixtureId: fixture.id,
    description: fixture.description,
    capture,
    actual,
    durationMs: Date.now() - start,
    errors,
  };
}
