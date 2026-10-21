/**
 * 术语数据质量测试。
 *
 * 目标：守住「术语准确」这一核心卖点，防止数据文件出现条数不足、重复、字段缺失、
 * 机翻式错误译名等问题。数据文件由 glossary-core / glossary-web 维护，本测试只读。
 *
 * 运行：node --test tests/glossary-data.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CORE_GLOSSARY } from '../src/data/glossary-core.js';
import { WEB_GLOSSARY } from '../src/data/glossary-web.js';
import { GLOSSARY, GLOSSARY_STATS, lookup } from '../src/lib/glossary.js';

/** glossary.js 支持的全部词性 */
const VALID_POS = new Set(['noun', 'verb', 'adj', 'adv', 'phrase', 'abbr', 'other']);

/**
 * 允许的分类集合：来自两个数据文件顶部的分类建议，并兼容常见写法变体。
 * 新增分类时请同步更新这里（同时更新数据文件注释）。
 */
const ALLOWED_CATEGORIES = new Set([
  // 核心术语表
  '操作系统',
  '体系结构',
  '数据结构与算法',
  '编程语言',
  '数据库',
  '网络',
  '安全',
  '软件工程',
  '版本控制',
  '测试与质量',
  '测试',
  '编译原理',
  '通用IT',
  '通用 IT',
  '计算机基础',
  // Web / 云原生 / AI 术语表
  '前端',
  '浏览器',
  '后端',
  '云原生与DevOps',
  '云原生/DevOps',
  '云原生',
  'DevOps',
  'AI与机器学习',
  'AI/机器学习',
  '人工智能',
  '机器学习',
  '大数据',
  '构建工具',
  '移动开发',
  '图形与游戏',
  'Web',
  '其他',
]);

/** 数据规模下限（与任务书一致） */
const MIN_CORE = 340;
const MIN_WEB = 320;
const MIN_TOTAL = 650;

function isCjk(char) {
  return /[\u3400-\u9fff]/.test(char);
}

function hasCjk(value) {
  return isCjk(String(value || ''));
}

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** 判断 zh 字段是否像一整句英文（简单启发式） */
function hasEnglishSentence(zh) {
  const text = String(zh || '');
  // 连续 4 个及以上英文单词，视为英文长句
  if (/[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*){3,}/.test(text)) return true;
  const englishChars = (text.match(/[A-Za-z]/g) || []).length;
  if (text.length > 12 && englishChars / text.length > 0.5) return true;
  return false;
}

/** 遍历两个数据文件，收集「文件 + 下标 + 原始条目」 */
function* iterateRawEntries() {
  yield* CORE_GLOSSARY.map((entry, index) => ({ source: 'CORE_GLOSSARY', index, entry }));
  yield* WEB_GLOSSARY.map((entry, index) => ({ source: 'WEB_GLOSSARY', index, entry }));
}

function formatLocation(source, index) {
  return source + '[' + index + ']';
}

test('数据规模：CORE_GLOSSARY、WEB_GLOSSARY 与合并去重后的总数达标', (t) => {
  assert.ok(Array.isArray(CORE_GLOSSARY), 'CORE_GLOSSARY 必须是数组');
  assert.ok(Array.isArray(WEB_GLOSSARY), 'WEB_GLOSSARY 必须是数组');
  t.diagnostic('CORE_GLOSSARY = ' + CORE_GLOSSARY.length + ' 条（下限 ' + MIN_CORE + '）');
  t.diagnostic('WEB_GLOSSARY  = ' + WEB_GLOSSARY.length + ' 条（下限 ' + MIN_WEB + '）');
  t.diagnostic('合并去重后   = ' + GLOSSARY.length + ' 条（下限 ' + MIN_TOTAL + '）');

  assert.ok(CORE_GLOSSARY.length >= MIN_CORE, 'CORE_GLOSSARY 只有 ' + CORE_GLOSSARY.length + ' 条，少于下限 ' + MIN_CORE);
  assert.ok(WEB_GLOSSARY.length >= MIN_WEB, 'WEB_GLOSSARY 只有 ' + WEB_GLOSSARY.length + ' 条，少于下限 ' + MIN_WEB);
  assert.ok(GLOSSARY.length >= MIN_TOTAL, '合并去重后只有 ' + GLOSSARY.length + ' 条，少于下限 ' + MIN_TOTAL);
});

/** 统计单个数据文件内部的重复 en（不区分大小写） */
function collectInternalDuplicates(list, sourceName) {
  const seen = new Map();
  const duplicates = [];
  list.forEach((entry, index) => {
    const en = String((entry && entry.en) || '').trim();
    if (!en) return;
    const key = normalizeKey(en);
    if (seen.has(key)) {
      duplicates.push(key + '（' + sourceName + '[' + seen.get(key) + '] 与 ' + sourceName + '[' + index + '] 重复）');
    } else {
      seen.set(key, index);
    }
  });
  return duplicates;
}

test('en 唯一：每个数据文件内部严格唯一', () => {
  const problems = [
    ...collectInternalDuplicates(CORE_GLOSSARY, 'CORE_GLOSSARY'),
    ...collectInternalDuplicates(WEB_GLOSSARY, 'WEB_GLOSSARY'),
  ];
  assert.deepEqual(problems, [], '数据文件内部存在重复术语：\n  - ' + problems.join('\n  - '));
});

test('跨文件重复：仅输出诊断信息，合并时按 CORE 优先去重', (t) => {
  const coreKeys = new Set(CORE_GLOSSARY.map((entry) => normalizeKey((entry && entry.en) || '')).filter(Boolean));
  const webKeys = new Set(WEB_GLOSSARY.map((entry) => normalizeKey((entry && entry.en) || '')).filter(Boolean));
  const crossFileDuplicates = [...webKeys].filter((key) => coreKeys.has(key));
  t.diagnostic(
    '跨文件重复 ' + crossFileDuplicates.length + ' 条（CORE 与 WEB 允许重叠，合并时 CORE 优先）' +
      (crossFileDuplicates.length > 0 ? '：' + crossFileDuplicates.slice(0, 12).join('、') + (crossFileDuplicates.length > 12 ? ' 等' : '') : ''),
  );

  // 核心断言：合并后的 GLOSSARY 不应再有重复 en，且条数等于两个文件去重后的唯一 en 数
  const uniqueKeys = new Set([...coreKeys, ...webKeys]);
  const mergedKeys = GLOSSARY.map((entry) => normalizeKey(entry.en));
  const mergedDuplicates = mergedKeys.filter((key, index) => mergedKeys.indexOf(key) !== index);
  t.diagnostic('CORE + WEB 去重后 = ' + uniqueKeys.size + ' 条，合并后的 GLOSSARY = ' + GLOSSARY.length + ' 条');
  assert.deepEqual(mergedDuplicates, [], '合并后的 GLOSSARY 仍存在重复 en，去重逻辑未生效');
  assert.equal(GLOSSARY.length, uniqueKeys.size, '合并后 GLOSSARY.length 应等于去重后的唯一 en 数量（验证去重逻辑生效）');
});

test('每条术语字段合法：en / zh / category / pos / note / aliases / noEnforce', (t) => {
  const problems = [];
  const categoryCounter = new Map();
  let noteCount = 0;
  let aliasCount = 0;

  for (const { source, index, entry } of iterateRawEntries()) {
    const location = formatLocation(source, index);
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(location + ' 不是对象');
      continue;
    }

    const en = typeof entry.en === 'string' ? entry.en.trim() : '';
    const zh = typeof entry.zh === 'string' ? entry.zh.trim() : '';

    // en
    if (!en) problems.push(location + ' en 为空');
    if (en.length > 120) problems.push(location + ' en 过长（' + en.length + ' 字符）');
    if (hasCjk(en)) problems.push(location + ' en 含中文：' + en);
    if (/\s{2,}/.test(en)) problems.push(location + ' en 含连续空格：' + en);
    if (/^\s|\s$/.test(String(entry.en || ''))) problems.push(location + ' en 首尾有空白：' + JSON.stringify(entry.en));

    // zh
    if (!zh) problems.push(location + ' zh 为空');
    if (zh.length > 200) problems.push(location + ' zh 过长（' + zh.length + ' 字符）：' + zh);
    if (/\n/.test(zh)) problems.push(location + ' zh 含换行符');
    if (hasEnglishSentence(zh)) problems.push(location + ' zh 疑似英文长句：' + zh);
    if (!hasCjk(zh) && zh.length > 20) problems.push(location + ' zh 不含中文且过长：' + zh);

    // category
    const category = String(entry.category || '').trim();
    if (!category) {
      problems.push(location + ' 缺少 category');
    } else {
      if (!ALLOWED_CATEGORIES.has(category)) problems.push(location + ' 分类不在允许集合内：' + category);
      if (category.length > 20) problems.push(location + ' 分类名称过长：' + category);
      categoryCounter.set(category, (categoryCounter.get(category) || 0) + 1);
    }

    // pos
    if (!VALID_POS.has(entry.pos)) problems.push(location + ' pos 非法：' + JSON.stringify(entry.pos) + '（' + en + '）');

    // note
    if (entry.note !== undefined) {
      if (typeof entry.note !== 'string') problems.push(location + ' note 必须是字符串：' + en);
      else {
        const note = entry.note.trim();
        if (note.length > 300) problems.push(location + ' note 过长（' + note.length + ' 字符）：' + en);
        if (/\n/.test(note)) problems.push(location + ' note 含换行符：' + en);
        if (note) noteCount += 1;
      }
    }

    // aliases
    if (entry.aliases !== undefined) {
      if (!Array.isArray(entry.aliases)) {
        problems.push(location + ' aliases 必须是数组：' + en);
      } else {
        const aliasKeys = new Set();
        for (const alias of entry.aliases) {
          if (typeof alias !== 'string') {
            problems.push(location + ' alias 必须是字符串：' + en);
            continue;
          }
          const value = alias.trim();
          if (!value) problems.push(location + ' alias 为空字符串：' + en);
          if (value.length > 60) problems.push(location + ' alias 过长：' + value);
          if (hasCjk(value)) problems.push(location + ' alias 含中文：' + value);
          const key = normalizeKey(value);
          if (aliasKeys.has(key)) problems.push(location + ' alias 重复：' + value);
          aliasKeys.add(key);
          if (key === normalizeKey(en)) problems.push(location + ' alias 与 en 相同：' + value);
          aliasCount += 1;
        }
      }
    }

    // noEnforce
    if (entry.noEnforce !== undefined && typeof entry.noEnforce !== 'boolean') {
      problems.push(location + ' noEnforce 必须是布尔值：' + en);
    }
  }

  t.diagnostic('涉及分类 ' + categoryCounter.size + ' 个，note 覆盖 ' + noteCount + ' 条，aliases 共 ' + aliasCount + ' 个');
  assert.deepEqual(problems.slice(0, 60), [], '字段问题共 ' + problems.length + ' 处：\n  - ' + problems.slice(0, 60).join('\n  - '));
});

test('两个数据文件各自有足够多的分类，避免全部堆在「其他」', (t) => {
  const coreCategories = new Set(CORE_GLOSSARY.map((entry) => String((entry && entry.category) || '').trim()).filter(Boolean));
  const webCategories = new Set(WEB_GLOSSARY.map((entry) => String((entry && entry.category) || '').trim()).filter(Boolean));
  t.diagnostic('CORE_GLOSSARY 分类：' + [...coreCategories].join('、'));
  t.diagnostic('WEB_GLOSSARY 分类：' + [...webCategories].join('、'));
  assert.ok(coreCategories.size >= 5, 'CORE_GLOSSARY 分类过少（' + coreCategories.size + ' 个）');
  assert.ok(webCategories.size >= 5, 'WEB_GLOSSARY 分类过少（' + webCategories.size + ' 个）');
});

test('GLOSSARY_STATS 分类统计非空且加总等于总数', (t) => {
  assert.ok(GLOSSARY_STATS && typeof GLOSSARY_STATS === 'object', 'GLOSSARY_STATS 不存在');
  assert.equal(GLOSSARY_STATS.total, GLOSSARY.length, 'GLOSSARY_STATS.total 与 GLOSSARY 实际条数不一致');
  assert.ok(Array.isArray(GLOSSARY_STATS.categories), 'GLOSSARY_STATS.categories 必须是数组');
  assert.ok(GLOSSARY_STATS.categories.length > 0, 'GLOSSARY_STATS.categories 不能为空');

  let sum = 0;
  for (const item of GLOSSARY_STATS.categories) {
    assert.ok(item && typeof item.category === 'string' && item.category.length > 0, '分类统计项缺少 category');
    assert.ok(Number.isInteger(item.count) && item.count > 0, '分类「' + item.category + '」数量非法：' + item.count);
    sum += item.count;
  }
  t.diagnostic('分类统计共 ' + GLOSSARY_STATS.categories.length + ' 类，合计 ' + sum + ' 条');
  assert.equal(sum, GLOSSARY_STATS.total, '分类统计加总与总数不一致');
});

test('机器翻译常见错误：核心易错术语必须收录且译名精确', () => {
  // [英文, 期望中文译名]：这些是机翻最容易翻错的词，也是本扩展的核心卖点
  const REQUIRED_TERMS = [
    ['thread', '线程'],
    ['process', '进程'],
    ['deadlock', '死锁'],
    ['race condition', '竞态条件'],
    ['memory leak', '内存泄漏'],
    ['hash table', '哈希表'],
  ];
  const failures = [];
  for (const [en, expectedZh] of REQUIRED_TERMS) {
    const entry = lookup(en);
    if (!entry) {
      failures.push('未收录：' + en + '（期望「' + expectedZh + '」）');
    } else if (entry.zh !== expectedZh) {
      failures.push(en + ' 译名错误：实际「' + entry.zh + '」，期望「' + expectedZh + '」');
    }
  }
  assert.deepEqual(failures, [], '核心术语不合格：\n  - ' + failures.join('\n  - '));
});

test('机器翻译常见错误：一批高频术语缺失清单', (t) => {
  // 只断言「已收录」；译名变体较多（如 互斥锁 / 互斥量）不在本测试中强制一字不差
  const COMMON_TERMS = [
    'mutex',
    'semaphore',
    'race condition',
    'garbage collection',
    'virtual memory',
    'page fault',
    'cache',
    'compiler',
    'interpreter',
    'database',
    'transaction',
    'protocol',
    'socket',
    'firewall',
    'encryption',
    'container',
    'microservice',
    'load balancer',
    'frontend',
    'backend',
    'api',
    'http',
    'tcp',
    'dns',
    'repository',
    'merge conflict',
    'pull request',
  ];
  const missing = COMMON_TERMS.filter((term) => !lookup(term));
  t.diagnostic('高频术语缺失 ' + missing.length + ' 个' + (missing.length ? '：' + missing.join('、') : ''));
  assert.deepEqual(missing, [], '以下高频术语未收录，请数据负责人确认是否补充：\n  - ' + missing.join('\n  - '));
});

test('lookup：大小写不敏感、支持常见复数与别名', () => {
  assert.equal(lookup('Thread').zh, '线程', 'lookup 应大小写不敏感');
  assert.equal(lookup('THREAD').zh, '线程', 'lookup 应大小写不敏感');
  assert.equal(lookup('threads').zh, '线程', 'lookup 应识别复数形式');
  assert.equal(lookup('processes').zh, '进程', 'lookup 应识别复数形式');
  assert.equal(lookup('  deadlock  ').zh, '死锁', 'lookup 应忽略首尾空白');
  assert.equal(lookup('definitely-not-a-technical-term-xyz'), null, '未收录的术语应返回 null');
});
