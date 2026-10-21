/**
 * 术语表核心模块（Lead 维护）：合并术语数据、建立索引、文本匹配与查询。
 *
 * 数据来源：
 *   src/data/glossary-core.js  -> CORE_GLOSSARY（计算机基础 / OS / 网络 / 数据库 / 算法 / 安全 等）
 *   src/data/glossary-web.js   -> WEB_GLOSSARY （前端 / 后端 / 云原生 / AI / 构建工具 等）
 * 合并规则：按 en 规范化去重，CORE 优先；自定义术语会覆盖同名内置术语。
 *
 * 术语条目字段（GlossaryEntry）：
 *   en        {string}   英文术语规范形式（专有名词保留大小写，其余小写）
 *   zh        {string}   推荐简体中文译名（术语保护时会被强制还原成该译名）
 *   category  {string}   分类，用于术语表展示与筛选
 *   pos       {string}   noun | verb | adj | adv | phrase | abbr | other
 *   note      {string}   可选：易错点 / 释义补充
 *   aliases   {string[]} 可选：别名 / 缩写 / 常见变体
 *   noEnforce {boolean}  可选：true 表示不做机器翻译的强制术语保护（词性歧义、专有名词等）
 *   source    {string}   内部字段：builtin | custom
 */

import { CORE_GLOSSARY } from '../data/glossary-core.js';
import { WEB_GLOSSARY } from '../data/glossary-web.js';

const VALID_POS = new Set(['noun', 'verb', 'adj', 'adv', 'phrase', 'abbr', 'other']);
const UNCATEGORIZED = '其他';

export function normalizeTerm(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeEntry(raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const en = String(raw.en || '').trim();
  const zh = String(raw.zh || '').trim();
  if (!en || !zh) return null;
  if (en.length > 120 || zh.length > 200) return null;
  const pos = VALID_POS.has(raw.pos) ? raw.pos : 'other';
  return Object.freeze({
    en,
    zh,
    category: String(raw.category || UNCATEGORIZED).trim() || UNCATEGORIZED,
    pos,
    note: String(raw.note || '').trim(),
    aliases: Array.isArray(raw.aliases) ? raw.aliases.map((item) => String(item).trim()).filter(Boolean) : [],
    noEnforce: raw.noEnforce === true,
    source: source || 'builtin',
  });
}

function buildBuiltinGlossary() {
  const seen = new Set();
  const entries = [];
  for (const raw of [...CORE_GLOSSARY, ...WEB_GLOSSARY]) {
    const entry = normalizeEntry(raw, 'builtin');
    if (!entry) continue;
    const key = normalizeTerm(entry.en);
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  return Object.freeze(entries);
}

export const GLOSSARY = buildBuiltinGlossary();

/* ---------------------------- 文本匹配 ---------------------------- */

const LEFT_BOUNDARY = '(?<![A-Za-z0-9_$.])';
const RIGHT_BOUNDARY = '(?![A-Za-z0-9_$])(?!\\.[A-Za-z])';

function escapeRegExp(text) {
  return text.replace(/[.*+?^\u0024{}()|[\]\\]/g, '\\$&');
}

function phraseToPattern(phrase) {
  return escapeRegExp(phrase).replace(/\s+/g, '\\s+');
}

function isPluralizable(word) {
  if (!/[A-Za-z]$/.test(word)) return false;
  if (word.length < 3) return false;
  if (/^[A-Z0-9.\-]+$/.test(word)) return false;
  return true;
}

function pluralFormsOf(phrase) {
  const words = phrase.split(' ');
  const last = words[words.length - 1];
  if (!isPluralizable(last)) return [];
  let plural;
  if (/(?:s|x|z|ch|sh)$/i.test(last)) plural = last + 'es';
  else if (/[^aeiou]y$/i.test(last)) plural = last.slice(0, -1) + 'ies';
  else plural = last + 's';
  const form = [...words.slice(0, -1), plural].join(' ');
  return form === phrase ? [] : [form];
}

function buildMatcher(entries) {
  const alternatives = new Map();
  const addAlternative = (phrase, entry) => {
    const key = normalizeTerm(phrase);
    if (!key || alternatives.has(key)) return;
    alternatives.set(key, entry);
  };
  for (const entry of entries) {
    const forms = [entry.en].concat(Array.isArray(entry.aliases) ? entry.aliases : []);
    for (const form of forms) {
      addAlternative(form, entry);
      if (entry.pos === 'verb' || entry.pos === 'adj' || entry.pos === 'adv' || entry.pos === 'abbr') continue;
      for (const plural of pluralFormsOf(normalizeTerm(form))) addAlternative(plural, entry);
    }
  }
  if (alternatives.size === 0) return { regex: null, alternatives };
  const keys = [...alternatives.keys()].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const pattern = keys.map(phraseToPattern).join('|');
  const regex = new RegExp(LEFT_BOUNDARY + '(?:' + pattern + ')' + RIGHT_BOUNDARY, 'gi');
  return { regex, alternatives };
}

const matcherCache = new WeakMap();

function getMatcher(entries) {
  let matcher = matcherCache.get(entries);
  if (!matcher) {
    matcher = buildMatcher(entries);
    matcherCache.set(entries, matcher);
  }
  return matcher;
}

/**
 * 在文本中查找术语。长词优先、大小写不敏感、支持常见复数形式。
 * @param {string} text
 * @param {ReadonlyArray<object>} [entries]
 * @param {{ maxMatches?: number }} [options]
 * @returns {Array<{ entry: object, matched: string, start: number, end: number }>}
 */
export function findTerms(text, entries = GLOSSARY, options = {}) {
  const source = typeof text === 'string' ? text : '';
  const maxMatches = Number.isFinite(options.maxMatches) ? Math.max(1, options.maxMatches) : 200;
  if (!source || !entries || entries.length === 0) return [];
  const matcher = getMatcher(entries);
  if (!matcher.regex) return [];
  matcher.regex.lastIndex = 0;
  const matches = [];
  let match;
  while ((match = matcher.regex.exec(source)) !== null) {
    const matched = match[0];
    if (!matched) {
      matcher.regex.lastIndex += 1;
      continue;
    }
    const atStart = match.index;
    const atEnd = atStart + matched.length;
    const entry = matcher.alternatives.get(normalizeTerm(matched));
    if (entry) {
      matches.push({ entry, matched, start: atStart, end: atEnd });
      if (matches.length >= maxMatches) break;
    }
  }
  return matches;
}

function buildLookupIndex(entries) {
  const index = new Map();
  for (const entry of entries) {
    for (const form of [entry.en].concat(Array.isArray(entry.aliases) ? entry.aliases : [])) {
      const key = normalizeTerm(form);
      if (key && !index.has(key)) index.set(key, entry);
    }
  }
  return index;
}

const GLOSSARY_INDEX = buildLookupIndex(GLOSSARY);
const customIndexCache = new WeakMap();

function getLookupIndex(entries) {
  if (entries === GLOSSARY) return GLOSSARY_INDEX;
  let index = customIndexCache.get(entries);
  if (!index) {
    index = buildLookupIndex(entries);
    customIndexCache.set(entries, index);
  }
  return index;
}

function singularCandidates(normalized) {
  const out = [];
  if (normalized.endsWith('ies')) out.push(normalized.slice(0, -3) + 'y');
  if (normalized.endsWith('es')) out.push(normalized.slice(0, -2));
  if (normalized.endsWith('s') && !normalized.endsWith('ss')) out.push(normalized.slice(0, -1));
  return out;
}

/** 精确查询一个单词/短语（自动处理复数） */
export function lookup(term, entries = GLOSSARY) {
  const key = normalizeTerm(term);
  if (!key) return null;
  const index = getLookupIndex(entries);
  if (index.has(key)) return index.get(key);
  for (const candidate of singularCandidates(key)) {
    if (index.has(candidate)) return index.get(candidate);
  }
  return null;
}

/**
 * 从文本中挑出用于提示词的术语（按出现顺序去重）。
 * @param {string} text
 * @param {ReadonlyArray<object>} [entries]
 * @param {number} [limit]
 * @returns {Array<object>} 术语条目数组
 */
export function getTermsForPrompt(text, entries = GLOSSARY, limit = 80) {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, limit) : 80;
  const matches = findTerms(text, entries, { maxMatches: Math.max(safeLimit * 4, 40) });
  const seen = new Set();
  const result = [];
  for (const item of matches) {
    if (seen.has(item.entry.en)) continue;
    seen.add(item.entry.en);
    result.push(item.entry);
    if (result.length >= safeLimit) break;
  }
  return result;
}

/** 合并自定义术语：同 en 覆盖内置译法，返回新数组（用于 WeakMap 缓存匹配器） */
export function withCustomTerms(customTerms) {
  const list = Array.isArray(customTerms) ? customTerms : [];
  const customEntries = [];
  for (const raw of list) {
    const entry = normalizeEntry(Object.assign({ category: '自定义' }, raw), 'custom');
    if (entry) customEntries.push(entry);
  }
  if (customEntries.length === 0) return GLOSSARY;
  const customMap = new Map(customEntries.map((entry) => [normalizeTerm(entry.en), entry]));
  const merged = [];
  const seen = new Set();
  for (const entry of GLOSSARY) {
    const key = normalizeTerm(entry.en);
    seen.add(key);
    const override = customMap.get(key);
    merged.push(override || entry);
  }
  for (const entry of customEntries) {
    const key = normalizeTerm(entry.en);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return Object.freeze(merged);
}

/** 术语表页面搜索 */
export function searchGlossary(query, entries = GLOSSARY, limit = 200) {
  const keyword = normalizeTerm(query);
  if (!keyword) return entries.slice(0, limit);
  const result = [];
  for (const entry of entries) {
    const haystack = [entry.en, entry.zh, entry.note, ...entry.aliases].join(' ').toLowerCase();
    if (haystack.includes(keyword)) {
      result.push(entry);
      if (result.length >= limit) break;
    }
  }
  return result;
}

export function getCategories(entries = GLOSSARY) {
  const order = [];
  const counts = new Map();
  for (const entry of entries) {
    if (!counts.has(entry.category)) {
      counts.set(entry.category, 0);
      order.push(entry.category);
    }
    counts.set(entry.category, counts.get(entry.category) + 1);
  }
  return order.map((category) => ({ category, count: counts.get(category) }));
}

export const GLOSSARY_STATS = Object.freeze({
  total: GLOSSARY.length,
  categories: Object.freeze(getCategories(GLOSSARY)),
});
