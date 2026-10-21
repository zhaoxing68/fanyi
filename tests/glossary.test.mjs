/**
 * 术语表模块单元测试（Lead 维护）：匹配、边界、复数、别名、自定义术语覆盖。
 * 使用独立 fixture，不依赖术语数据文件是否已填充。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findTerms,
  lookup,
  getTermsForPrompt,
  withCustomTerms,
  searchGlossary,
  getCategories,
  normalizeTerm,
  GLOSSARY,
} from '../src/lib/glossary.js';

function makeEntry(raw) {
  return {
    en: raw.en,
    zh: raw.zh,
    category: raw.category || '测试',
    pos: raw.pos || 'noun',
    note: raw.note || '',
    aliases: raw.aliases || [],
    noEnforce: raw.noEnforce === true,
    source: 'builtin',
  };
}

const ENTRIES = Object.freeze([
  makeEntry({ en: 'thread', zh: '线程', category: '操作系统', pos: 'noun' }),
  makeEntry({ en: 'thread pool', zh: '线程池', category: '操作系统', pos: 'noun' }),
  makeEntry({ en: 'process', zh: '进程', category: '操作系统', pos: 'noun', noEnforce: true }),
  makeEntry({ en: 'operating system', zh: '操作系统', category: '操作系统', pos: 'noun', aliases: ['OS'] }),
  makeEntry({ en: 'race condition', zh: '竞态条件', category: '并发', pos: 'noun' }),
  makeEntry({ en: 'hash table', zh: '哈希表', category: '数据结构与算法', pos: 'noun' }),
  makeEntry({ en: 'code', zh: '代码', category: '通用IT', pos: 'noun' }),
]);

test('normalizeTerm 规范化大小写与空白', () => {
  assert.equal(normalizeTerm('  Thread   Pool '), 'thread pool');
  assert.equal(normalizeTerm(null), '');
});

test('findTerms 基本匹配与长词优先', () => {
  const matches = findTerms('The thread pool reuses threads to run tasks.', ENTRIES);
  assert.deepEqual(matches.map((item) => item.matched.toLowerCase()), ['thread pool', 'threads']);
  assert.equal(matches[1].entry.zh, '线程');
});

test('findTerms 边界：标识符、属性访问、派生词不匹配', () => {
  assert.equal(findTerms('threading myThread process.env pthread', ENTRIES).length, 0);
  assert.equal(findTerms('call processData() now', ENTRIES).length, 0);
});

test('findTerms 标点与换行仍可匹配多词术语', () => {
  const matches = findTerms('A race\ncondition can happen, and a hash-table is different.', ENTRIES);
  assert.equal(matches[0].entry.en, 'race condition');
});

test('findTerms 支持复数与别名', () => {
  const matches = findTerms('Many processes share an OS, and operating systems are complex.', ENTRIES);
  const found = matches.map((item) => item.entry.en);
  assert.ok(found.includes('process'));
  assert.ok(found.includes('operating system'));
});

test('findTerms 全大写缩写不做复数误匹配', () => {
  const entries = [makeEntry({ en: 'HTTP', zh: '超文本传输协议', category: '网络', pos: 'abbr' })];
  assert.equal(findTerms('https://example.com uses HTTP today.', entries).length, 1);
  assert.equal(findTerms('https://example.com only', entries).length, 0);
});

test('findTerms 遵守 maxMatches 限制', () => {
  const text = 'thread thread thread thread thread thread';
  assert.equal(findTerms(text, ENTRIES, { maxMatches: 3 }).length, 3);
});

test('lookup 支持大小写与复数容错', () => {
  assert.equal(lookup('Threads', ENTRIES).zh, '线程');
  assert.equal(lookup('os', ENTRIES).zh, '操作系统');
  assert.equal(lookup('unknown-term', ENTRIES), null);
});

test('getTermsForPrompt 去重且保持出现顺序', () => {
  const entries = getTermsForPrompt('thread race condition thread hash table', ENTRIES);
  assert.deepEqual(entries.map((entry) => entry.en), ['thread', 'race condition', 'hash table']);
});

test('withCustomTerms 新增与覆盖内置术语', () => {
  const merged = withCustomTerms([
    { en: 'thread', zh: '执行线程' },
    { en: 'mutex', zh: '互斥锁', note: '自定义' },
  ]);
  const threadEntry = merged.find((entry) => normalizeTerm(entry.en) === 'thread');
  assert.equal(threadEntry.zh, '执行线程');
  assert.equal(threadEntry.source, 'custom');
  const mutexEntry = lookup('mutex', merged);
  assert.ok(mutexEntry);
  assert.equal(mutexEntry.zh, '互斥锁');
  assert.equal(findTerms('The mutex guards a thread.', merged).length, 2);
});

test('searchGlossary 与 getCategories', () => {
  const results = searchGlossary('线程', ENTRIES);
  assert.ok(results.length >= 1);
  assert.ok(results.every((entry) => entry.zh.includes('线程') || entry.en.includes('线程')));
  const categories = getCategories(ENTRIES);
  assert.ok(categories.some((item) => item.category === '操作系统' && item.count >= 2));
});

test('真实数据基线：核心术语已收录且译名正确', (t) => {
  if (GLOSSARY.length === 0) {
    t.skip('术语数据尚未填充，跳过真实数据基线检查');
    return;
  }
  const cases = [
    ['thread', '线程'],
    ['process', '进程'],
    ['deadlock', '死锁'],
    ['race condition', '竞态条件'],
    ['memory leak', '内存泄漏'],
    ['hash table', '哈希表'],
  ];
  for (const [en, zh] of cases) {
    const entry = lookup(en);
    assert.ok(entry, '术语表缺少：' + en);
    assert.equal(entry.zh, zh, en + ' 的译名应为 ' + zh);
  }
});
