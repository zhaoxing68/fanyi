/**
 * Service Worker（Lead 维护）：消息路由、翻译缓存、术语表缓存、右键菜单、快捷键、
 * content script 注入兜底、首次安装初始化。
 */

import {
  MSG,
  VERSION,
  CACHE_MAX_ENTRIES,
  MAX_SELECTION_CHARS,
  MAX_BATCH_TEXTS,
  MAX_BATCH_CHARS,
  MAX_SINGLE_TEXT_CHARS,
} from './lib/constants.js';
import { getSettings, saveSettings, toPublicSettings, providerLabel } from './lib/settings.js';
import { GLOSSARY, withCustomTerms, findTerms, getCategories } from './lib/glossary.js';
import { translateBatch, translateText, testProvider } from './lib/translator.js';

const MENU_TRANSLATE_SELECTION = 'dsh-translate-selection';
const MENU_TRANSLATE_PAGE = 'dsh-translate-page';
const MENU_RESTORE_PAGE = 'dsh-restore-page';

/* ------------------------------ 工具函数 ------------------------------ */

function extensionVersion() {
  try {
    return chrome.runtime.getManifest().version || VERSION;
  } catch (error) {
    return VERSION;
  }
}

function createAppError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function serializeError(error) {
  if (!error) return { code: 'UNKNOWN_ERROR', message: '翻译失败，请稍后重试' };
  const code = typeof error.code === 'string' && error.code ? error.code : 'UNKNOWN_ERROR';
  let message = error.message ? String(error.message) : '翻译失败，请稍后重试';
  if (code === 'UNKNOWN_ERROR' && /Failed to fetch|NetworkError|network|abort/i.test(message)) {
    message = '网络请求失败，请检查网络连接，或在设置中更换翻译服务商';
  }
  return { code, message, provider: error.provider || '' };
}

/* ---------------------------- 术语表（缓存） ---------------------------- */

let glossaryMemo = { key: null, entries: GLOSSARY };

function getEffectiveGlossary(settings) {
  const customTerms = settings && Array.isArray(settings.customTerms) ? settings.customTerms : [];
  const key = JSON.stringify(customTerms);
  if (glossaryMemo.key !== key) {
    glossaryMemo = { key, entries: withCustomTerms(customTerms) };
  }
  return glossaryMemo.entries;
}

/* --------------------------- 翻译缓存（LRU） --------------------------- */

const translationCache = new Map();

function makeCachePrefix(settings) {
  const customTerms = settings && Array.isArray(settings.customTerms) ? settings.customTerms : [];
  const enforceTerms = settings && settings.enforceTerms === false ? '0' : '1';
  return String(settings.provider || '') + '|' + String(settings.targetLang || '') + '|' + enforceTerms + '|' + JSON.stringify(customTerms);
}

function makeCacheKey(settings, text) {
  return makeCachePrefix(settings) + '|' + text;
}

function cacheGet(key) {
  if (!translationCache.has(key)) return undefined;
  const value = translationCache.get(key);
  translationCache.delete(key);
  translationCache.set(key, value);
  return value;
}

function cacheSet(key, value) {
  if (translationCache.has(key)) translationCache.delete(key);
  translationCache.set(key, value);
  while (translationCache.size > CACHE_MAX_ENTRIES) {
    const oldest = translationCache.keys().next().value;
    translationCache.delete(oldest);
  }
}

/* ----------------------------- 翻译执行 ----------------------------- */

async function translateTextsWithCache(texts, settings, glossary) {
  const providerId = settings.provider;
  const useCache = settings.cacheEnabled !== false;
  const results = new Array(texts.length);
  const pendingTexts = [];
  const pendingIndexes = [];

  for (let index = 0; index < texts.length; index++) {
    const text = texts[index];
    if (!text) {
      results[index] = '';
      continue;
    }
    const key = makeCacheKey(settings, text);
    const cached = useCache ? cacheGet(key) : undefined;
    if (cached !== undefined) {
      results[index] = cached;
    } else {
      pendingTexts.push(text);
      pendingIndexes.push(index);
    }
  }

  const warnings = [];
  if (pendingTexts.length > 0) {
    const outcome = await translateBatch(pendingTexts, { settings, glossary });
    const translations = outcome && Array.isArray(outcome.translations) ? outcome.translations : [];
    for (let index = 0; index < pendingTexts.length; index++) {
      const text = pendingTexts[index];
      const translation = typeof translations[index] === 'string' ? translations[index] : '';
      results[pendingIndexes[index]] = translation;
      if (useCache && translation) cacheSet(makeCacheKey(settings, text), translation);
    }
    if (outcome && Array.isArray(outcome.warnings)) warnings.push(...outcome.warnings);
  }

  return { translations: results, warnings };
}

/* ----------------------------- 消息处理 ----------------------------- */

async function handleGetGlossary() {
  const settings = await getSettings();
  const glossary = getEffectiveGlossary(settings);
  return {
    ok: true,
    version: extensionVersion(),
    total: glossary.length,
    categories: getCategories(glossary),
    entries: glossary.map((entry) => ({
      en: entry.en,
      zh: entry.zh,
      category: entry.category,
      note: entry.note,
      pos: entry.pos,
      noEnforce: entry.noEnforce,
    })),
  };
}

async function handleTranslateBatch(message) {
  const raw = Array.isArray(message.texts) ? message.texts : [];
  if (raw.length === 0) {
    return { ok: true, translations: [], provider: '', providerId: '', warnings: [] };
  }
  if (raw.length > MAX_BATCH_TEXTS) {
    throw createAppError('BATCH_TOO_LARGE', '单次翻译文本过多（最多 ' + MAX_BATCH_TEXTS + ' 条），请重试');
  }
  const texts = raw.map((item) => (typeof item === 'string' ? item : String(item == null ? '' : item)));
  let totalChars = 0;
  for (const text of texts) {
    totalChars += text.length;
    if (text.length > MAX_SINGLE_TEXT_CHARS) {
      throw createAppError('TEXT_TOO_LONG', '单段文本过长（超过 ' + MAX_SINGLE_TEXT_CHARS + ' 字符），请分段翻译');
    }
  }
  if (totalChars > MAX_BATCH_CHARS) {
    throw createAppError('BATCH_TOO_LARGE', '单次翻译内容过长，请稍后重试');
  }

  const settings = await getSettings();
  const glossary = getEffectiveGlossary(settings);
  const outcome = await translateTextsWithCache(texts, settings, glossary);
  return {
    ok: true,
    translations: outcome.translations,
    provider: providerLabel(settings.provider),
    providerId: settings.provider,
    warnings: outcome.warnings,
  };
}

async function handleTranslateSelection(message) {
  const text = typeof message.text === 'string' ? message.text.trim() : '';
  if (!text) throw createAppError('EMPTY_TEXT', '没有可翻译的内容');
  if (text.length > MAX_SELECTION_CHARS) {
    throw createAppError('TEXT_TOO_LONG', '选中的文字过长（最多 ' + MAX_SELECTION_CHARS + ' 字符），请缩短选区');
  }

  const settings = await getSettings();
  const glossary = getEffectiveGlossary(settings);
  const useCache = settings.cacheEnabled !== false;
  const key = makeCacheKey(settings, text);
  let translation = useCache ? cacheGet(key) : undefined;
  const cached = translation !== undefined;
  const warnings = [];

  if (translation === undefined) {
    const outcome = await translateText(text, { settings, glossary });
    translation = outcome && typeof outcome.translation === 'string' ? outcome.translation : '';
    if (outcome && Array.isArray(outcome.warnings)) warnings.push(...outcome.warnings);
    if (useCache && translation) cacheSet(key, translation);
  }

  const matches = findTerms(text, glossary, { maxMatches: 16 });
  const seen = new Set();
  const terms = [];
  for (const item of matches) {
    const entry = item.entry;
    if (seen.has(entry.en)) continue;
    seen.add(entry.en);
    terms.push({ en: entry.en, zh: entry.zh, note: entry.note, category: entry.category });
    if (terms.length >= 8) break;
  }

  return {
    ok: true,
    translation,
    provider: providerLabel(settings.provider),
    providerId: settings.provider,
    terms,
    warnings,
    cached,
  };
}

async function handleTestProvider(message) {
  const settings = await getSettings();
  const providerId = typeof message.providerId === 'string' && message.providerId ? message.providerId : settings.provider;
  let result;
  try {
    result = await testProvider(providerId, settings);
  } catch (error) {
    return { ok: false, message: serializeError(error).message, error: serializeError(error) };
  }
  if (result && result.ok) {
    return { ok: true, message: result.message || '连接成功', sample: result.sample || '' };
  }
  const messageText = (result && result.message) || '连接失败，请检查配置';
  return { ok: false, message: messageText, error: { code: 'PROVIDER_TEST_FAILED', message: messageText } };
}

async function handleMessage(message) {
  if (!message || typeof message.type !== 'string') {
    return { ok: false, error: { code: 'BAD_MESSAGE', message: '无效的消息格式' } };
  }

  switch (message.type) {
    case MSG.PING:
      return { ok: true, version: extensionVersion() };

    case MSG.GET_SETTINGS: {
      const settings = await getSettings();
      return { ok: true, settings: toPublicSettings(settings) };
    }

    case MSG.GET_GLOSSARY:
      return handleGetGlossary();

    case MSG.TRANSLATE_BATCH:
      return handleTranslateBatch(message);

    case MSG.TRANSLATE_SELECTION:
      return handleTranslateSelection(message);

    case MSG.TEST_PROVIDER:
      return handleTestProvider(message);

    case MSG.CLEAR_CACHE:
      translationCache.clear();
      return { ok: true, message: '翻译缓存已清空' };

    case MSG.OPEN_OPTIONS: {
      try {
        chrome.runtime.openOptionsPage();
      } catch (error) {
        // 忽略：部分测试环境没有该 API
      }
      return { ok: true };
    }

    default:
      return {
        ok: false,
        error: { code: 'UNKNOWN_MESSAGE', message: '未知的消息类型：' + message.type },
      };
  }
}

/* --------------------------- content 通信 --------------------------- */

async function sendToTab(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    const injected = await ensureContentScript(tabId);
    if (!injected) {
      return {
        ok: false,
        error: {
          code: 'CONTENT_SCRIPT_UNAVAILABLE',
          message: '当前页面无法使用翻译功能（可能是浏览器内部页面或受限页面），请刷新页面后重试',
        },
      };
    }
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (retryError) {
      return { ok: false, error: serializeError(retryError) };
    }
  }
}

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: MSG.PING });
    if (pong && pong.ok) return true;
  } catch (error) {
    // 尚未注入，继续尝试注入
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['src/content/content.css'] });
  } catch (error) {
    // 已存在样式时忽略
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['src/content/content.js'] });
    return true;
  } catch (error) {
    return false;
  }
}

async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs && tabs.length > 0 ? tabs[0] : null;
  } catch (error) {
    return null;
  }
}

/* ---------------------------- 右键菜单 ---------------------------- */

function createContextMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_TRANSLATE_SELECTION, title: '翻译所选内容', contexts: ['selection'] });
    chrome.contextMenus.create({ id: MENU_TRANSLATE_PAGE, title: '翻译此页面（双语对照）', contexts: ['page'] });
    chrome.contextMenus.create({ id: MENU_RESTORE_PAGE, title: '还原原文', contexts: ['page'] });
  });
}

/* ---------------------------- 事件注册 ---------------------------- */

function registerEventListeners() {
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      handleMessage(message, sender)
        .then((response) => sendResponse(response))
        .catch((error) => sendResponse({ ok: false, error: serializeError(error) }));
      return true;
    });
  }

  if (chrome.runtime && chrome.runtime.onInstalled) {
    chrome.runtime.onInstalled.addListener((details) => {
      createContextMenus();
      if (details && details.reason === 'install') {
        (async () => {
          try {
            const current = await getSettings();
            await saveSettings(current);
          } catch (error) {
            // 初始化失败不影响后续读取（getSettings 会回退默认值）
          }
          try {
            if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
          } catch (error) {
            // 忽略
          }
        })();
      }
    });
  }

  if (chrome.contextMenus && chrome.contextMenus.onClicked) {
    chrome.contextMenus.onClicked.addListener((info, tab) => {
      if (!tab || typeof tab.id !== 'number') return;
      if (info.menuItemId === MENU_TRANSLATE_SELECTION) {
        sendToTab(tab.id, { type: MSG.SELECTION_TRANSLATE });
      } else if (info.menuItemId === MENU_TRANSLATE_PAGE) {
        sendToTab(tab.id, { type: MSG.PAGE_TRANSLATE });
      } else if (info.menuItemId === MENU_RESTORE_PAGE) {
        sendToTab(tab.id, { type: MSG.PAGE_RESTORE });
      }
    });
  }

  if (chrome.commands && chrome.commands.onCommand) {
    chrome.commands.onCommand.addListener(async (command, tab) => {
      const targetTab = tab && typeof tab.id === 'number' ? tab : await getActiveTab();
      if (!targetTab || typeof targetTab.id !== 'number') return;
      if (command === 'translate-page') {
        const status = await sendToTab(targetTab.id, { type: MSG.PAGE_STATUS });
        if (status && status.ok && status.active) {
          await sendToTab(targetTab.id, { type: MSG.PAGE_RESTORE });
        } else {
          await sendToTab(targetTab.id, { type: MSG.PAGE_TRANSLATE });
        }
      } else if (command === 'translate-selection') {
        await sendToTab(targetTab.id, { type: MSG.SELECTION_TRANSLATE });
      }
    });
  }
}

registerEventListeners();
