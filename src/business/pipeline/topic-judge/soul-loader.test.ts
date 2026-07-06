/**
 * Unit tests for soul-loader.ts: loadSoulForTopic.
 *
 * Uses a tmpdir sandbox for each test — the loader is I/O by nature, but the
 * public API stays pure (dir passed in, no global config touched), so tests
 * are hermetic without mocking `node:fs`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { __clearSoulCacheForTests, loadSoulForTopic } from "./soul-loader.js";

async function withSandbox(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "yb-soul-"));
  __clearSoulCacheForTests();
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
    __clearSoulCacheForTests();
  }
}

void test("loadSoulForTopic 读取存在的 soul 文件", async () => {
  await withSandbox(async dir => {
    await writeFile(path.join(dir, "topic-a.md"), "## Reply Rules\n- keyword: 报名", "utf8");
    const soul = await loadSoulForTopic("topic-a", { topicSoulDir: dir });
    assert.equal(soul, "## Reply Rules\n- keyword: 报名");
  });
});

void test("loadSoulForTopic 文件不存在返回空串", async () => {
  await withSandbox(async dir => {
    const soul = await loadSoulForTopic("no-such-topic", { topicSoulDir: dir });
    assert.equal(soul, "");
  });
});

void test("loadSoulForTopic 拒绝路径穿越 topicId", async () => {
  await withSandbox(async dir => {
    // 在 dir 上一级放一个"敏感"文件，验证不会被越权读到
    const parent = path.dirname(dir);
    const secretPath = path.join(parent, "secret.md");
    await writeFile(secretPath, "SECRET", "utf8");
    try {
      assert.equal(await loadSoulForTopic("../secret", { topicSoulDir: dir }), "");
      assert.equal(await loadSoulForTopic("..", { topicSoulDir: dir }), "");
      assert.equal(await loadSoulForTopic("a/b", { topicSoulDir: dir }), "");
      assert.equal(await loadSoulForTopic("a\\b", { topicSoulDir: dir }), "");
      assert.equal(await loadSoulForTopic("with\0nul", { topicSoulDir: dir }), "");
    } finally {
      await rm(secretPath, { force: true });
    }
  });
});

void test("loadSoulForTopic 空 topicId 返回空串", async () => {
  await withSandbox(async dir => {
    assert.equal(await loadSoulForTopic("", { topicSoulDir: dir }), "");
  });
});

void test("loadSoulForTopic 命中缓存后不再读盘", async () => {
  await withSandbox(async dir => {
    const target = path.join(dir, "cached.md");
    await writeFile(target, "v1", "utf8");
    assert.equal(await loadSoulForTopic("cached", { topicSoulDir: dir }), "v1");
    // 更新磁盘文件，但缓存 TTL 未过 → 仍然应返回旧值
    await writeFile(target, "v2", "utf8");
    assert.equal(await loadSoulForTopic("cached", { topicSoulDir: dir }), "v1");
    // clear 后能读到新值
    __clearSoulCacheForTests();
    assert.equal(await loadSoulForTopic("cached", { topicSoulDir: dir }), "v2");
  });
});

void test("loadSoulForTopic 不同 topicSoulDir 独立缓存", async () => {
  await withSandbox(async dirA => {
    const dirB = await mkdtemp(path.join(tmpdir(), "yb-soul-b-"));
    try {
      await writeFile(path.join(dirA, "same.md"), "from-A", "utf8");
      await writeFile(path.join(dirB, "same.md"), "from-B", "utf8");
      assert.equal(await loadSoulForTopic("same", { topicSoulDir: dirA }), "from-A");
      assert.equal(await loadSoulForTopic("same", { topicSoulDir: dirB }), "from-B");
    } finally {
      await rm(dirB, { recursive: true, force: true });
    }
  });
});
