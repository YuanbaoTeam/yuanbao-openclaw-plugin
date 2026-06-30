/**
 * Unit tests for StreamingOutputSession.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createStreamingOutputSession } from "./streaming-output-session.js";
import type { MessageSender, SendResult } from "./types.js";

function fakeSender(): { sender: MessageSender; sent: string[] } {
  const sent: string[] = [];
  const ok: SendResult = { ok: true };
  const sender: MessageSender = {
    sendText: async (text) => { sent.push(text); return ok; },
    sendMedia: async () => ok,
    sendSticker: async () => ok,
    sendRaw: async () => ok,
    send: async () => ok,
    deliver: async () => {},
  };
  return { sender, sent };
}

// ── basic streaming (disableBlockStreaming=false) ────────────────────────────

void test("streaming: update below minChars stays buffered", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, minChars: 100, maxChars: 200 });
  await session.update("short text");
  assert.deepEqual(sent, [], "should not send before threshold");
});

void test("streaming: finalize sends buffered content", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, minChars: 100, maxChars: 200 });
  await session.update("short text");
  await session.finalize();
  assert.deepEqual(sent, ["short text"]);
});

void test("streaming: large update triggers immediate chunk send", async () => {
  const { sender, sent } = fakeSender();
  const bigText = "x".repeat(3000);
  const session = createStreamingOutputSession({ sender, minChars: 50, maxChars: 1000 });
  await session.update(bigText);
  assert.ok(sent.length >= 2, "should have sent chunks during update");
  assert.equal(sent.join(""), bigText.slice(0, sent.join("").length));
});

void test("streaming: finalize returns true when content sent", async () => {
  const { sender } = fakeSender();
  const session = createStreamingOutputSession({ sender });
  await session.update("hello");
  const result = await session.finalize();
  assert.equal(result, true);
});

void test("streaming: finalize returns false when nothing sent", async () => {
  const { sender } = fakeSender();
  const session = createStreamingOutputSession({ sender });
  const result = await session.finalize();
  assert.equal(result, false);
});

void test("streaming: finalize with empty/whitespace update returns false", async () => {
  const { sender } = fakeSender();
  const session = createStreamingOutputSession({ sender });
  await session.update("   ");
  const result = await session.finalize();
  assert.equal(result, false);
});

// ── flushNow ────────────────────────────────────────────────────────────────

void test("streaming: flushNow sends buffered text immediately", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, minChars: 5000 });
  await session.update("pre-tool text");
  assert.deepEqual(sent, [], "not yet sent");
  await session.flushNow();
  assert.deepEqual(sent, ["pre-tool text"]);
});

void test("streaming: flushNow then update sends new content in finalize", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, minChars: 5000 });
  await session.update("part one");
  await session.flushNow();
  await session.update("part one part two");
  await session.finalize();
  assert.deepEqual(sent, ["part one", "part two"]);
});

void test("streaming: flushNow on empty session is no-op", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender });
  await session.flushNow();
  assert.deepEqual(sent, []);
});

// ── disableBlockStreaming=true (buffered) ────────────────────────────────────

void test("buffered: update never sends immediately", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, disableBlockStreaming: true, minChars: 1 });
  await session.update("a".repeat(5000));
  assert.deepEqual(sent, [], "should not send before finalize");
});

void test("buffered: flushNow is a no-op", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, disableBlockStreaming: true, minChars: 1 });
  await session.update("some text");
  await session.flushNow();
  assert.deepEqual(sent, [], "flushNow should not send in buffered mode");
});

void test("buffered: finalize sends all content", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, disableBlockStreaming: true, maxChars: 3000 });
  await session.update("hello world");
  await session.finalize();
  assert.deepEqual(sent, ["hello world"]);
});

void test("buffered: finalize splits oversized text", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, disableBlockStreaming: true, maxChars: 10 });
  await session.update("0123456789ABCDEFGHIJ");
  await session.finalize();
  assert.ok(sent.length >= 2, "should split into chunks");
  assert.equal(sent.join(""), "0123456789ABCDEFGHIJ");
});

// ── thinking boundary repair ─────────────────────────────────────────────────

void test("boundary repair: removes mid-word newline after onReasoningEnd", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, minChars: 5000 });
  await session.update("Hi Shun！又是");
  session.markReasoningBoundary();
  await session.update("Hi Shun！又是\n你，有什么新鲜事？");
  await session.finalize();
  assert.equal(sent[0], "Hi Shun！又是你，有什么新鲜事？");
});

void test("boundary repair: removes mid-title newline (秋江/送别)", async () => {
  const { sender, sent } = fakeSender();
  const prefix = "来一首新的，换个风格 🦞\n\n---\n\n**《秋江";
  const session = createStreamingOutputSession({ sender, minChars: 5000 });
  await session.update(prefix);
  session.markReasoningBoundary();
  await session.update(`${prefix}\n送别》**\n\n枫落吴江秋水寒，`);
  await session.finalize();
  assert.ok(!sent[0].includes("《秋江\n送别》"), "spurious newline should be removed");
  assert.ok(sent[0].includes("《秋江送别》"), "title should be joined");
});

void test("boundary repair: preserves verse line break after Chinese comma", async () => {
  const { sender, sent } = fakeSender();
  const prefix = "枫落吴江秋水寒，";
  const session = createStreamingOutputSession({ sender, minChars: 5000 });
  await session.update(prefix);
  session.markReasoningBoundary();
  await session.update(`${prefix}\n孤帆远影入云端。`);
  await session.finalize();
  assert.ok(sent[0].includes("枫落吴江秋水寒，\n孤帆"), "verse line break should be preserved");
});

void test("boundary repair: repair persists across multiple subsequent updates", async () => {
  const { sender, sent } = fakeSender();
  const prefix = "来一首 🦞\n\n**《闺怨》**\n\n庭前花";
  const session = createStreamingOutputSession({ sender, minChars: 5000 });
  await session.update(prefix);
  session.markReasoningBoundary();
  await session.update(`${prefix}\n落春将暮，\n独倚栏杆。`);
  await session.update(`${prefix}\n落春将暮，\n独倚栏杆。\n千里江山，`);
  await session.finalize();
  assert.ok(!sent[0].includes("庭前花\n落春"), "mid-word newline should be removed in later update too");
});

// ── appendText ──────────────────────────────────────────────────────────────

void test("appendText: suffix is included in finalize output", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, minChars: 5000 });
  await session.update("main content");
  session.appendText("\n\n🤖 Bot: v1.0");
  await session.finalize();
  assert.ok(sent[0].includes("main content"), "main content present");
  assert.ok(sent[0].includes("🤖 Bot: v1.0"), "suffix present");
});

// ── abort ────────────────────────────────────────────────────────────────────

void test("abort: discards buffered content and returns false from finalize", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, minChars: 5000 });
  await session.update("some text");
  session.abort();
  const result = await session.finalize();
  assert.deepEqual(sent, []);
  assert.equal(result, false);
});

void test("abort: update after abort is no-op", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, minChars: 5000 });
  session.abort();
  await session.update("after abort");
  await session.finalize();
  assert.deepEqual(sent, []);
});

// ── hasReceivedPartial ───────────────────────────────────────────────────────

void test("hasReceivedPartial: false before any update", () => {
  const { sender } = fakeSender();
  const session = createStreamingOutputSession({ sender });
  assert.equal(session.hasReceivedPartial(), false);
});

void test("hasReceivedPartial: true after first update", async () => {
  const { sender } = fakeSender();
  const session = createStreamingOutputSession({ sender });
  await session.update("text");
  assert.equal(session.hasReceivedPartial(), true);
});

// ── onComplete callback ──────────────────────────────────────────────────────

void test("onComplete is called on finalize", async () => {
  const { sender } = fakeSender();
  let completed = false;
  const session = createStreamingOutputSession({ sender, onComplete: () => { completed = true; } });
  await session.update("hi");
  await session.finalize();
  assert.equal(completed, true);
});

void test("onComplete is called on abort", () => {
  const { sender } = fakeSender();
  let completed = false;
  const session = createStreamingOutputSession({ sender, onComplete: () => { completed = true; } });
  session.abort();
  assert.equal(completed, true);
});
