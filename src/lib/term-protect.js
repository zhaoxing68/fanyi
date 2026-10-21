/**
 * 术语占位符保护（engine 维护）。
 *
 * 背景：必应 / Azure / MyMemory / Google 等机器翻译服务经常会把专业术语翻错，
 * 因此翻译前先用 ⟦T0⟧、⟦T1⟧ 这类罕见标记替换命中的术语，翻译后再按术语表的
 * 中文译名还原，从而保证术语译法统一、准确。
 *
 * 与 content script 的约定：content script 会先用 ⟦C0⟧、⟦C1⟧ 标记行内代码，
 * 本模块不会把 ⟦C..⟧ 当成术语标记，还原时也不会破坏它们。
 */

import { findTerms } from './glossary.js';

/** 单条文本最多保护的术语数量（占位符过多会明显降低译文可读性） */
const MAX_PROTECT_MATCHES = 80;

/** 已存在的占位符（行内代码 ⟦C0⟧ 等），匹配术语时跳过这些位置 */
const EXISTING_MARKER_PATTERN = /⟦[A-Za-z][0-9]+⟧/g;

/**
 * 容错匹配术语占位符：允许标记内部出现空格 / 换行，允许全角与半角括号混用，
 * 允许翻译服务把大写 T 改成小写 t。
 */
const TERM_MARKER_PATTERN = /[⟦【〖〔［\[]\s*[Tt]\s*([0-9]+)\s*[⟧】〗〕］\]]/g;

/** 占位符两侧的空白（含全角空格），用于还原时的叠词去重判断 */
const TRAILING_SPACES = /[ \t\u00a0\u3000]+$/;
const LEADING_SPACES = /^[ \t\u00a0\u3000]+/;

function toText(value) {
  if (typeof value === 'string') return value;
  return value == null ? '' : String(value);
}

/** 找出文本中已经存在的占位符区间（例如 content script 写入的 ⟦C0⟧） */
function collectExistingMarkerRanges(text) {
  const ranges = [];
  const pattern = new RegExp(EXISTING_MARKER_PATTERN.source, 'g');
  let match = pattern.exec(text);
  while (match !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
    match = pattern.exec(text);
  }
  return ranges;
}

function isInsideRanges(index, ranges) {
  for (const range of ranges) {
    if (index >= range.start && index < range.end) return true;
  }
  return false;
}

/**
 * 把文本中命中的术语替换为占位符。
 *
 * @param {string} text 原文
 * @param {ReadonlyArray<object>} entries 术语条目数组（结构见 glossary.js）
 * @returns {{ masked: string, tokens: Array<{ marker: string, entry: object }> }}
 */
export function protectTerms(text, entries) {
  const source = toText(text);
  const glossary = Array.isArray(entries) ? entries : [];
  if (!source || glossary.length === 0) return { masked: source, tokens: [] };

  const matches = findTerms(source, glossary, { maxMatches: MAX_PROTECT_MATCHES });
  if (matches.length === 0) return { masked: source, tokens: [] };

  const existingRanges = collectExistingMarkerRanges(source);
  const tokens = [];
  const tokenByEntry = new Map();
  const parts = [];
  let cursor = 0;

  for (const match of matches) {
    // 明确标记为「不做强制保护」的术语（歧义词、专有名词等）保持原样
    if (!match.entry || match.entry.noEnforce === true) continue;
    // 理论上 findTerms 返回的匹配互不重叠，这里仍做一次防御
    if (match.start < cursor) continue;
    if (isInsideRanges(match.start, existingRanges)) continue;

    const key = match.entry.en || match.matched;
    let token = tokenByEntry.get(key);
    if (!token) {
      token = { marker: '⟦T' + tokens.length + '⟧', entry: match.entry };
      tokenByEntry.set(key, token);
      tokens.push(token);
    }
    parts.push(source.slice(cursor, match.start), token.marker);
    cursor = match.end;
  }

  if (tokens.length === 0) return { masked: source, tokens: [] };
  parts.push(source.slice(cursor));
  return { masked: parts.join(''), tokens };
}

/**
 * 把占位符还原为术语表译名。
 *
 * 容错策略：允许标记内部出现空格 / 换行、全角或半角括号变体；若某个占位符
 * 在译文中彻底消失（被翻译服务吞掉）或出现未知编号，则计入 unresolvedCount，
 * 调度层据此重试或降级为普通翻译。
 *
 * @param {string} masked 机器翻译返回的文本
 * @param {Array<{ marker: string, entry: object }>} tokens protectTerms 返回的 token 列表
 * @returns {{ text: string, unresolvedCount: number }}
 */
export function restoreTerms(masked, tokens) {
  const text = toText(masked);
  const list = Array.isArray(tokens) ? tokens : [];

  const translationByIndex = new Map();
  for (const token of list) {
    if (!token || typeof token.marker !== 'string') continue;
    const markerMatch = /[Tt]\s*([0-9]+)/.exec(token.marker);
    if (!markerMatch) continue;
    const index = Number(markerMatch[1]);
    if (!Number.isInteger(index) || translationByIndex.has(index)) continue;
    const zh = token.entry && typeof token.entry.zh === 'string' ? token.entry.zh.trim() : '';
    if (zh) translationByIndex.set(index, zh);
  }

  if (!text) return { text, unresolvedCount: 0 };
  if (translationByIndex.size === 0) return { text, unresolvedCount: 0 };

  const resolved = new Set();
  let unknownMarkers = 0;
  const pattern = new RegExp(TERM_MARKER_PATTERN.source, 'g');
  let output = '';
  let cursor = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    const marker = match[0];
    const index = Number(match[1]);
    output += text.slice(cursor, match.index);
    cursor = match.index + marker.length;
    const zh = translationByIndex.get(index);
    if (!zh) {
      unknownMarkers += 1;
      output += marker;
    } else {
      resolved.add(index);
      // 叠词去重：机器翻译可能已经把术语译成中文（如「工作线程⟦T1⟧」），
      // 若 marker 前后已经出现同一译名，就丢弃该 marker，避免「工作线程线程」。
      const before = output.replace(TRAILING_SPACES, '');
      const after = text.slice(cursor).replace(LEADING_SPACES, '');
      const duplicated = before.endsWith(zh) || after.startsWith(zh);
      if (!duplicated) output += zh;
    }
    match = pattern.exec(text);
  }
  output += text.slice(cursor);

  let missingTokens = 0;
  for (const index of translationByIndex.keys()) {
    if (!resolved.has(index)) missingTokens += 1;
  }

  return { text: output, unresolvedCount: unknownMarkers + missingTokens };
}
