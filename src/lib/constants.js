/**
 * 全局常量、消息协议与服务商元数据（Lead 维护）。
 * Service Worker 与扩展页面（popup / options）通过 ES Module 引用本文件。
 *
 * ⚠️ content script 是经典脚本（无法 import），其中消息字符串必须与 MSG 的值逐字一致，
 *    tests/integration.test.mjs 会校验这一点。
 */

export const VERSION = '1.0.0';
export const SETTINGS_KEY = 'techTermsTranslator.settings';
export const CACHE_MAX_ENTRIES = 3000;
export const MAX_SELECTION_CHARS = 5000;
export const MAX_BATCH_TEXTS = 80;
export const MAX_BATCH_CHARS = 12000;
export const MAX_SINGLE_TEXT_CHARS = 6000;
export const GLOSSARY_PROMPT_LIMIT = 80;

/** 扩展内消息类型（runtime / tabs 消息统一使用字符串常量） */
export const MSG = Object.freeze({
  // content -> background
  PING: 'dsh:ping',
  GET_SETTINGS: 'dsh:get-settings',
  GET_GLOSSARY: 'dsh:get-glossary',
  TRANSLATE_BATCH: 'dsh:translate-batch',
  TRANSLATE_SELECTION: 'dsh:translate-selection',
  OPEN_OPTIONS: 'dsh:open-options',
  // popup / options -> background
  TEST_PROVIDER: 'dsh:test-provider',
  CLEAR_CACHE: 'dsh:clear-cache',
  // popup / background -> content
  PAGE_TRANSLATE: 'dsh:page-translate',
  PAGE_RESTORE: 'dsh:page-restore',
  PAGE_STATUS: 'dsh:page-status',
  PAGE_SET_MODE: 'dsh:page-set-mode',
  SELECTION_TRANSLATE: 'dsh:selection-translate',
});

/** 目标语言（provider 层负责映射到各家代码） */
export const TARGET_LANGS = Object.freeze([
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'en', label: 'English' },
  { code: 'ja', label: '日本語' },
  { code: 'ko', label: '한국어' },
]);

/** 整页翻译展示模式 */
export const PAGE_MODES = Object.freeze([
  { id: 'bilingual', label: '双语对照', description: '在原文下方插入译文' },
  { id: 'replace', label: '仅显示译文', description: '隐藏原文，只显示译文' },
]);

/** 划词翻译触发方式 */
export const SELECTION_TRIGGERS = Object.freeze([
  { id: 'button', label: '选中后显示"译"按钮' },
  { id: 'auto', label: '选中后自动翻译' },
]);

/**
 * 服务商元数据。fields 用于 options 页面通用表单渲染：
 *   { key, label, type: 'text'|'password'|'email', placeholder, required, help }
 * kind: llm（大模型，按术语表提示翻译）| mt（机器翻译，术语占位符保护）| local（离线词典）
 */
export const PROVIDER_ORDER = Object.freeze([
  'bing-free',
  'deepseek',
  'azure',
  'openai-compatible',
  'mymemory',
  'glossary',
  'google-free',
]);

export const PROVIDER_META = Object.freeze({
  'bing-free': Object.freeze({
    id: 'bing-free',
    label: '必应翻译（免费 · 免密钥）',
    kind: 'mt',
    needsKey: false,
    description: '免配置即可使用，中文网络可直接访问。调用必应翻译网页接口（非官方），可能随服务调整而失效。',
    fields: Object.freeze([]),
    docs: 'https://cn.bing.com/translator',
  }),
  deepseek: Object.freeze({
    id: 'deepseek',
    label: 'DeepSeek（推荐 · 术语最准）',
    kind: 'llm',
    needsKey: true,
    description: '大模型翻译，会把内置术语表作为硬性约束注入提示词，技术文档准确度最高；按 token 计费，价格低。',
    fields: Object.freeze([
      Object.freeze({ key: 'apiKey', label: 'API Key', type: 'password', required: true, placeholder: 'sk-...' }),
      Object.freeze({ key: 'baseUrl', label: '接口地址', type: 'text', required: true, placeholder: 'https://api.deepseek.com/v1' }),
      Object.freeze({ key: 'model', label: '模型名称', type: 'text', required: true, placeholder: 'deepseek-chat' }),
    ]),
    docs: 'https://platform.deepseek.com/api_keys',
  }),
  azure: Object.freeze({
    id: 'azure',
    label: 'Azure AI 翻译（微软官方）',
    kind: 'mt',
    needsKey: true,
    description: '微软官方 Translator API，每月 200 万字符免费额度，稳定且术语准确；需要 Azure 订阅密钥与区域。',
    fields: Object.freeze([
      Object.freeze({ key: 'apiKey', label: '订阅密钥', type: 'password', required: true, placeholder: 'Azure Translator Key' }),
      Object.freeze({ key: 'region', label: '区域', type: 'text', required: true, placeholder: 'eastasia' }),
      Object.freeze({ key: 'endpoint', label: '接口地址', type: 'text', required: false, placeholder: 'https://api.cognitive.microsofttranslator.com' }),
    ]),
    docs: 'https://learn.microsoft.com/azure/ai-services/translator/',
  }),
  'openai-compatible': Object.freeze({
    id: 'openai-compatible',
    label: 'OpenAI 兼容接口（自定义）',
    kind: 'llm',
    needsKey: true,
    description: '任何兼容 OpenAI Chat Completions 的服务，例如硅基流动、Kimi、智谱、Ollama、LM Studio 本地模型等。',
    fields: Object.freeze([
      Object.freeze({ key: 'apiKey', label: 'API Key', type: 'password', required: false, placeholder: '本地模型可留空' }),
      Object.freeze({ key: 'baseUrl', label: '接口地址', type: 'text', required: true, placeholder: 'https://api.openai.com/v1' }),
      Object.freeze({ key: 'model', label: '模型名称', type: 'text', required: true, placeholder: 'gpt-4o-mini' }),
    ]),
    docs: '',
  }),
  mymemory: Object.freeze({
    id: 'mymemory',
    label: 'MyMemory（免费 · 有额度）',
    kind: 'mt',
    needsKey: false,
    description: '免费公共记忆库接口，无需密钥，适合兜底；匿名每日额度有限，质量一般。',
    fields: Object.freeze([
      Object.freeze({ key: 'email', label: '联系邮箱（可选，提高免费额度）', type: 'email', required: false, placeholder: 'you@example.com' }),
    ]),
    docs: 'https://mymemory.translated.net/doc/spec.php',
  }),
  glossary: Object.freeze({
    id: 'glossary',
    label: '仅术语词典（离线）',
    kind: 'local',
    needsKey: false,
    description: '不联网，只把命中的专业术语替换为中文，其余内容保留原文，适合快速理解关键词。',
    fields: Object.freeze([]),
    docs: '',
  }),
  'google-free': Object.freeze({
    id: 'google-free',
    label: 'Google 翻译（免费 · 需可访问）',
    kind: 'mt',
    needsKey: false,
    description: 'Google 翻译公开接口，无需密钥，速度快；中国大陆网络通常无法访问。',
    fields: Object.freeze([]),
    docs: 'https://translate.google.com/',
  }),
});

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/** 默认设置（保存在 chrome.storage.local 的 SETTINGS_KEY 下） */
export const DEFAULT_SETTINGS = deepFreeze({
  version: 1,
  provider: 'bing-free',
  targetLang: 'zh-CN',
  pageMode: 'bilingual',
  enforceTerms: true,
  highlightTerms: true,
  selectionEnabled: true,
  selectionTrigger: 'button',
  cacheEnabled: true,
  batchCharLimit: 3000,
  glossaryLimit: GLOSSARY_PROMPT_LIMIT,
  freeFallback: true,
  excludedSites: [],
  customTerms: [],
  providers: {
    'bing-free': {},
    'google-free': {},
    deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    'openai-compatible': { apiKey: '', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    azure: { apiKey: '', region: 'eastasia', endpoint: 'https://api.cognitive.microsofttranslator.com' },
    mymemory: { email: '' },
    glossary: {},
  },
});
