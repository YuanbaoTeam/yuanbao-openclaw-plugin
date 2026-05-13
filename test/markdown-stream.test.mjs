/**
 * markdown-stream 工具函数单元测试
 *
 * 覆盖 endsWithTableRow、isTableInProgress、hasUnclosedFence、
 * hasUnclosedMathBlock、inferBlockSeparator、extractAtomicBlocks 等函数。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mdFence,
  mdBlock,
  mdAtomic,
  mdTable,
  mdMath,
} from '../dist/src/business/utils/markdown.js';

const endsWithTableRow = mdBlock.endsWithTableRow;
const isTableInProgress = mdBlock.isTableInProgress;
const hasUnclosedFence = mdFence.hasUnclosed;
const hasUnclosedMathBlock = mdFence.hasUnclosedMath;
const normalizeMathBlocks = mdMath.normalize;
const startsWithBlockElement = mdBlock.startsWithBlockElement;
const inferBlockSeparator = mdBlock.inferSeparator;
const mergeBlockStreamingFences = mdFence.mergeBlockStreaming;
const extractAtomicBlocks = mdAtomic.extract;
const chunkMarkdownTextAtomicAware = mdAtomic.chunkAware;

// ============================================================
// endsWithTableRow
// ============================================================

test('endsWithTableRow: complete table row', () => {
  assert.equal(endsWithTableRow('| a | b |'), true);
});

test('endsWithTableRow: table row with trailing whitespace', () => {
  assert.equal(endsWithTableRow('| a | b |  \n  '), true);
});

test('endsWithTableRow: incomplete row (no trailing pipe)', () => {
  assert.equal(endsWithTableRow('| a | b'), false);
});

test('endsWithTableRow: empty string', () => {
  assert.equal(endsWithTableRow(''), false);
});

test('endsWithTableRow: multi-line with table at end', () => {
  assert.equal(endsWithTableRow('some text\n| h1 | h2 |'), true);
});

test('endsWithTableRow: text with pipe but not table', () => {
  assert.equal(endsWithTableRow('选择 A | 选择 B'), false);
});

// ============================================================
// isTableInProgress
// ============================================================

test('isTableInProgress: complete table row', () => {
  assert.equal(isTableInProgress('| a | b |'), true);
});

test('isTableInProgress: mid-cell break (row not ending with pipe)', () => {
  assert.equal(isTableInProgress('| 序号 | 庙'), true);
});

test('isTableInProgress: separator row', () => {
  assert.equal(isTableInProgress('| --- | --- |'), true);
});

test('isTableInProgress: partial separator row', () => {
  assert.equal(isTableInProgress('| ---'), true);
});

test('isTableInProgress: empty string', () => {
  assert.equal(isTableInProgress(''), false);
});

test('isTableInProgress: non-table text', () => {
  assert.equal(isTableInProgress('hello world'), false);
});

test('isTableInProgress: text with pipe but not starting with pipe', () => {
  assert.equal(isTableInProgress('选择 A | 选择 B'), false);
});

test('isTableInProgress: multi-line, last line is table', () => {
  assert.equal(isTableInProgress('intro\n| col1 | col2'), true);
});

test('isTableInProgress: multi-line, last line is not table', () => {
  assert.equal(isTableInProgress('| col1 | col2 |\nsome text'), false);
});

test('isTableInProgress: trailing blank lines after table row', () => {
  assert.equal(isTableInProgress('| a | b |\n  \n  '), true);
});

// ============================================================
// hasUnclosedFence
// ============================================================

test('hasUnclosedFence: no fence', () => {
  assert.equal(hasUnclosedFence('hello world'), false);
});

test('hasUnclosedFence: properly closed fence', () => {
  assert.equal(hasUnclosedFence('```js\ncode\n```'), false);
});

test('hasUnclosedFence: unclosed fence', () => {
  assert.equal(hasUnclosedFence('```js\ncode'), true);
});

test('hasUnclosedFence: nested fence (odd count)', () => {
  assert.equal(hasUnclosedFence('```\na\n```\nb\n```'), true);
});

test('hasUnclosedFence: two closed fences', () => {
  assert.equal(hasUnclosedFence('```\na\n```\n```\nb\n```'), false);
});

// ============================================================
// hasUnclosedMathBlock
// ============================================================

test('hasUnclosedMathBlock: no math', () => {
  assert.equal(hasUnclosedMathBlock('hello'), false);
});

test('hasUnclosedMathBlock: closed math block', () => {
  assert.equal(hasUnclosedMathBlock('$$\nx^2\n$$'), false);
});

test('hasUnclosedMathBlock: unclosed math block', () => {
  assert.equal(hasUnclosedMathBlock('$$\nx^2'), true);
});

test('hasUnclosedMathBlock: math inside fence is ignored', () => {
  assert.equal(hasUnclosedMathBlock('```\n$$\n```'), false);
});

// ============================================================
// normalizeMathBlocks
// ============================================================

test('normalizeMathBlocks: removes double newlines inside math', () => {
  const input = '$$\na\n\nb\n$$';
  const expected = '$$\na\nb\n$$';
  assert.equal(normalizeMathBlocks(input), expected);
});

test('normalizeMathBlocks: no math returns unchanged', () => {
  const input = 'hello world\n\nnext paragraph';
  assert.equal(normalizeMathBlocks(input), input);
});

test('normalizeMathBlocks: does not touch content inside fences', () => {
  const input = '```\n$$\na\n\nb\n$$\n```';
  assert.equal(normalizeMathBlocks(input), input);
});

// ============================================================
// startsWithBlockElement
// ============================================================

test('startsWithBlockElement: heading', () => {
  assert.equal(startsWithBlockElement('## Title'), true);
});

test('startsWithBlockElement: table', () => {
  assert.equal(startsWithBlockElement('| a | b |'), true);
});

test('startsWithBlockElement: code fence', () => {
  assert.equal(startsWithBlockElement('```js\ncode\n```'), true);
});

test('startsWithBlockElement: unordered list', () => {
  assert.equal(startsWithBlockElement('- item'), true);
});

test('startsWithBlockElement: ordered list', () => {
  assert.equal(startsWithBlockElement('1. item'), true);
});

test('startsWithBlockElement: blockquote', () => {
  assert.equal(startsWithBlockElement('> quote'), true);
});

test('startsWithBlockElement: thematic break (---)', () => {
  assert.equal(startsWithBlockElement('---'), true);
});

test('startsWithBlockElement: math block', () => {
  assert.equal(startsWithBlockElement('$$\nx^2\n$$'), true);
});

test('startsWithBlockElement: plain text', () => {
  assert.equal(startsWithBlockElement('hello world'), false);
});

// ============================================================
// inferBlockSeparator
// ============================================================

test('inferBlockSeparator: inside unclosed fence returns empty', () => {
  assert.equal(inferBlockSeparator('```js\ncode', 'more code'), '');
});

test('inferBlockSeparator: inside unclosed math block returns empty', () => {
  assert.equal(inferBlockSeparator('$$\nx^2', '+1'), '');
});

test('inferBlockSeparator: buffer already ends with \\n\\n returns empty', () => {
  assert.equal(inferBlockSeparator('text\n\n', 'next'), '');
});

test('inferBlockSeparator: mid-cell break (direct concat)', () => {
  assert.equal(inferBlockSeparator('| 序号 | 庙', '号 | 姓名 |'), '');
});

test('inferBlockSeparator: mid-cell with partial separator row', () => {
  assert.equal(inferBlockSeparator('| ---', ' | --- |'), '');
});

test('inferBlockSeparator: incomplete row + incoming starts with pipe (cell boundary break)', () => {
  // NBA 表格场景：行在 "| 106 " 处截断，incoming 以 "| 98 | 主胜 |" 续接
  assert.equal(inferBlockSeparator('| 13 | 布鲁克林篮网 | 华盛顿奇才 | 106 ', '| 98 | 主胜 |'), '');
});

test('inferBlockSeparator: incomplete row + incoming starts with pipe (no trailing space)', () => {
  assert.equal(inferBlockSeparator('| 华盛顿奇才 | 106', '| 98 | 主胜 |'), '');
});

test('inferBlockSeparator: row-level split (space join)', () => {
  assert.equal(inferBlockSeparator('| GPT-4o | 88.7% | - |', '- |\n| Claude |'), ' ');
});

test('inferBlockSeparator: consecutive table rows', () => {
  assert.equal(inferBlockSeparator('| a | b |', '| c | d |'), '\n');
});

test('inferBlockSeparator: table header then separator', () => {
  assert.equal(inferBlockSeparator('| h1 | h2 |', '| --- | --- |'), '\n');
});

test('inferBlockSeparator: incoming starts with block element', () => {
  assert.equal(inferBlockSeparator('some text', '## Heading'), '\n\n');
});

test('inferBlockSeparator: plain text continuation', () => {
  assert.equal(inferBlockSeparator('hello', 'world'), '');
});

test('inferBlockSeparator: table row then block element', () => {
  assert.equal(inferBlockSeparator('| a | b |', '## Next'), '\n\n');
});

// ============================================================
// mergeBlockStreamingFences
// ============================================================

test('mergeBlockStreamingFences: removes close+open fence pair', () => {
  const buffer = 'code line\n```';
  const incoming = '```js\nmore code';
  const result = mergeBlockStreamingFences(buffer, incoming);
  assert.equal(result, 'code line\nmore code');
});

test('mergeBlockStreamingFences: strips open fence when buffer unclosed', () => {
  const buffer = '```js\nline1';
  const incoming = '```js\nline2';
  const result = mergeBlockStreamingFences(buffer, incoming);
  assert.equal(result, '```js\nline1\nline2');
});

test('mergeBlockStreamingFences: no fences returns simple concat', () => {
  const result = mergeBlockStreamingFences('hello ', 'world');
  assert.equal(result, 'hello world');
});

test('mergeBlockStreamingFences: removes internal pseudo-fence lines', () => {
  const incoming = 'before\n``` ```js\nafter';
  const result = mergeBlockStreamingFences('', incoming);
  assert.equal(result, 'before\nafter');
});

// ============================================================
// extractAtomicBlocks
// ============================================================

test('extractAtomicBlocks: single table', () => {
  const text = '| h1 | h2 |\n| --- | --- |\n| a | b |';
  const blocks = extractAtomicBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'table');
  assert.equal(blocks[0].start, 0);
  assert.equal(blocks[0].end, text.length);
});

test('extractAtomicBlocks: table after paragraph', () => {
  const text = 'intro\n\n| h |\n| --- |\n| v |';
  const blocks = extractAtomicBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'table');
  assert.ok(blocks[0].start > 0);
});

test('extractAtomicBlocks: diagram fence block', () => {
  const text = '```mermaid\ngraph TD\nA-->B\n```';
  const blocks = extractAtomicBlocks(text);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].kind, 'diagram-fence');
  assert.equal(blocks[0].start, 0);
  assert.equal(blocks[0].end, text.length);
});

test('extractAtomicBlocks: pipe inside code fence not treated as table', () => {
  const text = '```\n| not a table |\n```';
  const blocks = extractAtomicBlocks(text);
  assert.equal(blocks.length, 0);
});

test('extractAtomicBlocks: no atomic blocks', () => {
  const text = 'just plain text\nno tables here';
  const blocks = extractAtomicBlocks(text);
  assert.equal(blocks.length, 0);
});

test('extractAtomicBlocks: two separate tables', () => {
  const text = '| a |\n| --- |\n| 1 |\n\ntext\n\n| b |\n| --- |\n| 2 |';
  const blocks = extractAtomicBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].kind, 'table');
  assert.equal(blocks[1].kind, 'table');
});

// ============================================================
// chunkMarkdownTextAtomicAware
// ============================================================

test('chunkMarkdownTextAtomicAware: short text returns single chunk', () => {
  const text = '| a | b |\n| --- | --- |\n| 1 | 2 |';
  const result = chunkMarkdownTextAtomicAware(text, 1000, (t, max) => {
    const chunks = [];
    for (let i = 0; i < t.length; i += max) chunks.push(t.slice(i, i + max));
    return chunks;
  });
  assert.equal(result.length, 1);
  assert.equal(result[0], text);
});

test('chunkMarkdownTextAtomicAware: table kept intact when split falls inside', () => {
  const prefix = 'A'.repeat(10);
  const table = '| h1 | h2 |\n| --- | --- |\n| a | b |';
  const text = `${prefix}\n${table}`;
  const result = chunkMarkdownTextAtomicAware(text, 15, (t, max) => {
    const chunks = [];
    for (let i = 0; i < t.length; i += max) chunks.push(t.slice(i, i + max));
    return chunks;
  });
  const joined = result.join('');
  assert.equal(joined, text);
  const tableChunk = result.find(c => c.includes('| h1 |'));
  assert.ok(tableChunk);
  assert.ok(tableChunk.includes('| a | b |'));
});
