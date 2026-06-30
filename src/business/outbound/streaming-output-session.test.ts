/**
 * Unit tests for StreamingOutputSession.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createStreamingOutputSession, defaultChunkText } from "./streaming-output-session.js";
import type { MessageSender, SendResult } from "./types.js";
import { chunkMarkdownText } from "./test-helpers/openclaw-chunk.js";

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

void test("defaultChunkText prefers newline boundaries", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line-${i}-${"a".repeat(20)}`).join("\n");
  const chunks = defaultChunkText(lines, 200);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(""), lines);
  let offset = 0;
  for (const chunk of chunks.slice(0, -1)) {
    offset += chunk.length;
    if (offset < lines.length) {
      assert.equal(lines[offset - 1], "\n", "inter-chunk break should follow a newline");
    }
  }
});

void test("defaultChunkText hard-splits only when a single line exceeds max", () => {
  const text = "a".repeat(250);
  const chunks = defaultChunkText(text, 100);
  assert.equal(chunks.join(""), text);
  assert.ok(chunks.length >= 3);
});

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

void test("streaming: single chunk at minChars stays buffered until finalize", async () => {
  const { sender, sent } = fakeSender();
  const text = "x".repeat(900);
  const session = createStreamingOutputSession({ sender, minChars: 800, maxChars: 1200 });
  await session.update(text);
  assert.equal(sent.length, 0, "one chunk may be incomplete — wait for finalize");
  await session.finalize();
  assert.equal(sent.length, 1);
  assert.equal(sent[0], text);
});

void test("streaming: large update triggers immediate chunk send", async () => {
  const { sender, sent } = fakeSender();
  const bigText = Array.from({ length: 200 }, (_, i) => `row ${i}: ${"x".repeat(10)}`).join("\n");
  const session = createStreamingOutputSession({ sender, minChars: 50, maxChars: 1000 });
  await session.update(bigText);
  assert.ok(sent.length >= 1, "should stream at newline boundary during update");
  await session.finalize();
  assert.equal(sent.join(""), bigText);
});

void test("streaming: large text is split by maxChars", async () => {
  const { sender, sent } = fakeSender();
  const bigText = "x".repeat(250);
  const session = createStreamingOutputSession({ sender, minChars: 50, maxChars: 100 });
  await session.update(bigText);
  await session.finalize();
  assert.ok(sent.length >= 2, "should have split the text");
  assert.equal(sent.join(""), bigText);
});

void test("streaming: single chunk under maxChars is not sent during update", async () => {
  const { sender, sent } = fakeSender();
  const css = "        .card {\n" + "            line-height: 1.5;\n".repeat(40);
  const session = createStreamingOutputSession({
    sender,
    minChars: 800,
    maxChars: 1200,
    chunkText: chunkMarkdownText,
  });
  await session.update(css.slice(0, 801));
  assert.deepEqual(sent, [], "801 chars in one chunk — still streaming, do not send");
  await session.finalize();
  assert.equal(sent.length, 1);
});

void test("streaming: unclosed fence under maxChars stays buffered until closed or finalize", async () => {
  const { sender, sent } = fakeSender();
  const partial = "```js\n" + "x".repeat(500);
  const session = createStreamingOutputSession({
    sender,
    minChars: 100,
    maxChars: 1200,
    chunkText: chunkMarkdownText,
  });
  await session.update(partial);
  assert.deepEqual(sent, [], "mid-fence under maxChars should not stream yet");
  await session.update(partial + "\n```");
  assert.deepEqual(sent, [], "closed block in one chunk — still wait until >1 chunk or finalize");
  await session.finalize();
  assert.equal(sent.length, 1);
});

void test("streaming: unclosed fence over maxChars sends complete chunks only", async () => {
  const { sender, sent } = fakeSender();
  const partial = "```js\n" + "y".repeat(1300);
  const session = createStreamingOutputSession({
    sender,
    minChars: 100,
    maxChars: 1200,
    chunkText: chunkMarkdownText,
  });
  await session.update(partial);
  assert.ok(sent.length >= 1, "multiple chunks — send all but last");
  await session.finalize();
  assert.ok(sent.join("").includes("y".repeat(100)), "finalize sends tail");
});

void test("streaming: unclosed math under maxChars stays buffered until closed or finalize", async () => {
  const { sender, sent } = fakeSender();
  const partial = "$$ E = mc^2 + " + "x".repeat(500);
  const session = createStreamingOutputSession({
    sender,
    minChars: 100,
    maxChars: 1200,
    chunkText: chunkMarkdownText,
  });
  await session.update(partial);
  assert.deepEqual(sent, [], "mid-math under maxChars should not stream yet");
  await session.update(partial + " $$");
  assert.deepEqual(sent, [], "closed math in one chunk — still wait until >1 chunk or finalize");
  await session.finalize();
  assert.equal(sent.length, 1);
});

void test("streaming: unclosed math over maxChars sends complete chunks only", async () => {
  const { sender, sent } = fakeSender();
  const partial = "$$ " + "z".repeat(1300);
  const session = createStreamingOutputSession({
    sender,
    minChars: 100,
    maxChars: 1200,
    chunkText: chunkMarkdownText,
  });
  await session.update(partial);
  assert.ok(sent.length >= 1, "multiple chunks — send all but last");
  await session.finalize();
  assert.ok(sent.join("").includes("z".repeat(100)), "finalize sends tail");
});

void test("streaming: streams only when chunkText yields multiple chunks", async () => {
  const { sender, sent } = fakeSender();
  const lines = Array.from({ length: 80 }, (_, i) => `line${i + 1} = "value_${String(i).padStart(3, "0")}";`).join("\n");
  const partial = "```html\n" + lines;
  const session = createStreamingOutputSession({
    sender,
    minChars: 100,
    maxChars: 1200,
    chunkText: chunkMarkdownText,
  });
  await session.update("intro\n\n" + partial);
  assert.ok(sent.length >= 1, "should stream once chunkText splits into >1 chunk");
  const totalBeforeFinalize = sent.join("").length;
  await session.finalize();
  assert.ok(sent.join("").length > totalBeforeFinalize, "finalize sends remaining tail");
});

void test("streaming: code block split adds opening fence to later chunks", async () => {
  const { sender, sent } = fakeSender();
  const codeLines = Array.from({ length: 20 }, (_, i) => `line${i + 1} = "value_${i + 1}"`).join("\n");
  const codeBlock = "```python\n" + codeLines + "\n```";
  const session = createStreamingOutputSession({
    sender,
    minChars: 50,
    maxChars: 100,
    chunkText: chunkMarkdownText,
  });
  await session.update(codeBlock);
  await session.finalize();
  assert.ok(sent.length >= 2, "should have split the code block");
  for (const chunk of sent) {
    assert.ok(chunk.includes("```"), `each chunk should contain fence markers, got: ${JSON.stringify(chunk)}`);
  }
  const lastChunk = sent.at(-1)!;
  assert.ok(lastChunk.startsWith("```"), `last chunk must start with opening fence, got: ${JSON.stringify(lastChunk)}`);
});

void test("streaming: plan splits on newlines not mid-line", async () => {
  const { sender, sent } = fakeSender();
  const text = [
    "line one is here",
    "line two is here",
    "line three is here",
    "line four is here",
    "line five is here",
  ].join("\n");
  const session = createStreamingOutputSession({
    sender,
    minChars: 30,
    maxChars: 50,
    chunkText: (t) => [t],
  });
  await session.update(text);
  await session.finalize();
  for (const chunk of sent) {
    for (const line of chunk.split("\n")) {
      if (!line) continue;
      assert.ok(
        text.includes(line),
        `chunk contains partial line fragment: ${JSON.stringify(line)}`,
      );
    }
  }
  assert.equal(sent.join(""), text);
});

void test("streaming: finalize does not wrap markdown tail in code fence", async () => {
  const { sender, sent } = fakeSender();
  const prefix = "intro\n```html\nbody { color: red; }\n";
  const suffix = "```\n\n---\n\n**说明** here";
  const session = createStreamingOutputSession({
    sender,
    minChars: 20,
    maxChars: 80,
    chunkText: (t, max) => {
      if (t.length <= max) return [t];
      const breakAt = t.lastIndexOf("\n", max);
      const idx = breakAt > 0 ? breakAt + 1 : max;
      return [t.slice(0, idx), t.slice(idx)];
    },
  });
  await session.update(prefix + suffix);
  await session.flushNow();
  await session.finalize();
  const tailMsg = sent.at(-1)!;
  assert.ok(tailMsg.includes("**说明**"));
  assert.ok(!tailMsg.startsWith("```html"), `markdown tail should not reopen fence: ${JSON.stringify(tailMsg)}`);
});

void test("streaming: mid-fence finalize prepends opening fence", async () => {
  const { sender, sent } = fakeSender();
  const part1 = "intro\n```html\n@keyframes pulse {\n  0% { opacity: 1; }\n";
  const part2 = "  100% { opacity: 0; }\n}\n</style>\n```\n\ndone";
  const session = createStreamingOutputSession({
    sender,
    minChars: 40,
    maxChars: 80,
    chunkText: chunkMarkdownText,
  });
  await session.update(part1);
  await session.flushNow();
  await session.update(part1 + part2);
  await session.finalize();
  const joined = sent.join("");
  assert.ok(joined.includes("@keyframes pulse"), "pulse keyframes should be present");
  assert.ok(joined.includes("100% { opacity: 0; }"), "tail of block should be present");
  assert.ok(sent.some(c => c.startsWith("```html")), "a mid-stream chunk should reopen the html fence");
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
  assert.deepEqual(sent, ["part one", " part two"]);
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

void test("streaming: sandwich repair triggers drain without next partial", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, minChars: 10, maxChars: 5000 });
  const prefix = "Hi Shun！又是";
  await session.update(prefix);
  session.markReasoningBoundary();
  await session.update(`${prefix}\n你，有什么新鲜事？`);
  session.markReasoningBoundary();
  assert.deepEqual(sent, [], "single chunk not sent during stream");
  await session.finalize();
  assert.ok(sent.length >= 1, "sandwich-repaired text sent on finalize");
  assert.ok(!sent.join("").includes("又是\n你"), "spurious newline removed");
});

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

// ── sandwich repair (no-snapshot / table) ───────────────────────────────────

void test("sandwich repair: single spurious \\n removed after 2nd onReasoningEnd", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, minChars: 5000 });
  // 1st onReasoningEnd — no prior partial
  session.markReasoningBoundary();
  // onPartialReply — broken text with single \n
  await session.update("Hi Shun！\n🦞 有啥需要帮忙的？");
  // 2nd onReasoningEnd — sandwich confirmed, triggers repair
  session.markReasoningBoundary();
  await session.finalize();
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes("Shun！\n🦞"), "spurious newline should be removed");
  assert.ok(sent[0].includes("Shun！🦞"), "characters should be joined");
});

void test("sandwich repair: subsequent partial replay fixes still-broken text", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, minChars: 5000 });
  session.markReasoningBoundary();
  await session.update("Hi Shun！\n🦞 有啥需要帮忙的？");
  session.markReasoningBoundary();
  // SDK sends another cumulative partial with the same original \n
  await session.update("Hi Shun！\n🦞 有啥需要帮忙的？更多内容");
  await session.finalize();
  assert.ok(!sent[0].includes("Shun！\n🦞"), "spurious newline removed in replay");
  assert.ok(sent[0].includes("Shun！🦞"), "characters joined in replay");
  assert.ok(sent[0].includes("更多内容"), "additional content preserved");
});

void test("sandwich repair: table mid-cell break is merged", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, minChars: 5000 });
  session.markReasoningBoundary();
  // onPartialReply: table with broken cell
  const broken = "| 🐍\nPython | 简洁 | AI |\n|---|---|---|\n| ⚡ JS | 全栈 | Web |";
  await session.update(broken);
  session.markReasoningBoundary();
  await session.finalize();
  assert.ok(!sent[0].includes("🐍\nPython"), "broken cell should be merged");
  assert.ok(sent[0].includes("🐍Python"), "emoji and name joined");
});

void test("sandwich repair: table separator row break is merged", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, minChars: 5000 });
  session.markReasoningBoundary();
  const broken = "| Git 命令 | 作用 |\n|------------\n-|------|\n| `git status` | 查看状态 |";
  await session.update(broken);
  session.markReasoningBoundary();
  await session.finalize();
  assert.ok(!sent[0].includes("------------\n-|"), "broken separator should be merged");
  assert.ok(sent[0].includes("git status"), "data rows preserved");
});

void test("sandwich repair: spurious \\n at join point of next partial is removed", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, minChars: 5000 });
  session.markReasoningBoundary();  // 1st onReasoningEnd, no prior text
  // text1: first partial after 1st reasoning end (no \n issue in text1 itself)
  await session.update("你好 Jes！🦞\n\n有啥需要帮忙的？代码、文档、");
  session.markReasoningBoundary();  // 2nd onReasoningEnd, sandwich confirmed
  // text2: next partial — delta starts with \n (spurious join artifact)
  await session.update("你好 Jes！🦞\n\n有啥需要帮忙的？代码、文档、\nbug、或者聊聊技术问题都行。");
  await session.finalize();
  assert.equal(sent.length, 1);
  assert.ok(!sent[0].includes("文档、\nbug"), "spurious \\n at join point should be removed");
  assert.ok(sent[0].includes("文档、bug"), "text should be joined without spurious \\n");
  assert.ok(sent[0].includes("\n\n"), "paragraph break should be preserved");
});

void test("sandwich repair: paragraph \\n\\n is preserved", async () => {
  const { sender, sent } = fakeSender();
  const session = createStreamingOutputSession({ sender, minChars: 5000 });
  session.markReasoningBoundary();
  await session.update("你好～ 🦞\n\n有什么可以帮你的？");
  session.markReasoningBoundary();
  await session.finalize();
  assert.ok(sent[0].includes("\n\n"), "paragraph break should be preserved");
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
