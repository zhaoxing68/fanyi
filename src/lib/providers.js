/**
 * 各翻译服务商的底层协议实现（engine 维护）。
 *
 * 设计约定：
 *  - 只做协议与错误归一，不调用 chrome API、不改全局状态（必应 token 缓存除外）；
 *  - 所有网络请求都通过调用时注入的 fetchImpl 发起（默认 globalThis.fetch），便于 Node 单测；
 *  - 所有错误统一为 TranslatorError：{ code, message, provider }，message 为中文且绝不包含密钥；
 *  - 机器翻译（kind: mt）的术语保护由调度层 translator.js 负责，本模块只处理协议。
 */

import { PROVIDER_META } from './constants.js';
import { GLOSSARY, findTerms } from './glossary.js';

/* ------------------------------ 常量 ------------------------------ */

const DEFAULT_TIMEOUT_MS = 20000;
const LLM_TIMEOUT_MS = 60000;

const BING_TOKEN_TTL = 50 * 60 * 1000;
const BING_CHUNK_LIMIT = 1200;
const BING_ORIGIN_CANDIDATES = ['https://cn.bing.com/translator', 'https://www.bing.com/translator'];

/**
 * 必应接口会校验 UA：Node / 非浏览器环境不带浏览器 UA 时 ttranslatev3 直接返回 401。
 * 浏览器扩展里设置 User-Agent 属于 forbidden header，会被浏览器静默忽略并使用真实 Edge UA；
 * 这里显式携带是为了让 Node 单测 / 真实网络联调也能正常工作。
 */
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0';

const MYMEMORY_ENDPOINT = 'https://api.mymemory.translated.net/get';
const MYMEMORY_CHUNK_BYTES = 450;

const GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const GOOGLE_CHUNK_LIMIT = 1400;
const GOOGLE_NETWORK_HINT = '当前网络无法访问 Google，请改用必应或 DeepSeek';

const AZURE_DEFAULT_ENDPOINT = 'https://api.cognitive.microsofttranslator.com';
const AZURE_MAX_ITEMS = 100;
const AZURE_MAX_CHARS = 44000; // 官方上限 45000 字符，留出安全余量
const AZURE_TEXT_LIMIT = 20000; // 单条文本先切分，避免单个请求超限

/**
 * 语言代码映射。中文变体按各服务商支持情况映射：
 *  - 必应 / Azure 使用脚本代码 zh-Hans / zh-Hant；
 *  - MyMemory / Google 使用地区代码 zh-CN / zh-TW（它们对 zh-Hant 的支持不稳定）。
 */
const BING_TARGET_LANG = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', en: 'en', ja: 'ja', ko: 'ko' };
const AZURE_TARGET_LANG = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', en: 'en', ja: 'ja', ko: 'ko' };
const MYMEMORY_TARGET_LANG = { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko' };
const GOOGLE_TARGET_LANG = { 'zh-CN': 'zh-CN', 'zh-TW': 'zh-TW', en: 'en', ja: 'ja', ko: 'ko' };

const TARGET_LANG_NAMES = {
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
};

/* ------------------------------ 错误 ------------------------------ */

/**
 * 翻译相关统一错误类型。
 * code 取值：PROVIDER_NOT_CONFIGURED / UNKNOWN_PROVIDER / INVALID_KEY / RATE_LIMIT /
 *           QUOTA_EXCEEDED / UPSTREAM_ERROR / NETWORK_ERROR / TIMEOUT / BAD_RESPONSE /
 *           HTTP_ERROR / ABORTED / INVALID_INPUT / UNKNOWN_ERROR
 */
export class TranslatorError extends Error {
  constructor(code, message, providerId, options) {
    super(message || '翻译失败，请稍后重试');
    this.name = 'TranslatorError';
    this.code = String(code || 'UNKNOWN_ERROR');
    this.provider = String(providerId || '');
    this.retryable = Boolean(options && options.retryable === true);
    if (options && options.cause !== undefined) this.cause = options.cause;
  }
}

/** 服务商展示名（去掉元数据里的营销后缀，用于错误提示） */
export function providerDisplayName(providerId) {
  const meta = PROVIDER_META[providerId];
  if (!meta) return String(providerId || '翻译服务');
  return String(meta.label || providerId).replace(/（[^）]*）/g, '').trim() || String(providerId);
}

function truncate(value, maxLength) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(0, maxLength - 1)) + '…';
}

function httpError(status, providerId, label, detail) {
  const suffix = detail ? '（服务端信息：' + truncate(detail, 160) + '）' : '';
  let error;
  if (status === 401 || status === 403) {
    error = new TranslatorError('INVALID_KEY', label + '密钥无效、权限不足或区域配置错误，请到设置中检查' + suffix, providerId);
  } else if (status === 429) {
    error = new TranslatorError('RATE_LIMIT', label + '请求过于频繁或额度已用尽，请稍后重试或更换服务商' + suffix, providerId);
  } else if (status >= 500) {
    error = new TranslatorError('UPSTREAM_ERROR', label + '服务暂时不可用（HTTP ' + status + '），请稍后重试' + suffix, providerId);
  } else {
    error = new TranslatorError('HTTP_ERROR', label + '请求失败（HTTP ' + status + '）' + suffix, providerId);
  }
  error.httpStatus = status;
  return error;
}

/** 必应免费接口专用错误映射：401/403 通常是接口风控或改版，而非「密钥无效」 */
function bingHttpError(status) {
  const error = status === 401 || status === 403
    ? new TranslatorError('INVALID_KEY', '必应翻译接口拒绝了请求（可能需要验证或接口已调整），请稍后重试或改用 DeepSeek', 'bing-free')
    : httpError(status, 'bing-free', '必应翻译');
  error.httpStatus = status;
  return error;
}

function badResponse(providerId, message, retryable) {
  return new TranslatorError('BAD_RESPONSE', message, providerId, { retryable: retryable === true });
}

/* --------------------------- 网络请求封装 --------------------------- */

/**
 * 带超时 / 外部取消的 fetch 封装：handle 在超时保护范围内读取响应体。
 * 外部错误统一转换为 TranslatorError。
 */
async function runFetch(options, handle) {
  const providerId = options.providerId || '';
  const label = options.label || '翻译服务';
  const fetcher = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetcher !== 'function') {
    throw new TranslatorError('NETWORK_ERROR', '当前环境不支持网络请求（fetch 不可用）', providerId);
  }
  const externalSignal = options.signal;
  if (externalSignal && externalSignal.aborted === true) {
    throw new TranslatorError('ABORTED', '翻译请求已取消', providerId);
  }
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onExternalAbort = () => controller.abort();
  if (externalSignal && typeof externalSignal.addEventListener === 'function') {
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const response = await fetcher(options.url, Object.assign({}, options.init || {}, { signal: controller.signal }));
    return await handle(response);
  } catch (error) {
    if (error instanceof TranslatorError) throw error;
    if (timedOut) {
      throw new TranslatorError('TIMEOUT', label + '请求超时（' + Math.round(timeoutMs / 1000) + ' 秒），请检查网络后重试', providerId, { cause: error });
    }
    if (externalSignal && externalSignal.aborted === true) {
      throw new TranslatorError('ABORTED', '翻译请求已取消', providerId);
    }
    throw new TranslatorError('NETWORK_ERROR', '无法连接' + label + '，请检查网络、代理或接口地址', providerId, { cause: error });
  } finally {
    clearTimeout(timer);
    if (externalSignal && typeof externalSignal.removeEventListener === 'function') {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
}

/** 读取响应文本，读取失败时返回空串（用于错误详情，不抛出） */
async function safeText(response) {
  try {
    return await response.text();
  } catch (error) {
    return '';
  }
}

/* --------------------------- 文本切分工具 --------------------------- */

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** 返回 (min, max] 区间内最后一个满足 test 的字符的后一位；找不到返回 -1 */
function lastBreakIndex(text, min, max, test) {
  for (let index = max - 1; index >= min; index -= 1) {
    if (test(text[index])) return index + 1;
  }
  return -1;
}

const SENTENCE_END_TEST = (char) => char === '。' || char === '！' || char === '？' || char === '!' || char === '?' || char === ';' || char === '；' || char === '.' || char === '\n';
const CLAUSE_END_TEST = (char) => char === '，' || char === ',' || char === '、' || char === '：' || char === ':';
const SPACE_TEST = (char) => /\s/.test(char);

/**
 * 按字符数切分文本，优先在句末 / 空格处断开，且不会切开占位符 ⟦T0⟧ 或代理对。
 * 切片拼接后与原文本完全一致。
 */
function splitText(text, limit) {
  const source = typeof text === 'string' ? text : String(text == null ? '' : text);
  if (!source) return [];
  if (source.length <= limit) return [source];

  const chunks = [];
  let start = 0;
  while (start < source.length) {
    let end = Math.min(start + limit, source.length);
    if (end >= source.length) {
      chunks.push(source.slice(start));
      break;
    }
    const minCut = start + Math.floor((end - start) * 0.4);

    // 不切开占位符
    const lastOpen = source.lastIndexOf('⟦', end - 1);
    const lastClose = source.lastIndexOf('⟧', end - 1);
    if (lastOpen > lastClose && lastOpen > minCut) end = lastOpen;
    // 不切开代理对（emoji 等）
    if (end > 0 && isHighSurrogate(source.charCodeAt(end - 1)) && isLowSurrogate(source.charCodeAt(end))) end -= 1;

    let cut = lastBreakIndex(source, minCut, end, SENTENCE_END_TEST);
    if (cut < 0) cut = lastBreakIndex(source, minCut, end, CLAUSE_END_TEST);
    if (cut < 0) cut = lastBreakIndex(source, minCut, end, SPACE_TEST);
    if (cut <= start) cut = end;
    chunks.push(source.slice(start, cut));
    start = cut;
  }
  return chunks;
}

/** 按 UTF-8 字节数切分文本（MyMemory 的 q 参数约 500 字节上限） */
function splitTextByBytes(text, limitBytes) {
  const source = typeof text === 'string' ? text : String(text == null ? '' : text);
  if (!source) return [];
  const encoder = new TextEncoder();
  if (encoder.encode(source).length <= limitBytes) return [source];

  const chunks = [];
  let start = 0;
  while (start < source.length) {
    let end = start;
    let bytes = 0;
    while (end < source.length) {
      const codePoint = source.codePointAt(end);
      let size = 1;
      if (codePoint > 0xffff) size = 4;
      else if (codePoint > 0x7ff) size = 3;
      else if (codePoint > 0x7f) size = 2;
      if (bytes + size > limitBytes) break;
      bytes += size;
      end += codePoint > 0xffff ? 2 : 1;
    }
    if (end >= source.length) {
      chunks.push(source.slice(start));
      break;
    }
    const minCut = start + Math.floor((end - start) * 0.5);
    let cut = lastBreakIndex(source, minCut, end, SENTENCE_END_TEST);
    if (cut < 0) cut = lastBreakIndex(source, minCut, end, SPACE_TEST);
    if (cut <= start) cut = end;
    chunks.push(source.slice(start, cut));
    start = cut;
  }
  return chunks;
}

/** 拼接同一文本的多个分片译文：目标语言为英语时补空格，避免单词粘连 */
function joinChunks(parts, targetLang) {
  const list = Array.isArray(parts) ? parts : [];
  if (list.length === 0) return '';
  if (list.length === 1) return list[0] || '';
  const separator = targetLang === 'en' ? ' ' : '';
  let result = '';
  for (const part of list) {
    if (!part) continue;
    if (result && separator) result += separator;
    result += part;
  }
  return result;
}

/* ------------------------------ 必应翻译 ------------------------------ */

let bingTokenCache = null;
let bingTokenPromise = null;

/*
 * 必应接口对并发请求有风控：同一 token/IG 的 POST 并发时会间歇性返回 401。
 * 因此所有必应 POST 统一走模块级串行队列（同一时刻只允许 1 个在途），并在请求之间保留
 * 120~250ms 间隔。队列必须跨 translateBatch 调用共享，否则整页翻译的多个批次并发时仍会触发风控。
 */
const BING_POST_MIN_GAP_MS = 120;
const BING_POST_MAX_GAP_MS = 250;
const BING_AUTH_RETRY_DELAY_MS = 300;

let bingThrottle = {
  minGapMs: BING_POST_MIN_GAP_MS,
  maxGapMs: BING_POST_MAX_GAP_MS,
  authRetryDelayMs: BING_AUTH_RETRY_DELAY_MS,
};
let bingPostChain = Promise.resolve();
let bingLastPostFinishedAt = 0;

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/** 仅测试使用：清空必应 token 缓存与串行队列状态 */
export function resetBingCache() {
  bingTokenCache = null;
  bingTokenPromise = null;
  bingPostChain = Promise.resolve();
  bingLastPostFinishedAt = 0;
}

/** 仅测试使用：调小节流间隔，避免单测被真实延迟拖慢（生产默认 120~250ms 间隔、300ms 刷新重试） */
export function setBingThrottleForTests(options) {
  const config = options && typeof options === 'object' ? options : {};
  const minGapMs = Number.isFinite(config.minGapMs) ? Math.max(0, config.minGapMs) : BING_POST_MIN_GAP_MS;
  const maxGapMs = Number.isFinite(config.maxGapMs) ? Math.max(minGapMs, config.maxGapMs) : BING_POST_MAX_GAP_MS;
  bingThrottle = {
    minGapMs,
    maxGapMs,
    authRetryDelayMs: Number.isFinite(config.authRetryDelayMs) ? Math.max(0, config.authRetryDelayMs) : BING_AUTH_RETRY_DELAY_MS,
  };
  bingLastPostFinishedAt = 0;
}

/** 把必应 POST 追加到全局串行队列：同一时刻只允许 1 个 POST 在途 */
function enqueueBingPost(task) {
  const run = bingPostChain.then(async () => {
    const spread = Math.max(0, bingThrottle.maxGapMs - bingThrottle.minGapMs);
    const gap = bingThrottle.minGapMs + Math.floor(Math.random() * (spread + 1));
    const waitMs = bingLastPostFinishedAt + gap - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    try {
      return await task();
    } finally {
      bingLastPostFinishedAt = Date.now();
    }
  });
  // 单个请求失败不能中断队列中的后续请求
  bingPostChain = run.then(() => undefined, () => undefined);
  return run;
}

function isBingCacheFresh(cache) {
  return Boolean(cache) && Date.now() - cache.fetchedAt < BING_TOKEN_TTL;
}

/** 从必应翻译页面 HTML 中解析 token / key / IG */
function parseBingSessionHtml(html) {
  const source = typeof html === 'string' ? html : '';
  if (!source) return null;
  // 形如：params_AbusePreventionHelper = [1700000000000,"token...",3600000]
  const helperMatch = /params_AbusePreventionHelper\s*=\s*\[\s*"?([0-9]+)"?\s*,\s*"([^"]+)"/.exec(source);
  const igMatch = /IG\s*:\s*"([^"]+)"/.exec(source);
  if (!helperMatch || !igMatch) return null;
  const key = Number(helperMatch[1]);
  if (!Number.isFinite(key) || key <= 0) return null;
  const token = helperMatch[2];
  const ig = igMatch[1];
  if (!token || !ig) return null;
  return { key, token, ig };
}

async function loadBingSession(options) {
  const providerId = 'bing-free';
  const label = '必应翻译';
  let lastError = null;
  for (const candidate of BING_ORIGIN_CANDIDATES) {
    try {
      const session = await runFetch({
        providerId,
        label,
        fetchImpl: options.fetchImpl,
        url: candidate,
        init: {
          method: 'GET',
          headers: {
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'User-Agent': BROWSER_UA,
          },
        },
        timeoutMs: DEFAULT_TIMEOUT_MS,
        signal: options.signal,
      }, async (response) => {
        if (!response.ok) throw bingHttpError(response.status);
        const html = await safeText(response);
        const parsed = parseBingSessionHtml(html);
        if (!parsed) {
          throw badResponse(providerId, '必应翻译页面结构已变化，暂时无法使用，请稍后重试或改用 DeepSeek', true);
        }
        const finalUrl = response.url && /^https?:/i.test(response.url) ? response.url : candidate;
        let origin = 'https://cn.bing.com';
        try {
          origin = new URL(finalUrl).origin;
        } catch (error) {
          origin = 'https://cn.bing.com';
        }
        return { token: parsed.token, key: parsed.key, ig: parsed.ig, origin, fetchedAt: Date.now() };
      });
      return session;
    } catch (error) {
      lastError = error;
      if (error instanceof TranslatorError && error.code === 'ABORTED') throw error;
      // 其它错误继续尝试备用域名
    }
  }
  if (lastError) throw lastError;
  throw new TranslatorError('NETWORK_ERROR', '无法连接必应翻译，请检查网络后重试或改用 DeepSeek', 'bing-free');
}

/** 获取必应 token（模块级缓存 50 分钟，并发请求共享同一个刷新 Promise） */
async function getBingSession(options) {
  if (!options.force && isBingCacheFresh(bingTokenCache)) return bingTokenCache;
  if (bingTokenPromise) return bingTokenPromise;
  const promise = loadBingSession(options).then((session) => {
    bingTokenCache = session;
    return session;
  });
  bingTokenPromise = promise;
  const clear = () => {
    if (bingTokenPromise === promise) bingTokenPromise = null;
  };
  promise.then(clear, clear);
  return promise;
}

/** 单次必应 ttranslatev3 请求（自动刷新 token 并重试一次由上层负责） */
async function requestBingChunk(providerId, text, session, options) {
  const label = '必应翻译';
  const target = BING_TARGET_LANG[options.targetLang] || options.targetLang || 'zh-Hans';
  const url = session.origin + '/ttranslatev3?isVertical=1&&IG=' + encodeURIComponent(session.ig) + '&IID=translator.5028.1';
  const body = new URLSearchParams();
  body.set('fromLang', 'auto-detect');
  body.set('to', target);
  body.set('text', text);
  body.set('token', session.token); // 注意：token 是字符串
  body.set('key', String(session.key)); // 注意：key 是数字（以字符串形式提交）

  return runFetch({
    providerId,
    label,
    fetchImpl: options.fetchImpl,
    url,
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Referer: session.origin + '/translator',
        Accept: 'application/json, text/plain, */*',
        'User-Agent': BROWSER_UA,
      },
      body: body.toString(),
    },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    signal: options.signal,
  }, async (response) => {
    const raw = await safeText(response);
    if (!response.ok) throw bingHttpError(response.status);
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      throw badResponse(providerId, label + '返回了无法解析的数据，请稍后重试', true);
    }
    const item = Array.isArray(data) ? data[0] : data;
    if (item && Number.isFinite(item.statusCode) && item.statusCode >= 400) {
      throw bingHttpError(item.statusCode);
    }
    const translated = item && Array.isArray(item.translations) && item.translations[0] && typeof item.translations[0].text === 'string'
      ? item.translations[0].text
      : '';
    if (!translated.trim()) throw badResponse(providerId, label + '返回了空结果，请稍后重试', true);
    return translated;
  });
}

/**
 * 401 后刷新 token：若其它并发请求已经刷新过（缓存比失败时使用的 session 更新），直接复用，
 * 避免多个批次同时重复拉取 token 页面。
 */
async function refreshBingSession(previousSession, options) {
  if (!bingTokenPromise && bingTokenCache && (!previousSession || bingTokenCache.fetchedAt > previousSession.fetchedAt)) {
    return bingTokenCache;
  }
  return getBingSession({ fetchImpl: options.fetchImpl, signal: options.signal, force: true });
}

/**
 * 单条必应翻译（含 401/403/空结果的刷新重试）。
 * 所有 POST（含刷新后的重试）都通过 enqueueBingPost 全局串行，以规避必应并发风控。
 */
async function requestBingTranslation(providerId, text, options) {
  let usedSession = null;
  try {
    return await enqueueBingPost(async () => {
      usedSession = await getBingSession({ fetchImpl: options.fetchImpl, signal: options.signal });
      return requestBingChunk(providerId, text, usedSession, options);
    });
  } catch (error) {
    if (error instanceof TranslatorError && error.code === 'ABORTED') throw error;
    const shouldRefresh = error instanceof TranslatorError && (error.code === 'INVALID_KEY' || error.retryable === true);
    if (!shouldRefresh) throw error;
    // 风控 / token 失效：等待 300ms 后刷新 token，再进入队列重试一次
    await sleep(bingThrottle.authRetryDelayMs);
    return enqueueBingPost(async () => {
      const freshSession = await refreshBingSession(usedSession, { fetchImpl: options.fetchImpl, signal: options.signal });
      return requestBingChunk(providerId, text, freshSession, options);
    });
  }
}

async function runBingFree(options) {
  const providerId = 'bing-free';
  const warnings = [];
  try {
    const translations = [];
    for (const text of options.texts) {
      if (!text.trim()) {
        translations.push(text);
        continue;
      }
      const chunks = splitText(text, BING_CHUNK_LIMIT);
      const parts = [];
      for (const chunk of chunks) {
        if (!chunk.trim()) {
          parts.push(chunk);
          continue;
        }
        parts.push(await requestBingTranslation(providerId, chunk, options));
      }
      translations.push(joinChunks(parts, options.targetLang));
    }
    return { translations, warnings };
  } catch (error) {
    if (error instanceof TranslatorError && error.code === 'ABORTED') throw error;
    // 免费服务商默认允许回退到 MyMemory（由 translator 通过 config.__freeFallback 透传设置）
    if (options.config.__freeFallback === false) throw error;
    // 术语保护时传入的 texts 含 ⟦T0⟧ 占位符，MyMemory 可能打乱标记；
    // 因此回退时优先翻译调度层透传的未保护原文，并标记 unprotected 让调度层跳过还原。
    const originals = Array.isArray(options.config.__originalTexts) && options.config.__originalTexts.length === options.texts.length
      ? options.config.__originalTexts
      : options.texts;
    const unprotected = originals !== options.texts;
    warnings.push(unprotected
      ? '必应翻译暂时不可用，已回退 MyMemory 直接翻译原文（本次未启用术语保护）'
      : '必应翻译暂时不可用，已自动回退到 MyMemory 免费接口（译文质量可能下降）');
    try {
      const fallback = await translateWithProvider({
        providerId: 'mymemory',
        config: {},
        targetLang: options.targetLang,
        texts: originals,
        fetchImpl: options.fetchImpl,
        signal: options.signal,
      });
      return {
        translations: fallback.translations,
        warnings: warnings.concat(Array.isArray(fallback.warnings) ? fallback.warnings : []),
        unprotected,
      };
    } catch (fallbackError) {
      const code = fallbackError instanceof TranslatorError ? fallbackError.code : 'UPSTREAM_ERROR';
      const message = fallbackError && fallbackError.message ? fallbackError.message : '未知错误';
      // 保留必应原始失败信息（含 HTTP 状态码），便于排查风控 / 网络问题
      let bingReason = '必应翻译失败';
      if (error && Number.isFinite(error.httpStatus)) {
        bingReason = '必应翻译失败（HTTP ' + error.httpStatus + '）';
      } else if (error && error.message) {
        bingReason = '必应翻译失败（' + truncate(error.message, 80) + '）';
      }
      const combined = new TranslatorError(code, bingReason + '，备用 MyMemory 也不可用：' + message, providerId);
      if (error && Number.isFinite(error.httpStatus)) combined.httpStatus = error.httpStatus;
      throw combined;
    }
  }
}

/* ------------------------------ 大模型服务 ------------------------------ */

/** 规范化 Chat Completions 地址：未以 /v1 或 /chat 结尾时自动补 /v1 */
function normalizeChatUrl(providerId, baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) {
    throw new TranslatorError('PROVIDER_NOT_CONFIGURED', providerDisplayName(providerId) + ' 尚未配置接口地址，请到设置中填写', providerId);
  }
  const base = raw.replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/chat$/.test(base)) return base + '/completions';
  if (/\/v1$/.test(base)) return base + '/chat/completions';
  return base + '/v1/chat/completions';
}

function buildDefaultLLMMessages(targetLang, texts) {
  const langName = TARGET_LANG_NAMES[targetLang] || targetLang || '简体中文';
  const system = [
    '你是一名资深计算机技术译者，负责把技术文档准确翻译成' + langName + '。',
    '要求：使用中国大陆 IT 行业规范术语；保留代码、命令行、URL、版本号以及占位符（如 ⟦T0⟧、⟦C0⟧）原样不变；不添加任何解释。',
    '只输出 JSON：{"translations":["译文1","译文2"]}，数组长度必须等于输入条数 ' + texts.length + '，顺序一一对应。',
  ].join('\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify({ texts }) },
  ];
}

async function runLLM(options) {
  const providerId = options.providerId;
  const label = providerDisplayName(providerId);
  const config = options.config;
  const url = normalizeChatUrl(providerId, config.baseUrl);
  const apiKey = String(config.apiKey || '').trim();
  const model = String(config.model || '').trim();
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  const messages = Array.isArray(options.messages) && options.messages.length > 0
    ? options.messages
    : buildDefaultLLMMessages(options.targetLang, options.texts);
  const body = JSON.stringify({ model, messages, temperature: 0.2, stream: false });

  const data = await runFetch({
    providerId,
    label,
    fetchImpl: options.fetchImpl,
    url,
    init: { method: 'POST', headers, body },
    timeoutMs: LLM_TIMEOUT_MS,
    signal: options.signal,
  }, async (response) => {
    const raw = await safeText(response);
    if (!response.ok) {
      let detail = '';
      try {
        const parsed = JSON.parse(raw);
        detail = (parsed && parsed.error && parsed.error.message) || (parsed && parsed.message) || '';
      } catch (error) {
        detail = raw;
      }
      throw httpError(response.status, providerId, label, detail);
    }
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw badResponse(providerId, label + '返回了无法解析的数据，请稍后重试或检查模型名称');
    }
  });

  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const content = choice && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
  if (!content.trim()) throw badResponse(providerId, label + '未返回翻译内容，请检查模型名称是否正确');
  // 大模型返回的是原始文本（调度层会解析 JSON），因此 translations 只放一个原始输出
  return { translations: [content], raw: content, warnings: [] };
}

/* ------------------------------ Azure ------------------------------ */

async function runAzure(options) {
  const providerId = 'azure';
  const label = providerDisplayName(providerId);
  const config = options.config;
  const endpoint = (String(config.endpoint || '').trim() || AZURE_DEFAULT_ENDPOINT).replace(/\/+$/, '');
  const target = AZURE_TARGET_LANG[options.targetLang] || options.targetLang || 'zh-Hans';
  const url = endpoint + '/translate?api-version=3.0&to=' + encodeURIComponent(target);
  const headers = {
    'Content-Type': 'application/json',
    'Ocp-Apim-Subscription-Key': String(config.apiKey || '').trim(),
    'Ocp-Apim-Subscription-Region': String(config.region || '').trim(),
  };

  // 1) 先按单条上限切分，记录来源下标，翻译后再按原顺序拼回
  const items = [];
  options.texts.forEach((text, textIndex) => {
    if (!text) return;
    const parts = splitText(text, AZURE_TEXT_LIMIT);
    parts.forEach((part, partIndex) => {
      items.push({ textIndex, partIndex, text: part });
    });
  });

  // 2) 按「最多 100 条 / 最多 44000 字符」分组，真正批量请求
  const batches = [];
  let current = [];
  let currentChars = 0;
  for (const item of items) {
    if (current.length >= AZURE_MAX_ITEMS || (currentChars + item.text.length > AZURE_MAX_CHARS && current.length > 0)) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(item);
    currentChars += item.text.length;
  }
  if (current.length > 0) batches.push(current);

  const partResults = options.texts.map(() => []);
  for (const batch of batches) {
    const body = JSON.stringify(batch.map((item) => ({ Text: item.text })));
    const data = await runFetch({
      providerId,
      label,
      fetchImpl: options.fetchImpl,
      url,
      init: { method: 'POST', headers, body },
      timeoutMs: DEFAULT_TIMEOUT_MS,
      signal: options.signal,
    }, async (response) => {
      const raw = await safeText(response);
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new TranslatorError('INVALID_KEY', label + '订阅密钥或区域无效，请到设置中检查', providerId);
        }
        let detail = '';
        try {
          const parsed = JSON.parse(raw);
          detail = parsed && parsed.error && parsed.error.message ? parsed.error.message : '';
        } catch (error) {
          detail = '';
        }
        throw httpError(response.status, providerId, label, detail);
      }
      try {
        return JSON.parse(raw);
      } catch (error) {
        throw badResponse(providerId, label + '返回了无法解析的数据，请稍后重试');
      }
    });

    if (!Array.isArray(data) || data.length !== batch.length) {
      throw badResponse(providerId, label + '返回的译文数量与请求不一致，请稍后重试');
    }
    data.forEach((translatedItem, index) => {
      const source = batch[index];
      const translated = translatedItem && Array.isArray(translatedItem.translations) && translatedItem.translations[0]
        && typeof translatedItem.translations[0].text === 'string'
        ? translatedItem.translations[0].text
        : null;
      if (translated === null) {
        throw badResponse(providerId, label + '返回的译文格式不正确，请稍后重试');
      }
      partResults[source.textIndex][source.partIndex] = translated;
    });
  }

  const translations = options.texts.map((text, index) => {
    if (!text) return text;
    return joinChunks(partResults[index], options.targetLang);
  });
  return { translations, warnings: [] };
}

/* ------------------------------ MyMemory ------------------------------ */

function decodeHtmlEntities(value) {
  return String(value == null ? '' : value)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/&#([0-9]+);/g, (match, digits) => {
      const code = Number(digits);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    })
    .replace(/&amp;/g, '&');
}

/** MyMemory 只能指定固定语言对：中译英场景使用 zh-CN|en，其余按英译目标语言处理 */
function myMemoryLangPair(targetLang) {
  const target = MYMEMORY_TARGET_LANG[targetLang] || targetLang || 'zh-CN';
  const source = targetLang === 'en' ? 'zh-CN' : 'en';
  return source + '|' + target;
}

async function requestMyMemoryChunk(providerId, label, text, options) {
  const params = new URLSearchParams();
  params.set('q', text);
  params.set('langpair', myMemoryLangPair(options.targetLang));
  const email = String(options.config.email || '').trim();
  if (email) params.set('de', email);
  const url = MYMEMORY_ENDPOINT + '?' + params.toString();

  const data = await runFetch({
    providerId,
    label,
    fetchImpl: options.fetchImpl,
    url,
    init: { method: 'GET', headers: { Accept: 'application/json' } },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    signal: options.signal,
  }, async (response) => {
    const raw = await safeText(response);
    if (!response.ok) throw httpError(response.status, providerId, label);
    try {
      return JSON.parse(raw);
    } catch (error) {
      throw badResponse(providerId, label + '返回了无法解析的数据，请稍后重试');
    }
  });

  if (data && data.quotaFinished === true) {
    throw new TranslatorError('QUOTA_EXCEEDED', label + '今日免费额度已用尽，请明天再试或更换服务商', providerId);
  }
  const status = Number(data && data.responseStatus);
  if (Number.isFinite(status) && status !== 200) {
    const detail = String((data && data.responseDetails) || '');
    if (status === 429 || /MYMEMORY WARNING|quota/i.test(detail)) {
      throw new TranslatorError('QUOTA_EXCEEDED', label + '免费额度已用尽，请明天再试或更换服务商', providerId);
    }
    throw new TranslatorError('UPSTREAM_ERROR', label + '服务返回错误（' + status + '）' + (detail ? '：' + truncate(detail, 120) : '') + '，请稍后重试', providerId);
  }

  const rawTranslated = data && data.responseData ? data.responseData.translatedText : '';
  if (typeof rawTranslated !== 'string') {
    throw badResponse(providerId, label + '返回了无法解析的数据，请稍后重试');
  }
  const translated = decodeHtmlEntities(rawTranslated).trim();
  if (/MYMEMORY WARNING/i.test(translated)) {
    throw new TranslatorError('QUOTA_EXCEEDED', label + '免费额度已用尽，请明天再试或更换服务商', providerId);
  }
  if (!translated && text.trim()) {
    throw badResponse(providerId, label + '返回了空译文，请稍后重试');
  }
  return translated;
}

async function runMyMemory(options) {
  const providerId = 'mymemory';
  const label = providerDisplayName(providerId);
  const translations = [];
  for (const text of options.texts) {
    if (!text.trim()) {
      translations.push(text);
      continue;
    }
    const chunks = splitTextByBytes(text, MYMEMORY_CHUNK_BYTES);
    const parts = [];
    for (const chunk of chunks) {
      if (!chunk.trim()) {
        parts.push(chunk);
        continue;
      }
      parts.push(await requestMyMemoryChunk(providerId, label, chunk.trim(), options));
    }
    translations.push(joinChunks(parts, options.targetLang));
  }
  return { translations, warnings: [] };
}

/* ------------------------------ Google ------------------------------ */

async function requestGoogleChunk(text, options) {
  const providerId = 'google-free';
  const label = 'Google 翻译';
  const target = GOOGLE_TARGET_LANG[options.targetLang] || options.targetLang || 'zh-CN';
  const params = new URLSearchParams({ client: 'gtx', sl: 'auto', tl: target, dt: 't', q: text });
  const url = GOOGLE_ENDPOINT + '?' + params.toString();

  let data;
  try {
    data = await runFetch({
      providerId,
      label,
      fetchImpl: options.fetchImpl,
      url,
      init: { method: 'GET', headers: { Accept: 'application/json' } },
      timeoutMs: DEFAULT_TIMEOUT_MS,
      signal: options.signal,
    }, async (response) => {
      if (!response.ok) {
        if (response.status === 429) {
          throw new TranslatorError('RATE_LIMIT', label + '请求过于频繁，请稍后重试或更换服务商', providerId);
        }
        if (response.status === 403) {
          throw new TranslatorError('NETWORK_ERROR', GOOGLE_NETWORK_HINT, providerId);
        }
        throw httpError(response.status, providerId, label);
      }
      const raw = await safeText(response);
      try {
        return JSON.parse(raw);
      } catch (error) {
        // 返回 HTML（常见于被网络劫持 / 需要验证）时按无法访问处理
        throw new TranslatorError('NETWORK_ERROR', GOOGLE_NETWORK_HINT, providerId);
      }
    });
  } catch (error) {
    if (error instanceof TranslatorError && (error.code === 'NETWORK_ERROR' || error.code === 'TIMEOUT')) {
      throw new TranslatorError('NETWORK_ERROR', GOOGLE_NETWORK_HINT, providerId);
    }
    throw error;
  }

  const segments = data && Array.isArray(data[0]) ? data[0] : null;
  if (!segments) throw badResponse(providerId, label + '返回了无法解析的数据，请稍后重试');
  let translated = '';
  for (const segment of segments) {
    if (Array.isArray(segment) && typeof segment[0] === 'string') translated += segment[0];
  }
  if (!translated.trim()) throw badResponse(providerId, label + '返回了空结果，请稍后重试或更换服务商');
  return translated;
}

async function runGoogleFree(options) {
  const translations = [];
  for (const text of options.texts) {
    if (!text.trim()) {
      translations.push(text);
      continue;
    }
    const chunks = splitText(text, GOOGLE_CHUNK_LIMIT);
    const parts = [];
    for (const chunk of chunks) {
      if (!chunk.trim()) {
        parts.push(chunk);
        continue;
      }
      parts.push(await requestGoogleChunk(chunk.trim(), options));
    }
    translations.push(joinChunks(parts, options.targetLang));
  }
  return { translations, warnings: [] };
}

/* ------------------------------ 离线术语词典 ------------------------------ */

function translateOfflineText(text, entries) {
  const source = typeof text === 'string' ? text : String(text == null ? '' : text);
  if (!source || !Array.isArray(entries) || entries.length === 0) return source;
  const matches = findTerms(source, entries, { maxMatches: 500 });
  if (matches.length === 0) return source;
  let result = source;
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index];
    const zh = match.entry && typeof match.entry.zh === 'string' ? match.entry.zh : '';
    if (!zh) continue;
    result = result.slice(0, match.start) + zh + result.slice(match.end);
  }
  return result;
}

async function runGlossary(options) {
  const entries = Array.isArray(options.config.__glossary) && options.config.__glossary.length > 0
    ? options.config.__glossary
    : GLOSSARY;
  const translations = options.texts.map((text) => translateOfflineText(text, entries));
  return { translations, warnings: [] };
}

/* ------------------------------ 配置校验 ------------------------------ */

function assertConfigured(providerId, config) {
  const meta = PROVIDER_META[providerId];
  if (!meta) {
    throw new TranslatorError('UNKNOWN_PROVIDER', '未知的翻译服务商：' + (providerId || '（空）') + '，请到设置中选择', providerId);
  }
  const missing = (meta.fields || []).filter((field) => field.required && !String(config[field.key] == null ? '' : config[field.key]).trim());
  if (missing.length > 0) {
    const names = missing.map((field) => '「' + field.label + '」').join('、');
    throw new TranslatorError('PROVIDER_NOT_CONFIGURED', providerDisplayName(providerId) + ' 尚未配置，请到设置中填写 ' + names, providerId);
  }
}

/* ------------------------------ 对外接口 ------------------------------ */

/**
 * 调用指定服务商翻译一组文本。
 *
 * @param {object} options
 * @param {string} options.providerId 服务商 id（见 constants.js PROVIDER_META）
 * @param {object} options.config 服务商配置（可包含内部字段 __freeFallback / __glossary）
 * @param {string} options.targetLang 目标语言，如 zh-CN / en
 * @param {string[]} options.texts 待翻译文本
 * @param {Function} [options.fetchImpl] 可注入的 fetch 实现（默认取调用时的 globalThis.fetch）
 * @param {AbortSignal} [options.signal] 外部取消信号
 * @param {Array} [options.messages] 仅 llm 服务商使用：由 translator 组装好的 Chat Completions messages
 * @returns {Promise<{ translations: string[], raw?: string, warnings: string[] }>}
 */
export async function translateWithProvider(options) {
  const settings = options && typeof options === 'object' ? options : {};
  const providerId = settings.providerId;
  const config = settings.config && typeof settings.config === 'object' ? settings.config : {};
  const meta = PROVIDER_META[providerId];
  if (!meta) {
    throw new TranslatorError('UNKNOWN_PROVIDER', '未知的翻译服务商：' + (providerId || '（空）') + '，请到设置中选择', providerId);
  }
  assertConfigured(providerId, config);

  const rawTexts = Array.isArray(settings.texts) ? settings.texts : settings.texts == null ? [] : [settings.texts];
  const texts = rawTexts.map((text) => (typeof text === 'string' ? text : String(text == null ? '' : text)));
  const targetLang = String(settings.targetLang || 'zh-CN');
  if (texts.length === 0) return { translations: [], warnings: [] };
  if (texts.every((text) => !text.trim())) return { translations: texts.slice(), warnings: [] };

  const runOptions = {
    providerId,
    config,
    targetLang,
    texts,
    fetchImpl: settings.fetchImpl,
    signal: settings.signal,
    messages: settings.messages,
  };

  if (meta.kind === 'llm') return runLLM(runOptions);
  if (meta.kind === 'local') return runGlossary(runOptions);
  if (meta.kind === 'mt') {
    if (providerId === 'bing-free') return runBingFree(runOptions);
    if (providerId === 'azure') return runAzure(runOptions);
    if (providerId === 'mymemory') return runMyMemory(runOptions);
    if (providerId === 'google-free') return runGoogleFree(runOptions);
  }
  throw new TranslatorError('UNKNOWN_PROVIDER', '暂不支持的翻译服务商：' + providerId, providerId);
}

/** 从大模型输出中尽量提取一个示例译文（仅用于连接测试展示） */
function extractSampleFromModel(content) {
  const raw = String(content == null ? '' : content).trim();
  if (!raw) return '';
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(raw.slice(firstBrace, lastBrace + 1));
      const list = parsed && Array.isArray(parsed.translations) ? parsed.translations : null;
      if (list && list.length > 0) {
        const first = list[0];
        if (typeof first === 'string') return first.trim();
        if (first && typeof first.text === 'string') return first.text.trim();
      }
    } catch (error) {
      // 不是合法 JSON（例如带代码围栏或前后缀说明），按纯文本处理
    }
  }
  return raw.replace(/^["'“”]+|["'“”]+$/g, '').trim();
}

/**
 * 测试服务商连通性：用 "thread" 做一次真实翻译，失败返回 { ok:false, message } 而不抛错。
 *
 * @param {object} options
 * @param {string} options.providerId
 * @param {object} options.config
 * @param {Function} [options.fetchImpl]
 * @param {string} [options.targetLang]
 * @param {AbortSignal} [options.signal]
 * @returns {Promise<{ ok: boolean, message: string, sample?: string }>}
 */
export async function testProviderConnection(options) {
  const settings = options && typeof options === 'object' ? options : {};
  const providerId = settings.providerId;
  const meta = PROVIDER_META[providerId];
  if (!meta) return { ok: false, message: '未知的翻译服务商：' + (providerId || '（空）') };
  const config = settings.config && typeof settings.config === 'object' ? settings.config : {};
  const targetLang = String(settings.targetLang || 'zh-CN');
  const label = providerDisplayName(providerId);

  try {
    if (meta.kind === 'local') {
      const result = await translateWithProvider({
        providerId,
        config,
        targetLang,
        texts: ['thread'],
        fetchImpl: settings.fetchImpl,
        signal: settings.signal,
      });
      return { ok: true, message: '离线词典模式无需联网，可直接使用', sample: result.translations[0] || '' };
    }
    const result = await translateWithProvider({
      providerId,
      config,
      targetLang,
      texts: ['thread'],
      fetchImpl: settings.fetchImpl,
      signal: settings.signal,
    });
    let sample = '';
    if (typeof result.raw === 'string') {
      sample = extractSampleFromModel(result.raw);
    } else {
      sample = result.translations && typeof result.translations[0] === 'string' ? result.translations[0].trim() : '';
    }
    if (!sample) return { ok: false, message: label + '未返回有效译文，请检查配置' };
    return { ok: true, message: '连接成功，示例译文：' + truncate(sample, 60), sample };
  } catch (error) {
    const message = error instanceof TranslatorError
      ? error.message
      : '连接测试失败：' + (error && error.message ? error.message : '未知错误');
    return { ok: false, message };
  }
}
