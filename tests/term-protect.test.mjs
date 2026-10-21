/**
 * term-protect.js 单元测试：术语占位符保护与容错还原。
 * 全部使用内存数据，不依赖网络与术语数据文件。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { protectTerms, restoreTerms } from '../src/lib/term-protect.js';

function entry(en, zh, extra) {
  return Object.assign({
    en,
    zh,
    category: '测试',
    pos: 'noun',
    note: '',
    aliases: [],
    noEnforce: false,
    source: 'builtin',
  }, extra || {});
}

const ENTRIES = [
  entry('thread', '线程'),
  entry('garbage collection', '垃圾回收'),
  entry('garbage', '垃圾'),
  entry('cache', '缓存', { noEnforce: true }),
];

test('protectTerms：往返还原，同一术语复用同一占位符', () => {
  const result = protectTerms('A thread uses the thread pool.', ENTRIES);
  assert.equal(result.masked, 'A ⟦T0⟧ uses the ⟦T0⟧ pool.');
  assert.equal(result.tokens.length, 1);
  assert.equal(result.tokens[0].entry.zh, '线程');
  const restored = restoreTerms(result.masked, result.tokens);
  assert.equal(restored.text, 'A 线程 uses the 线程 pool.');
  assert.equal(restored.unresolvedCount, 0);
});

test('protectTerms：noEnforce 的术语保持原样', () => {
  const result = protectTerms('The cache is cold.', ENTRIES);
  assert.equal(result.masked, 'The cache is cold.');
  assert.equal(result.tokens.length, 0);
});

test('protectTerms：长词优先且互不重叠', () => {
  const result = protectTerms('Garbage collection avoids garbage.', ENTRIES);
  assert.equal(result.tokens.length, 2);
  assert.equal(result.tokens[0].entry.en, 'garbage collection');
  assert.equal(result.tokens[1].entry.en, 'garbage');
  assert.equal(result.masked, '⟦T0⟧ avoids ⟦T1⟧.');
  const restored = restoreTerms(result.masked, result.tokens);
  assert.equal(restored.text, '垃圾回收 avoids 垃圾.');
  assert.equal(restored.unresolvedCount, 0);
});

test('protectTerms：不把已有行内代码占位符当成术语', () => {
  const result = protectTerms('⟦C0⟧ thread', ENTRIES);
  assert.equal(result.masked, '⟦C0⟧ ⟦T0⟧');
  assert.equal(result.tokens.length, 1);
  const restored = restoreTerms(result.masked, result.tokens);
  assert.equal(restored.text, '⟦C0⟧ 线程');
  assert.equal(restored.unresolvedCount, 0);
});

test('protectTerms：空输入、无匹配与空术语表', () => {
  assert.deepEqual(protectTerms('', ENTRIES), { masked: '', tokens: [] });
  assert.deepEqual(protectTerms(null, ENTRIES), { masked: '', tokens: [] });
  assert.deepEqual(protectTerms('plain words only', ENTRIES), { masked: 'plain words only', tokens: [] });
  assert.deepEqual(protectTerms('thread', []), { masked: 'thread', tokens: [] });
});

test('protectTerms：支持复数的术语同样被保护', () => {
  const result = protectTerms('Many threads share one process.', ENTRIES);
  assert.equal(result.tokens.length, 1);
  assert.equal(result.tokens[0].entry.en, 'thread');
  const restored = restoreTerms(result.masked, result.tokens);
  assert.equal(restored.text, 'Many 线程 share one process.');
});

test('restoreTerms：容忍空格、换行与全角/半角括号变体', () => {
  const tokens = [{ marker: '⟦T0⟧', entry: { en: 'thread', zh: '线程' } }];
  const cases = [
    '⟦T0⟧ 完成',
    '⟦ T 0 ⟧ 完成',
    '⟦T\n0⟧ 完成',
    '【T0】 完成',
    '〖T0〗 完成',
    '［T0］ 完成',
    '[T0] 完成',
    '⟦t0⟧ 完成',
  ];
  for (const input of cases) {
    const restored = restoreTerms(input, tokens);
    assert.equal(restored.text, '线程 完成', '输入：' + JSON.stringify(input));
    assert.equal(restored.unresolvedCount, 0, '输入：' + JSON.stringify(input));
  }
});

test('restoreTerms：MT 已译出术语时丢弃重复占位符，避免叠词', () => {
  const threadTokens = [{ marker: '⟦T0⟧', entry: { en: 'thread', zh: '线程' } }];

  // 前叠词：MT 已把 worker thread 译成「工作线程」，末尾 marker 不再重复插入
  assert.equal(restoreTerms('工作线程⟦T0⟧ 完成', threadTokens).text, '工作线程 完成');
  // marker 内含空格时同样去重
  assert.equal(restoreTerms('工作线程⟦ T0 ⟧ 完成', threadTokens).text, '工作线程 完成');
  // 后叠词：marker 之后的文本已以同一译名开头
  assert.equal(restoreTerms('⟦T0⟧线程 完成', threadTokens).text, '线程 完成');
  // 去重不算未还原
  assert.equal(restoreTerms('工作线程⟦T0⟧ 完成', threadTokens).unresolvedCount, 0);

  // 正常还原不受影响
  const kernelTokens = [
    { marker: '⟦T0⟧', entry: { en: 'kernel', zh: '内核' } },
    { marker: '⟦T1⟧', entry: { en: 'process', zh: '进程' } },
  ];
  assert.equal(restoreTerms('⟦T0⟧ manages ⟦T1⟧', kernelTokens).text, '内核 manages 进程');
  assert.equal(restoreTerms('⟦T0⟧ manages ⟦T1⟧', kernelTokens).unresolvedCount, 0);
});

test('restoreTerms：占位符丢失或编号未知时计入 unresolvedCount', () => {
  const tokens = [{ marker: '⟦T0⟧', entry: { en: 'thread', zh: '线程' } }];

  const missing = restoreTerms('译文里没有占位符', tokens);
  assert.equal(missing.text, '译文里没有占位符');
  assert.equal(missing.unresolvedCount, 1);

  const unknown = restoreTerms('⟦T5⟧ 完成', tokens);
  assert.equal(unknown.text, '⟦T5⟧ 完成');
  assert.equal(unknown.unresolvedCount, 2); // 未知标记 1 个 + 丢失的 T0 1 个

  const noTokens = restoreTerms('⟦C0⟧ 线程', []);
  assert.equal(noTokens.text, '⟦C0⟧ 线程');
  assert.equal(noTokens.unresolvedCount, 0);
});

test('restoreTerms：多占位符文本与空输入', () => {
  const result = protectTerms('thread and garbage collection', ENTRIES);
  const restored = restoreTerms(result.masked, result.tokens);
  assert.equal(restored.text, '线程 and 垃圾回收');
  assert.equal(restored.unresolvedCount, 0);
  assert.deepEqual(restoreTerms('', []), { text: '', unresolvedCount: 0 });
});
