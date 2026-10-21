/**
 * 翻译调度层（engine 维护）。
 *
 * 职责：
 *  - 按服务商类型（llm / mt / local）选择不同翻译策略；
 *  - 大模型：把术语表注入中文提示词，要求返回 JSON 数组，带解析容错与逐条降级；
 *  - 机器翻译：翻译前用 ⟦T0⟧ 占位符保护术语，翻译后还原成术语表译名；
 *  - 离线词典：本地替换命中的术语；
 *  - 统一返回 { translations, provider, warnings } / { translation, provider, warnings }。
 *
 * 约束：不 import chrome API、不做缓存（Service Worker 负责）、不改全局状态。
 */

import {
  PROVIDER_META,
  TARGET_LANGS,
  GLOSSARY_PROMPT_LIMIT,
  MAX_BATCH_TEXTS,
  MAX_BATCH_CHARS,
} from './constants.js';
import { GLOSSARY, getTermsForPrompt } from './glossary.js';
import {
  TranslatorError,
  translateWithProvider,
  testProviderConnection,
  providerDisplayName,
} from './providers.js';
import { protectTerms, restoreTerms } from './term-protect.js';

/** 术语占位符保护只在简体中文目标下启用（繁体中文不混入简体术语译名） */
const PROTECTION_TARGET_LANGS = new Set(['zh-CN']);

const TARGET_LANG_NAMES = {
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文',
  en: '英语（English）',
  ja: '日语（日本語）',
  ko: '韩语（한국어）',
};

function toText(value) {
  if (typeof value === 'string') return value;
  return value == null ? '' : String(value);
}

function targetLangName(code) {
  return TARGET_LANG_NAMES[code] || String(code || '简体中文');
}

/** 合并去重 warnings（保持出现顺序） */
function mergeWarnings() {
  const seen = new Set();
  const result = [];
  for (let listIndex = 0; listIndex < arguments.length; listIndex += 1) {
    const list = arguments[listIndex];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const text = toText(item).trim();
      if (!text || seen.has(text)) continue;
      seen.add(text);
      result.push(text);
    }
  }
  return result;
}

function normalizeWarnings(list) {
  return Array.isArray(list) ? list.filter((item) => toText(item).trim()) : [];
}

/* ------------------------------ 上下文 ------------------------------ */

function resolveContext(ctx) {
  const settings = ctx && ctx.settings;
  if (!settings || typeof settings !== 'object') {
    throw new TranslatorError('INVALID_INPUT', '翻译上下文缺少设置信息，请刷新页面后重试', '');
  }
  const providerId = String(settings.provider || 'bing-free');
  const meta = PROVIDER_META[providerId];
  if (!meta) {
    throw new TranslatorError('UNKNOWN_PROVIDER', '未知的翻译服务商：' + providerId + '，请到设置中选择', providerId);
  }
  const rawConfig = settings.providers && settings.providers[providerId] && typeof settings.providers[providerId] === 'object'
    ? settings.providers[providerId]
    : {};
  const config = Object.assign({}, rawConfig, { __freeFallback: settings.freeFallback !== false });
  const glossary = ctx && Array.isArray(ctx.glossary) ? ctx.glossary : GLOSSARY;
  return {
    settings,
    providerId,
    meta,
    targetLang: String(settings.targetLang || 'zh-CN'),
    config,
    glossary,
    fetchImpl: ctx ? ctx.fetchImpl : undefined,
    signal: ctx ? ctx.signal : undefined,
  };
}

async function callProvider(context, texts, messages, extraConfig) {
  const config = extraConfig ? Object.assign({}, context.config, extraConfig) : context.config;
  try {
    return await translateWithProvider({
      providerId: context.providerId,
      config,
      targetLang: context.targetLang,
      texts,
      fetchImpl: context.fetchImpl,
      signal: context.signal,
      messages,
    });
  } catch (error) {
    if (error instanceof TranslatorError) throw error;
    throw new TranslatorError('UPSTREAM_ERROR', '翻译失败：' + (error && error.message ? error.message : '未知错误'), context.providerId);
  }
}

function assertTranslationLength(result, expectedCount, providerId) {
  if (!result || !Array.isArray(result.translations) || result.translations.length !== expectedCount) {
    throw new TranslatorError('BAD_RESPONSE', providerDisplayName(providerId) + ' 返回的译文数量与输入不一致，请稍后重试', providerId);
  }
  for (const item of result.translations) {
    if (typeof item !== 'string') {
      throw new TranslatorError('BAD_RESPONSE', providerDisplayName(providerId) + ' 返回的译文格式不正确，请稍后重试', providerId);
    }
  }
}

/* --------------------------- 大模型提示词 --------------------------- */

function buildTermTable(terms) {
  if (!Array.isArray(terms) || terms.length === 0) return '';
  return terms.map((entry) => '- ' + entry.en + ' => ' + entry.zh).join('\n');
}

function buildBatchSystemPrompt(targetLang, terms, batchSize) {
  const langName = targetLangName(targetLang);
  const lines = [
    '你是一名资深计算机技术译者，精通操作系统、编程语言、数据库、网络、云计算与人工智能等领域，负责把技术文档准确翻译成' + langName + '。',
    '',
    '翻译要求：',
    '1. 译文必须使用中国大陆 IT 行业通行的规范术语；下方术语表中的条目必须严格采用给定译法，不得改用其他译名。',
    '2. 原文中的代码、命令行、变量名、函数名、文件路径、URL、版本号、Markdown 标记以及占位符（如 ⟦T0⟧、⟦C0⟧）必须原样保留，不得翻译、删除或改写。',
    '3. 不添加任何解释、译者注或额外说明；不省略、不合并不拆分原文信息，逐句对应翻译。',
    '4. 只输出一个 JSON 对象，不要输出 Markdown 代码围栏、前后缀或任何多余文字。',
  ];
  const table = buildTermTable(terms);
  if (table) lines.push('', '术语表（英文 => 中文，必须严格遵守）：', table);
  lines.push('', '输出格式：{"translations":[译文1,译文2,...]}，数组长度必须等于 ' + batchSize + '，顺序与输入一一对应。');
  return lines.join('\n');
}

function buildSingleSystemPrompt(targetLang, terms) {
  const langName = targetLangName(targetLang);
  const lines = [
    '你是一名资深计算机技术译者，负责把技术文档准确翻译成' + langName + '。',
    '要求：使用中国大陆 IT 行业规范术语；代码、命令行、URL、版本号、Markdown 标记与占位符（如 ⟦T0⟧、⟦C0⟧）必须原样保留；不添加任何解释或译者注。',
    '只输出这一条文本的译文纯文本，不要输出 JSON、引号、代码围栏或任何多余内容。',
  ];
  const table = buildTermTable(terms);
  if (table) lines.push('', '术语表（英文 => 中文，必须严格遵守）：', table);
  return lines.join('\n');
}

function buildBatchMessages(targetLang, terms, texts) {
  return [
    { role: 'system', content: buildBatchSystemPrompt(targetLang, terms, texts.length) },
    { role: 'user', content: JSON.stringify({ texts }) },
  ];
}

function buildSingleMessages(targetLang, terms, text) {
  return [
    { role: 'system', content: buildSingleSystemPrompt(targetLang, terms) },
    { role: 'user', content: text },
  ];
}

/* --------------------------- 大模型输出解析 --------------------------- */

/** 从文本中截取第一个 { 到最后一个 }（或 [ 到 ]）并尝试解析 JSON */
function extractJsonValue(text) {
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(text.slice(firstBrace, lastBrace + 1));
    } catch (error) {
      // 继续尝试数组形式
    }
  }
  const firstBracket = text.indexOf('[');
  const lastBracket = text.lastIndexOf(']');
  if (firstBracket >= 0 && lastBracket > firstBracket) {
    try {
      return JSON.parse(text.slice(firstBracket, lastBracket + 1));
    } catch (error) {
      // 解析失败，交给调用方降级
    }
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

/**
 * 解析大模型返回的批次译文；返回 null 表示格式不合法。
 * 兼容：JSON 代码围栏、前后缀说明文字、{translations:[...]} / [...{text}] / [{translation}] 等形态。
 */
function parseTranslationArray(raw) {
  const text = toText(raw).trim();
  if (!text) return null;
  const value = extractJsonValue(text);
  if (!value) return null;
  let list = null;
  if (Array.isArray(value)) list = value;
  else if (value && Array.isArray(value.translations)) list = value.translations;
  else if (value && Array.isArray(value.data)) list = value.data;
  if (!list) return null;
  const result = [];
  for (const item of list) {
    if (typeof item === 'string') {
      result.push(item);
      continue;
    }
    if (item && typeof item.text === 'string') {
      result.push(item.text);
      continue;
    }
    if (item && typeof item.translation === 'string') {
      result.push(item.translation);
      continue;
    }
    return null;
  }
  return result;
}

/** 清理逐条翻译的纯文本输出（去掉代码围栏 / 意外 JSON / 外层引号） */
function cleanSingleTranslation(content) {
  let text = toText(content).trim();
  if (!text) return '';
  if (text.indexOf('{') !== -1 || text.indexOf('[') !== -1) {
    const parsed = parseTranslationArray(text);
    if (parsed && parsed.length > 0 && parsed[0].trim()) return parsed[0].trim();
  }
  text = text.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  return text;
}

/** 取大模型原始输出（统一从 raw 或 translations[0] 获取） */
function extractRawContent(result) {
  if (!result) return '';
  if (typeof result.raw === 'string') return result.raw;
  if (Array.isArray(result.translations) && typeof result.translations[0] === 'string') return result.translations[0];
  return '';
}

/* ------------------------------ 策略实现 ------------------------------ */

async function translateWithLLM(context, texts) {
  const { providerId, settings, glossary, targetLang } = context;
  const warnings = [];
  const limit = Number.isFinite(settings.glossaryLimit) ? settings.glossaryLimit : GLOSSARY_PROMPT_LIMIT;
  const terms = getTermsForPrompt(texts.join('\n'), glossary, limit);
  const messages = buildBatchMessages(targetLang, terms, texts);

  const batchResult = await callProvider(context, texts, messages);
  warnings.push(...normalizeWarnings(batchResult.warnings));

  const parsed = parseTranslationArray(extractRawContent(batchResult));
  if (parsed && parsed.length === texts.length) {
    return { translations: parsed, warnings: mergeWarnings(warnings) };
  }

  // 批量结果格式异常或数量不符：降级为逐条请求，每条只输出译文纯文本
  warnings.push('批量翻译结果格式异常，已自动改为逐条翻译');
  const translations = [];
  for (const text of texts) {
    const itemTerms = getTermsForPrompt(text, glossary, Math.min(limit, 20));
    const singleResult = await callProvider(context, [text], buildSingleMessages(targetLang, itemTerms, text));
    warnings.push(...normalizeWarnings(singleResult.warnings));
    const content = cleanSingleTranslation(extractRawContent(singleResult));
    if (!content) {
      throw new TranslatorError('UPSTREAM_ERROR', providerDisplayName(providerId) + ' 未返回有效译文，请稍后重试或更换服务商', providerId);
    }
    translations.push(content);
  }
  return { translations, warnings: mergeWarnings(warnings) };
}

function restoreAll(translations, protectedItems) {
  let unresolved = 0;
  const texts = translations.map((translation, index) => {
    const item = protectedItems[index] || { tokens: [] };
    const restored = restoreTerms(translation, item.tokens);
    unresolved += restored.unresolvedCount;
    return restored.text;
  });
  return { texts, unresolved };
}

async function translateWithMT(context, texts) {
  const { providerId, settings, glossary, targetLang } = context;
  const warnings = [];
  const protectionEnabled = settings.enforceTerms !== false && PROTECTION_TARGET_LANGS.has(targetLang);

  // 目标语言不是简体中文（或用户关闭术语保护）：直接翻译原文
  if (!protectionEnabled) {
    const result = await callProvider(context, texts);
    assertTranslationLength(result, texts.length, providerId);
    return { translations: result.translations, warnings: normalizeWarnings(result.warnings) };
  }

  const protectedItems = texts.map((text) => protectTerms(text, glossary));
  const maskedTexts = protectedItems.map((item) => item.masked);
  const hasTokens = protectedItems.some((item) => item.tokens.length > 0);

  const first = await callProvider(context, maskedTexts, undefined, { __originalTexts: texts });
  assertTranslationLength(first, maskedTexts.length, providerId);
  warnings.push(...normalizeWarnings(first.warnings));

  // 服务商内部已回退为「翻译未保护原文」：直接采用，跳过占位符还原
  if (first.unprotected === true) return { translations: first.translations, warnings: mergeWarnings(warnings) };
  if (!hasTokens) return { translations: first.translations, warnings: mergeWarnings(warnings) };

  const restored = restoreAll(first.translations, protectedItems);
  if (restored.unresolved === 0) return { translations: restored.texts, warnings: mergeWarnings(warnings) };

  // 占位符丢失：重试一次
  const retry = await callProvider(context, maskedTexts, undefined, { __originalTexts: texts });
  assertTranslationLength(retry, maskedTexts.length, providerId);
  warnings.push(...normalizeWarnings(retry.warnings));
  if (retry.unprotected === true) return { translations: retry.translations, warnings: mergeWarnings(warnings) };

  const restoredRetry = restoreAll(retry.translations, protectedItems);
  if (restoredRetry.unresolved === 0) return { translations: restoredRetry.texts, warnings: mergeWarnings(warnings) };

  // 仍然失败：改用未保护原文重新翻译
  warnings.push('部分术语保护失效，已按普通翻译处理');
  const plain = await callProvider(context, texts);
  assertTranslationLength(plain, texts.length, providerId);
  warnings.push(...normalizeWarnings(plain.warnings));
  return { translations: plain.translations, warnings: mergeWarnings(warnings) };
}

async function translateGroup(context, texts) {
  const { meta } = context;
  if (meta.kind === 'llm') return translateWithLLM(context, texts);
  if (meta.kind === 'local') {
    const result = await callProvider(context, texts, undefined, { __glossary: context.glossary });
    assertTranslationLength(result, texts.length, context.providerId);
    return {
      translations: result.translations,
      warnings: mergeWarnings(result.warnings, ['离线词典模式仅翻译命中的术语，未命中部分保留原文']),
    };
  }
  return translateWithMT(context, texts);
}

/* ------------------------------ 批量分片 ------------------------------ */

/**
 * 清理中文之间的多余空格。
 * 机器翻译会把占位符当成独立 token，还原后常留下「调度器 抢占正在运行的 线程」这种空隙；
 * 这里只折叠「汉字 / 中文标点」之间的空格，不会动代码、英文与占位符本身。
 */
function tidyChineseSpacing(text) {
  const source = toText(text);
  if (!source) return source;
  // 用 lookahead 只消费左侧字符，避免 global 模式相邻匹配互相吞掉（「流 和 反」只折叠一次）
  // 空白字符类同时覆盖半角空格、制表符、不换行空格与全角空格 \u3000；换行符不在此列，保留段落结构
  return source
    .replace(/([\u4e00-\u9fff])[ \t\u00a0\u3000]+(?=[\u4e00-\u9fff])/g, '$1')
    .replace(/([\u4e00-\u9fff])[ \t\u00a0\u3000]+(?=[，。！？；：、）】》」』])/g, '$1')
    .replace(/([，。！？；：、（【《「『])[ \t\u00a0\u3000]+(?=[\u4e00-\u9fff])/g, '$1');
}

function tidyTranslations(translations, targetLang) {
  if (targetLang !== 'zh-CN') return translations;
  return translations.map((text) => tidyChineseSpacing(text));
}

/** 按 MAX_BATCH_TEXTS / MAX_BATCH_CHARS 把一批文本拆成若干组，避免单次请求过大 */
function splitIntoGroups(texts) {
  const groups = [];
  let current = [];
  let currentChars = 0;
  for (const text of texts) {
    if (current.length > 0 && (current.length >= MAX_BATCH_TEXTS || currentChars + text.length > MAX_BATCH_CHARS)) {
      groups.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(text);
    currentChars += text.length;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/* ------------------------------ 对外接口 ------------------------------ */

/**
 * 批量翻译。
 *
 * @param {string[]} texts 待翻译文本
 * @param {{ settings: object, glossary: ReadonlyArray<object>, fetchImpl?: Function, signal?: AbortSignal }} ctx
 * @returns {Promise<{ translations: string[], provider: string, warnings: string[] }>}
 */
export async function translateBatch(texts, ctx) {
  const context = resolveContext(ctx);
  const list = Array.isArray(texts) ? texts.map(toText) : [];
  if (list.length === 0) return { translations: [], provider: context.providerId, warnings: [] };

  // 空文本 / 纯空白不发给服务商（保留原文，避免破坏排版）
  const translations = list.slice();
  const pendingTexts = [];
  const pendingIndexes = [];
  list.forEach((text, index) => {
    if (text.trim()) {
      pendingTexts.push(text);
      pendingIndexes.push(index);
    }
  });
  if (pendingTexts.length === 0) return { translations, provider: context.providerId, warnings: [] };

  const warnings = [];
  const groups = splitIntoGroups(pendingTexts);
  let cursor = 0;
  for (const group of groups) {
    const result = await translateGroup(context, group);
    if (!result || !Array.isArray(result.translations) || result.translations.length !== group.length) {
      throw new TranslatorError('BAD_RESPONSE', providerDisplayName(context.providerId) + ' 返回的译文数量与输入不一致，请稍后重试', context.providerId);
    }
    const groupTranslations = tidyTranslations(result.translations, context.targetLang);
    for (let index = 0; index < group.length; index += 1) {
      translations[pendingIndexes[cursor + index]] = groupTranslations[index];
    }
    cursor += group.length;
    warnings.push(...normalizeWarnings(result.warnings));
  }

  return { translations, provider: context.providerId, warnings: mergeWarnings(warnings) };
}

/**
 * 单条文本翻译。
 *
 * @param {string} text
 * @param {{ settings: object, glossary: ReadonlyArray<object>, fetchImpl?: Function, signal?: AbortSignal }} ctx
 * @returns {Promise<{ translation: string, provider: string, warnings: string[] }>}
 */
export async function translateText(text, ctx) {
  const context = resolveContext(ctx);
  const source = toText(text);
  if (!source.trim()) return { translation: source, provider: context.providerId, warnings: [] };
  const result = await translateBatch([source], ctx);
  return {
    translation: typeof result.translations[0] === 'string' ? result.translations[0] : '',
    provider: result.provider,
    warnings: result.warnings,
  };
}

/**
 * 测试服务商连通性（用 "thread" 做一次真实翻译），失败返回 { ok:false, message } 不抛错。
 *
 * @param {string} providerId
 * @param {object} settings
 * @param {{ fetchImpl?: Function, signal?: AbortSignal }} [options] 仅测试注入用
 * @returns {Promise<{ ok: boolean, message: string, sample?: string }>}
 */
export async function testProvider(providerId, settings, options) {
  const meta = PROVIDER_META[providerId];
  if (!meta) return { ok: false, message: '未知的翻译服务商：' + (providerId || '（空）') };
  const providerConfig = settings && settings.providers && settings.providers[providerId] && typeof settings.providers[providerId] === 'object'
    ? settings.providers[providerId]
    : {};
  const targetLang = settings && settings.targetLang ? settings.targetLang : 'zh-CN';
  const extra = options && typeof options === 'object' ? options : {};
  try {
    return await testProviderConnection({
      providerId,
      config: providerConfig,
      targetLang,
      fetchImpl: extra.fetchImpl,
      signal: extra.signal,
    });
  } catch (error) {
    return {
      ok: false,
      message: error instanceof TranslatorError
        ? error.message
        : '连接测试失败：' + (error && error.message ? error.message : '未知错误'),
    };
  }
}
