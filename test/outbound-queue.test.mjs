/**
 * outbound-queue merge-text 策略单元测试
 *
 * 测试范围：
 *  - 文本积累到 minChars 后触发发送
 *  - 缓冲超过 maxChars 时切割为多条消息
 *  - abort 清除定时器且不发送内容
 *  - 媒体 push 触发文本先 flush，媒体后发
 *  - 表格流式缓冲场景
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createMergeTextSessionForTest } from "../dist/src/business/outbound/queue.js";

// ============ 测试工具 ============

/**
 * 构造一个 merge-text 会话，所有依赖通过参数控制。
 * @param {object} overrides
 * @param {string[]} sentTexts - 收集已发送的文本消息
 * @param {string[]} sentMedias - 收集已发送的媒体消息
 * @param {Function} chunkText - 自定义切割函数（默认按 maxChars 均匀切割）
 * @param {number} minChars
 * @param {number} maxChars
 */
function makeSession({
  sentTexts = [],
  sentMedias = [],
  chunkText,
  minChars = 2800,
  maxChars = 3000,
  onComplete = () => {},
} = {}) {
  const sender = {
    sendText: async (text) => {
      sentTexts.push(text);
      return { ok: true };
    },
    sendMedia: async (url) => {
      sentMedias.push(url);
      return { ok: true };
    },
    sendSticker: async () => ({ ok: true }),
    sendRaw: async () => ({ ok: true }),
    send: async (item) => {
      if (item.type === "text") return sender.sendText(item.text);
      if (item.type === "media") {
        sentMedias.push(item.mediaUrl);
        return { ok: true };
      }
      return { ok: true };
    },
    deliver: async () => {},
  };

  return createMergeTextSessionForTest({
    sender,
    strategy: "merge-text",
    onComplete,
    sessionKey: "test-session",
    minChars,
    maxChars,
    chunkText: chunkText ?? undefined,
  });
}

// ============ 测试用例 ============

test("5.1 文本积累到 minChars 后触发发送", async () => {
  const sentTexts = [];
  const session = makeSession({ sentTexts, minChars: 100, maxChars: 200 });

  // 推入 60 字符，未达阈值，不应发送
  await session.push({ type: "text", text: "A".repeat(60) });
  assert.equal(sentTexts.length, 0, "未达 minChars 不应发送");

  // 再推入 50 字符，累计 110 >= 100，应触发发送
  await session.push({ type: "text", text: "B".repeat(50) });
  assert.equal(sentTexts.length, 1, "达到 minChars 后应发送一条消息");
  assert.equal(sentTexts[0].length, 110);

  session.abort();
});

test("5.4 abort 后不发送任何内容", async () => {
  const sentTexts = [];
  let completed = false;
  const session = makeSession({
    sentTexts,
    minChars: 1000,
    onComplete: () => { completed = true; },
  });

  await session.push({ type: "text", text: "will be discarded" });
  assert.equal(sentTexts.length, 0);

  session.abort();

  assert.equal(sentTexts.length, 0, "abort 后不应发送内容");
  assert.equal(completed, true, "abort 应调用 onComplete");
});

test("5.5 媒体 push 触发文本先 flush，媒体后发", async () => {
  const sentTexts = [];
  const sentMedias = [];
  const session = makeSession({
    sentTexts,
    sentMedias,
    minChars: 1000,
  });

  // 推入少量文本（不触发 minChars）
  await session.push({ type: "text", text: "text before media" });
  assert.equal(sentTexts.length, 0, "文本未达 minChars 不应发送");

  // 推入媒体：应先 flush 文本缓冲，再发媒体
  await session.push({ type: "media", mediaUrl: "https://example.com/img.png" });

  assert.equal(sentTexts.length, 1, "媒体 push 应先 flush 文本缓冲");
  assert.equal(sentTexts[0], "text before media");
  assert.equal(sentMedias.length, 1, "媒体应在文本后发送");
  assert.equal(sentMedias[0], "https://example.com/img.png");

  session.abort();
});

test("5.6 表格行后接非表格块时自动补 \\n\\n 段落分隔", async () => {
  const sentTexts = [];
  const session = makeSession({ sentTexts, minChars: 10, maxChars: 2000 });

  const tableBlock = "| 模型 | 评分 |\n|---|---|\n| GPT-4 | ★★★★★ |\n| Claude | ★★★★ |";
  await session.push({ type: "text", text: tableBlock });

  const headingAndTable = "## 八、适用场景推荐\n\n| 场景 | 推荐模型 |\n|---|---|\n| 写作 | Claude |";
  await session.push({ type: "text", text: headingAndTable });

  await session.flush();

  const allText = sentTexts.join("");
  assert.ok(
    !allText.includes("| Claude | ★★★★ |## 八"),
    "表格行与标题之间不应直接拼接（无换行）",
  );
  assert.ok(
    allText.includes("## 八、适用场景推荐\n\n| 场景"),
    "标题与新表之间应保留 \\n\\n",
  );
});

// ============ 表格流式缓冲场景测试 ============

test("7.1 isTableInProgress 使 mid-cell 断裂行保持在 buffer 中", async () => {
  const sentTexts = [];
  const session = makeSession({ sentTexts, minChars: 10, maxChars: 2000 });

  await session.push({ type: "text", text: "| 序号 | 庙" });
  assert.equal(sentTexts.length, 0, "mid-cell 断裂行应保持在 buffer 中");

  await session.push({ type: "text", text: "号 | 姓名 |" });
  assert.equal(sentTexts.length, 0, "续接后仍是完整表格行，继续 hold");

  await session.push({ type: "text", text: "\n\nSome paragraph after table" });
  await session.flush();

  const allText = sentTexts.join("");
  assert.ok(allText.includes("| 序号 | 庙号 | 姓名 |"), "断裂的单元格应正确拼接");

  session.abort();
});

test("7.1b 行在单元格边界处截断（incoming 以 | 开头）", async () => {
  const sentTexts = [];
  const session = makeSession({ sentTexts, minChars: 200, maxChars: 2000 });

  await session.push({ type: "text", text: "| h1 | h2 | h3 | h4 | h5 | h6 | h7 |" });
  await session.push({ type: "text", text: "| --- | --- | --- | --- | --- | --- | --- |" });
  await session.push({ type: "text", text: "| 13 | 2025-01-13 | 布鲁克林篮网 | 华盛顿奇才 | 106 " });
  assert.equal(sentTexts.length, 0, "不完整行应 hold");

  await session.push({ type: "text", text: "| 98 | 主胜 |" });
  assert.equal(sentTexts.length, 0, "续接后仍是表格行，继续 hold");

  await session.flush();

  const allText = sentTexts.join("");
  assert.ok(allText.includes("| 华盛顿奇才 | 106 | 98 | 主胜 |"), "截断行应正确拼接，不应被拆成两行");
  assert.ok(!allText.includes("106 \n| 98"), "不应在 106 和 98 之间插入换行");

  session.abort();
});

test("7.2 表格 header → separator 截断后正确合并", async () => {
  const sentTexts = [];
  const session = makeSession({ sentTexts, minChars: 200, maxChars: 2000 });

  await session.push({ type: "text", text: "| 模型 | 评分 |" });
  assert.equal(sentTexts.length, 0, "表格行应 hold");

  await session.push({ type: "text", text: "| --- |" });
  assert.equal(sentTexts.length, 0, "分隔行仍是表格行，应继续 hold");

  await session.push({ type: "text", text: " --- |\n| GPT-4 | 95 |" });
  assert.equal(sentTexts.length, 0, "表格仍在进行中");

  await session.flush();

  const allText = sentTexts.join("");
  assert.ok(allText.includes("| 模型 | 评分 |"), "表头应完整");
  assert.ok(allText.includes("| GPT-4 | 95 |"), "数据行应完整");

  session.abort();
});

test("7.3 连续表格行被 hold 直到遇到非表格内容", async () => {
  const sentTexts = [];
  const session = makeSession({ sentTexts, minChars: 10, maxChars: 2000 });

  await session.push({ type: "text", text: "| a | b |" });
  assert.equal(sentTexts.length, 0);

  await session.push({ type: "text", text: "| --- | --- |" });
  assert.equal(sentTexts.length, 0);

  await session.push({ type: "text", text: "| 1 | 2 |" });
  assert.equal(sentTexts.length, 0, "表格进行中应持续 hold");

  await session.push({ type: "text", text: "| 3 | 4 |" });
  assert.equal(sentTexts.length, 0);

  await session.flush();

  const allText = sentTexts.join("");
  assert.ok(allText.includes("| a | b |"));
  assert.ok(allText.includes("| 3 | 4 |"));

  session.abort();
});

test("7.4 非表格文本不受 isTableInProgress 影响", async () => {
  const sentTexts = [];
  const session = makeSession({ sentTexts, minChars: 10, maxChars: 2000 });

  await session.push({ type: "text", text: "This is normal text that is long enough to exceed minChars." });
  assert.equal(sentTexts.length, 1, "非表格文本超过 minChars 应正常发送");

  session.abort();
});

test("7.5 表格内 \\n\\n 被 inferBlockSeparator mid-cell 规则直接拼接", async () => {
  const sentTexts = [];
  const session = makeSession({ sentTexts, minChars: 200, maxChars: 2000 });

  await session.push({ type: "text", text: "| 名称 | 说" });
  await session.push({ type: "text", text: "明 | 价格 |" });

  await session.flush();

  const allText = sentTexts.join("");
  assert.ok(allText.includes("| 名称 | 说明 | 价格 |"), "mid-cell 截断应直接拼接");

  session.abort();
});

test("7.6 大表格超过 maxChars 时不拆分发送（hold 整个 buffer）", async () => {
  const sentTexts = [];
  const session = makeSession({ sentTexts, minChars: 50, maxChars: 200 });

  const header = "| 日期 | 主队 | 客队 | 主队得分 | 客队得分 | 场馆 |";
  const sep = "| --- | --- | --- | --- | --- | --- |";
  const rows = [];
  for (let i = 0; i < 10; i++) {
    rows.push(`| 2025-02-0${i} | 快船 | 森林狼 | 121 | 115 | Arena${i} |`);
  }

  await session.push({ type: "text", text: header });
  assert.equal(sentTexts.length, 0, "表格进行中应 hold");

  await session.push({ type: "text", text: sep });
  assert.equal(sentTexts.length, 0, "分隔行应 hold");

  for (const row of rows) {
    await session.push({ type: "text", text: row });
  }
  assert.equal(sentTexts.length, 0, "大表格进行中不应拆分为多条消息");

  await session.flush();

  const allText = sentTexts.join("");
  assert.ok(allText.includes(header), "发送内容应包含完整表头");
  assert.ok(allText.includes(rows[rows.length - 1]), "发送内容应包含最后一行数据");
  if (sentTexts.length > 1) {
    for (let i = 1; i < sentTexts.length; i++) {
      const msg = sentTexts[i];
      if (msg.trim().startsWith("|")) {
        assert.ok(
          sentTexts.slice(0, i).join("").includes(header),
          `第 ${i + 1} 条消息包含表格行但之前没有表头`,
        );
      }
    }
  }

  session.abort();
});

test("7.7 大表格 hold 后非表格内容触发正常 drain", async () => {
  const sentTexts = [];
  const session = makeSession({ sentTexts, minChars: 50, maxChars: 200 });

  const header = "| a | b |";
  const sep = "| --- | --- |";
  const rows = Array.from({ length: 15 }, (_, i) => `| data${i} | value${i} |`);

  await session.push({ type: "text", text: header });
  await session.push({ type: "text", text: sep });
  for (const row of rows) {
    await session.push({ type: "text", text: row });
  }
  assert.equal(sentTexts.length, 0, "表格进行中不应发送");

  await session.push({ type: "text", text: "\n\nThis is a paragraph after the table." });

  await session.flush();

  const allText = sentTexts.join("");
  assert.ok(allText.includes(header), "表头应在输出中");
  assert.ok(allText.includes("paragraph after"), "非表格内容应在输出中");

  session.abort();
});

test("5.7 标题后接表格行时自动补 \\n\\n 段落分隔", async () => {
  const sentTexts = [];
  const session = makeSession({ sentTexts, minChars: 500, maxChars: 2000 });

  const bufferContent = "| ⚠️ 社区 |\n\n## 八、适用场景推荐";
  await session.push({ type: "text", text: bufferContent });
  assert.equal(sentTexts.length, 0, "push 1 未达 minChars，应留在 buffer 中");

  const newTable = "| 场景 | 推荐模型 |\n|---|---|\n| 写作 | Claude |";
  await session.push({ type: "text", text: newTable });

  await session.flush();

  const allText = sentTexts.join("");
  assert.ok(
    !allText.includes("## 八、适用场景推荐| 场景"),
    "标题与新表格之间不应直接拼接（无换行）",
  );
  assert.ok(
    allText.includes("## 八、适用场景推荐\n\n| 场景"),
    "标题与新表格之间应自动补 \\n\\n",
  );
});
