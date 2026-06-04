/**
 * Unit tests for log-upload/extractor.ts filtering logic.
 *
 * A fake runtime with `logs.tail` is injected so extractAndFilterLogs runs its
 * pure filter pipeline (yuanbao-filter / time-range / limit / timestamp parse)
 * without touching the filesystem.
 */

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { extractAndFilterLogs } from "./extractor.js";
import type { ParsedCommandArgs } from "./types.js";
import { setYuanbaoRuntime } from "../../../runtime.js";

function injectLogs(lines: string[]) {
  setYuanbaoRuntime({
    logs: { tail: async () => ({ file: "/tmp/x.log", lines, size: 1, cursor: 1 }) },
  } as unknown as PluginRuntime);
}

function args(over: Partial<ParsedCommandArgs> = {}): ParsedCommandArgs {
  return { limit: 100, uploadCos: false, ...over } as ParsedCommandArgs;
}

afterEach(() => {
  setYuanbaoRuntime(null as unknown as PluginRuntime);
});

void test("all=true returns every line via logs.tail source", async () => {
  injectLogs(["a yuanbao", "b plain", "c"]);
  const { extract, filteredLines } = await extractAndFilterLogs(args({ all: true }));
  assert.equal(extract.source, "logs.tail");
  assert.deepEqual(filteredLines, ["a yuanbao", "b plain", "c"]);
});

void test("all=false keeps only lines matching /yuanbao/i", async () => {
  injectLogs(["a YuanBao", "b plain", "c yuanbao tail"]);
  const { filteredLines } = await extractAndFilterLogs(args({ all: false }));
  assert.deepEqual(filteredLines, ["a YuanBao", "c yuanbao tail"]);
});

void test("limit slices to the last N lines", async () => {
  injectLogs(["1", "2", "3", "4"]);
  const { filteredLines } = await extractAndFilterLogs(args({ all: true, limit: 2 }));
  assert.deepEqual(filteredLines, ["3", "4"]);
});

void test("time range filters by parsed @timestamp", async () => {
  const inRange = JSON.stringify({ "@timestamp": "2026-05-25T10:00:00.000Z", msg: "yuanbao hit" });
  const outRange = JSON.stringify({ "@timestamp": "2020-01-01T00:00:00.000Z", msg: "yuanbao old" });
  const noTs = "plain yuanbao line without timestamp";
  injectLogs([inRange, outRange, noTs]);

  const start = Date.parse("2026-05-01T00:00:00.000Z");
  const end = Date.parse("2026-06-01T00:00:00.000Z");
  const { filteredLines } = await extractAndFilterLogs(args({ all: true, startTime: start, endTime: end }));

  assert.equal(filteredLines.length, 1);
  assert.match(filteredLines[0], /yuanbao hit/);
});

void test("falls back across logs.tail then gateway.request", async () => {
  // No logs.tail; gateway.request answers instead.
  setYuanbaoRuntime({
    gateway: { request: async (_m: string) => ({ file: "/g.log", lines: ["yuanbao via gateway"], size: 1, cursor: 1 }) },
  } as unknown as PluginRuntime);
  const { extract, filteredLines } = await extractAndFilterLogs(args({ all: true }));
  assert.equal(extract.source, "logs.tail");
  assert.deepEqual(filteredLines, ["yuanbao via gateway"]);
});
