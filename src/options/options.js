/**
 * 术语精准翻译 · options 脚本（ES Module）
 * 职责：渲染并保存全部设置（服务商 / 翻译设置 / 术语表 / 站点排除 / 关于）。
 * 所有服务商列表、语言、模式等选项均来自 constants.js，不在页面里写死。
 */

import {
  VERSION,
  MSG,
  PROVIDER_META,
  PROVIDER_ORDER,
  TARGET_LANGS,
  PAGE_MODES,
  SELECTION_TRIGGERS,
  DEFAULT_SETTINGS,
} from '../lib/constants.js';
import { getSettings, saveSettings, clone } from '../lib/settings.js';
import { GLOSSARY, GLOSSARY_STATS, getCategories, searchGlossary, normalizeTerm } from '../lib/glossary.js';

const SECTION_NAMES = ['provider', 'translation', 'glossary', 'excluded', 'about'];
const CUSTOM_EN_MAX = 120;
const CUSTOM_ZH_MAX = 200;
const SEARCH_DEBOUNCE_MS = 160;

const state = {
  settings: null,
  draft: null,
  dirty: false,
  saving: false,
  page: 1,
  pageSize: 50,
  query: '',
  category: '',
  excludedText: '',
  currentSection: 'provider',
};

const dom = {};

let toastTimer = 0;
let searchTimer = 0;

function $(id) {
  return document.getElementById(id);
}

/* ================================================================
 * 初始化
 * ================================================================ */

function cacheDom() {
  dom.sidebarVersion = $('sidebar-version');
  dom.saveBtn = $('save-btn');
  dom.saveHint = $('save-hint');
  dom.dirtyHint = $('dirty-hint');

  dom.providerList = $('provider-list');
  dom.providerDetail = $('provider-detail');
  dom.providerDetailTitle = $('provider-detail-title');
  dom.providerDetailDesc = $('provider-detail-desc');
  dom.providerDetailKind = $('provider-detail-kind');
  dom.providerFields = $('provider-fields');
  dom.testBtn = $('test-btn');
  dom.providerDocs = $('provider-docs');
  dom.testResult = $('test-result');

  dom.targetLang = $('target-lang');
  dom.pageModeGroup = $('page-mode-group');
  dom.selectionTrigger = $('selection-trigger');
  dom.batchCharLimit = $('batch-char-limit');
  dom.batchCharOutput = $('batch-char-output');

  dom.enforceTerms = $('enforce-terms');
  dom.highlightTerms = $('highlight-terms');
  dom.selectionEnabled = $('selection-enabled');
  dom.cacheEnabled = $('cache-enabled');
  dom.freeFallback = $('free-fallback');

  dom.glossaryTotal = $('glossary-total');
  dom.glossaryCategoryCount = $('glossary-category-count');
  dom.glossaryStats = $('glossary-stats');
  dom.glossarySearch = $('glossary-search');
  dom.glossaryCategory = $('glossary-category');
  dom.glossaryCount = $('glossary-count');
  dom.glossaryRows = $('glossary-rows');
  dom.glossaryPageInfo = $('glossary-page-info');
  dom.glossaryPrev = $('glossary-prev');
  dom.glossaryNext = $('glossary-next');

  dom.customCount = $('custom-count');
  dom.customEn = $('custom-en');
  dom.customZh = $('custom-zh');
  dom.customNote = $('custom-note');
  dom.customAdd = $('custom-add');
  dom.customError = $('custom-error');
  dom.customRows = $('custom-rows');
  dom.termsExport = $('terms-export');
  dom.termsImport = $('terms-import');

  dom.excludedSites = $('excluded-sites');
  dom.excludedHint = $('excluded-hint');
  dom.clearExcluded = $('clear-excluded');

  dom.aboutVersion = $('about-version');
  dom.aboutGlossary = $('about-glossary');
  dom.aboutCustom = $('about-custom');
  dom.aboutExcluded = $('about-excluded');
  dom.clearCache = $('clear-cache');
  dom.resetAll = $('reset-all');

  dom.toast = $('toast');

  dom.providerCardTemplate = $('provider-card-template');
  dom.providerFieldTemplate = $('provider-field-template');
  dom.termRowTemplate = $('term-row-template');
  dom.customTermTemplate = $('custom-term-template');
}

async function init() {
  cacheDom();
  dom.sidebarVersion.textContent = 'v' + VERSION;
  bindNav();
  bindEvents();

  try {
    const settings = await getSettings();
    state.settings = settings;
    state.draft = clone(settings);
    state.excludedText = (state.draft.excludedSites || []).join('\n');
  } catch (error) {
    state.settings = clone(DEFAULT_SETTINGS);
    state.draft = clone(DEFAULT_SETTINGS);
    state.excludedText = '';
    showToast('读取设置失败，已载入默认设置', 'error');
  }

  renderAll();
  markDirty(false);

  const hash = String(location.hash || '').replace('#', '');
  showSection(SECTION_NAMES.indexOf(hash) >= 0 ? hash : 'provider');
}

/* ================================================================
 * 通用工具
 * ================================================================ */

function showToast(message, kind) {
  if (!message) return;
  dom.toast.textContent = message;
  dom.toast.dataset.kind = kind || 'info';
  dom.toast.hidden = false;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(function () {
    toastTimer = 0;
    dom.toast.hidden = true;
  }, 3600);
}

function markDirty(value) {
  state.dirty = value === undefined ? true : Boolean(value);
  dom.dirtyHint.hidden = !state.dirty;
  dom.saveHint.hidden = state.dirty;
}

function runtimeMessage(message) {
  return new Promise(function (resolve, reject) {
    try {
      chrome.runtime.sendMessage(message, function (response) {
        const runtimeError = chrome.runtime && chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || '消息发送失败'));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function errorMessageOf(response) {
  if (response && response.error) {
    if (typeof response.error.message === 'string' && response.error.message.trim()) return response.error.message.trim();
    if (typeof response.error.code === 'string') return '错误代码：' + response.error.code;
  }
  if (response && typeof response.message === 'string' && response.message.trim()) return response.message.trim();
  return '操作失败，请稍后重试';
}

function kindLabel(kind) {
  if (kind === 'llm') return 'AI 大模型';
  if (kind === 'mt') return '机器翻译';
  if (kind === 'local') return '离线词典';
  return '其他';
}

/* ================================================================
 * 导航
 * ================================================================ */

function bindNav() {
  const items = document.querySelectorAll('.nav-item[data-section]');
  for (let index = 0; index < items.length; index += 1) {
    const button = items[index];
    button.addEventListener('click', function () {
      showSection(button.dataset.section);
    });
  }
}

function showSection(name) {
  const target = SECTION_NAMES.indexOf(name) >= 0 ? name : 'provider';
  state.currentSection = target;
  const items = document.querySelectorAll('.nav-item[data-section]');
  for (let index = 0; index < items.length; index += 1) {
    const button = items[index];
    const active = button.dataset.section === target;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-current', active ? 'page' : 'false');
  }
  const sections = document.querySelectorAll('.section');
  for (let index = 0; index < sections.length; index += 1) {
    const section = sections[index];
    section.hidden = section.id !== 'section-' + target;
  }
  try {
    history.replaceState(null, '', '#' + target);
  } catch (error) {
    // 忽略
  }
  window.scrollTo({ top: 0, behavior: 'auto' });
}

/* ================================================================
 * 表单渲染
 * ================================================================ */

function renderAll() {
  renderProviderCards();
  renderProviderDetail();
  renderTranslationForm();
  renderExcluded();
  renderCustomTerms();
  renderAbout();
  renderGlossaryCategoryOptions();
  renderGlossaryStats();
  renderGlossaryTable();
}

/* ---------------------------- 服务商 ---------------------------- */

function renderProviderCards() {
  dom.providerList.textContent = '';
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < PROVIDER_ORDER.length; index += 1) {
    const id = PROVIDER_ORDER[index];
    const meta = PROVIDER_META[id];
    if (!meta) continue;
    const node = dom.providerCardTemplate.content.firstElementChild.cloneNode(true);
    const radio = node.querySelector('.provider-radio');
    radio.value = id;
    radio.id = 'provider-' + id;
    radio.name = 'provider';
    radio.checked = state.draft.provider === id;
    node.querySelector('.provider-card-name').textContent = meta.label;
    node.querySelector('.provider-card-kind').textContent = kindLabel(meta.kind);
    node.querySelector('.provider-card-desc').textContent = meta.description || '';
    const hint = node.querySelector('.provider-card-hint');
    if (meta.needsKey) hint.textContent = '需要 API Key';
    else if (meta.kind === 'local') hint.textContent = '完全离线';
    else hint.textContent = '免密钥';
    fragment.appendChild(node);
  }
  dom.providerList.appendChild(fragment);
}

function selectProvider(id) {
  if (!metaExists(id) || state.draft.provider === id) return;
  state.draft.provider = id;
  if (!state.draft.providers[id]) state.draft.providers[id] = {};
  markDirty(true);
  renderProviderDetail();
}

function metaExists(id) {
  return Boolean(id) && Object.prototype.hasOwnProperty.call(PROVIDER_META, id);
}

function renderProviderDetail() {
  const id = state.draft.provider;
  const meta = PROVIDER_META[id];
  if (!meta) {
    dom.providerDetail.hidden = true;
    return;
  }
  dom.providerDetail.hidden = false;
  dom.providerDetailTitle.textContent = meta.label;
  dom.providerDetailDesc.textContent = meta.description || '';
  dom.providerDetailKind.textContent = kindLabel(meta.kind);
  dom.providerFields.textContent = '';

  if (!state.draft.providers[id]) state.draft.providers[id] = {};
  const config = state.draft.providers[id];

  if (!meta.fields || meta.fields.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '该服务商无需任何配置，选择后即可直接使用。';
    dom.providerFields.appendChild(empty);
  } else {
    for (let index = 0; index < meta.fields.length; index += 1) {
      dom.providerFields.appendChild(buildProviderField(meta, meta.fields[index], config));
    }
  }

  dom.testBtn.hidden = meta.kind === 'local';
  dom.providerDocs.hidden = !meta.docs;
  if (meta.docs) dom.providerDocs.href = meta.docs;
  setTestResult('', '');
}

function buildProviderField(meta, field, config) {
  const node = dom.providerFieldTemplate.content.firstElementChild.cloneNode(true);
  const label = node.querySelector('.field-label');
  label.textContent = field.label + (field.required ? ' *' : '');
  label.setAttribute('for', 'provider-field-' + field.key);

  const input = node.querySelector('.field-input');
  input.id = 'provider-field-' + field.key;
  input.dataset.fieldKey = field.key;
  input.type = field.type === 'password' ? 'password' : field.type === 'email' ? 'email' : 'text';
  input.value = String(config[field.key] || '');
  input.placeholder = field.placeholder || '';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.addEventListener('input', function () {
    config[field.key] = input.value;
    markDirty(true);
  });

  const help = node.querySelector('.field-help');
  help.textContent = field.required ? '必填' : '可选';

  if (field.type === 'password') {
    const toggle = node.querySelector('.field-toggle');
    toggle.hidden = false;
    toggle.addEventListener('click', function () {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      toggle.textContent = showing ? '显示' : '隐藏';
    });
  }
  return node;
}

function setTestResult(kind, message) {
  if (!dom.testResult) return;
  dom.testResult.dataset.kind = kind || '';
  dom.testResult.textContent = message || '';
}

/* ---------------------------- 翻译设置 ---------------------------- */

function renderTranslationForm() {
  dom.targetLang.textContent = '';
  for (let index = 0; index < TARGET_LANGS.length; index += 1) {
    const lang = TARGET_LANGS[index];
    const option = document.createElement('option');
    option.value = lang.code;
    option.textContent = lang.label;
    dom.targetLang.appendChild(option);
  }
  dom.targetLang.value = state.draft.targetLang;

  dom.pageModeGroup.textContent = '';
  for (let index = 0; index < PAGE_MODES.length; index += 1) {
    const mode = PAGE_MODES[index];
    const label = document.createElement('label');
    label.className = 'choice';
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'page-mode';
    input.value = mode.id;
    input.checked = state.draft.pageMode === mode.id;
    input.addEventListener('change', function () {
      if (!input.checked) return;
      state.draft.pageMode = mode.id;
      markDirty(true);
    });
    const body = document.createElement('span');
    body.className = 'choice-body';
    const title = document.createElement('span');
    title.className = 'choice-title';
    title.textContent = mode.label;
    const desc = document.createElement('span');
    desc.className = 'choice-desc';
    desc.textContent = mode.description || '';
    body.appendChild(title);
    body.appendChild(desc);
    label.appendChild(input);
    label.appendChild(body);
    dom.pageModeGroup.appendChild(label);
  }

  dom.selectionTrigger.textContent = '';
  for (let index = 0; index < SELECTION_TRIGGERS.length; index += 1) {
    const trigger = SELECTION_TRIGGERS[index];
    const option = document.createElement('option');
    option.value = trigger.id;
    option.textContent = trigger.label;
    dom.selectionTrigger.appendChild(option);
  }
  dom.selectionTrigger.value = state.draft.selectionTrigger;
  dom.selectionTrigger.disabled = state.draft.selectionEnabled === false;

  dom.enforceTerms.checked = state.draft.enforceTerms !== false;
  dom.highlightTerms.checked = state.draft.highlightTerms !== false;
  dom.selectionEnabled.checked = state.draft.selectionEnabled !== false;
  dom.cacheEnabled.checked = state.draft.cacheEnabled !== false;
  dom.freeFallback.checked = state.draft.freeFallback !== false;

  dom.batchCharLimit.value = String(state.draft.batchCharLimit);
  dom.batchCharOutput.textContent = String(state.draft.batchCharLimit);
}

/* ---------------------------- 站点排除 ---------------------------- */

function parseExcludedSites(text) {
  const lines = String(text || '').split(/\r?\n/);
  const sites = [];
  const invalid = [];
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (!raw) continue;
    const host = raw
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .replace(/^\*\./, '')
      .trim()
      .toLowerCase();
    if (isValidHost(host)) {
      if (sites.indexOf(host) < 0) sites.push(host);
    } else {
      invalid.push(raw);
    }
  }
  return { sites: sites, invalid: invalid };
}

function isValidHost(host) {
  if (!host || host.length > 253) return false;
  if (host === 'localhost') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split('.').every(function (part) {
      return Number(part) <= 255;
    });
  }
  if (/^\[[0-9a-f:]+\]$/i.test(host)) return true;
  return /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/i.test(host);
}

function updateExcludedHint() {
  const parsed = parseExcludedSites(state.excludedText);
  if (parsed.invalid.length > 0) {
    dom.excludedHint.textContent = parsed.invalid.length + ' 行格式有误：' + parsed.invalid.slice(0, 2).join('、');
    dom.excludedHint.classList.add('is-error');
    return;
  }
  dom.excludedHint.classList.remove('is-error');
  dom.excludedHint.textContent = parsed.sites.length > 0
    ? '已填写 ' + parsed.sites.length + ' 个站点，每行一个域名'
    : '每行一个域名，支持子域名匹配';
}

function renderExcluded() {
  dom.excludedSites.value = state.excludedText;
  updateExcludedHint();
}

/* ---------------------------- 自定义术语 ---------------------------- */

function renderCustomTerms() {
  const list = Array.isArray(state.draft.customTerms) ? state.draft.customTerms : [];
  dom.customCount.textContent = list.length + ' 条';
  dom.customRows.textContent = '';
  if (list.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = '还没有自定义术语。添加后会覆盖同名内置术语。';
    dom.customRows.appendChild(empty);
    return;
  }
  for (let index = 0; index < list.length; index += 1) {
    const term = list[index];
    const node = dom.customTermTemplate.content.firstElementChild.cloneNode(true);
    const enInput = node.querySelector('.ct-en');
    const zhInput = node.querySelector('.ct-zh');
    const noteInput = node.querySelector('.ct-note');
    enInput.value = term.en || '';
    zhInput.value = term.zh || '';
    noteInput.value = term.note || '';
    enInput.addEventListener('input', function () {
      term.en = enInput.value;
      markDirty(true);
    });
    zhInput.addEventListener('input', function () {
      term.zh = zhInput.value;
      markDirty(true);
    });
    noteInput.addEventListener('input', function () {
      term.note = noteInput.value;
      markDirty(true);
    });
    const removeButton = node.querySelector('.ct-remove');
    removeButton.addEventListener('click', function () {
      state.draft.customTerms.splice(index, 1);
      markDirty(true);
      renderCustomTerms();
    });
    dom.customRows.appendChild(node);
  }
}

function setCustomError(message) {
  if (!message) {
    dom.customError.hidden = true;
    dom.customError.textContent = '';
    return;
  }
  dom.customError.hidden = false;
  dom.customError.textContent = message;
}

function addCustomTerm() {
  if (!Array.isArray(state.draft.customTerms)) state.draft.customTerms = [];
  const en = dom.customEn.value.trim();
  const zh = dom.customZh.value.trim();
  const note = dom.customNote.value.trim();
  if (!en || !zh) {
    setCustomError('英文与中文都不能为空');
    return;
  }
  if (en.length > CUSTOM_EN_MAX || zh.length > CUSTOM_ZH_MAX) {
    setCustomError('英文不超过 ' + CUSTOM_EN_MAX + ' 字符，中文不超过 ' + CUSTOM_ZH_MAX + ' 字符');
    return;
  }
  const normalized = normalizeTerm(en);
  let existingIndex = -1;
  for (let index = 0; index < state.draft.customTerms.length; index += 1) {
    if (normalizeTerm(state.draft.customTerms[index].en) === normalized) {
      existingIndex = index;
      break;
    }
  }
  const entry = { en: en, zh: zh };
  if (note) entry.note = note;
  if (existingIndex >= 0) state.draft.customTerms[existingIndex] = entry;
  else state.draft.customTerms.push(entry);

  dom.customEn.value = '';
  dom.customZh.value = '';
  dom.customNote.value = '';
  setCustomError('');
  markDirty(true);
  renderCustomTerms();
  showToast(existingIndex >= 0 ? '已更新同名自定义术语，保存后生效' : '已添加自定义术语，保存后生效');
}

function sanitizeCustomTerms() {
  const list = Array.isArray(state.draft.customTerms) ? state.draft.customTerms : [];
  const map = new Map();
  for (let index = 0; index < list.length; index += 1) {
    const raw = list[index] || {};
    const en = String(raw.en || '').trim();
    const zh = String(raw.zh || '').trim();
    if (!en || !zh) continue;
    const entry = { en: en, zh: zh };
    const note = String(raw.note || '').trim();
    if (note) entry.note = note;
    map.set(normalizeTerm(en), entry);
  }
  return Array.from(map.values());
}

function exportCustomTerms() {
  const terms = sanitizeCustomTerms();
  if (terms.length === 0) {
    showToast('暂无可导出的自定义术语', 'error');
    return;
  }
  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    terms: terms,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  anchor.href = url;
  anchor.download = 'tech-terms-custom-' + stamp + '.json';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(function () {
    URL.revokeObjectURL(url);
  }, 2000);
  showToast('已导出 ' + terms.length + ' 条自定义术语');
}

async function importCustomTerms(event) {
  const input = event.target;
  const file = input && input.files ? input.files[0] : null;
  if (!file) return;
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    let list = null;
    if (Array.isArray(parsed)) list = parsed;
    else if (parsed && Array.isArray(parsed.terms)) list = parsed.terms;
    else if (parsed && Array.isArray(parsed.customTerms)) list = parsed.customTerms;
    if (!list) throw new Error('JSON 中未找到术语数组');
    if (!Array.isArray(state.draft.customTerms)) state.draft.customTerms = [];
    let imported = 0;
    let ignored = 0;
    for (let index = 0; index < list.length; index += 1) {
      const raw = list[index];
      if (!raw || typeof raw !== 'object') {
        ignored += 1;
        continue;
      }
      const en = String(raw.en || '').trim();
      const zh = String(raw.zh || '').trim();
      if (!en || !zh || en.length > CUSTOM_EN_MAX || zh.length > CUSTOM_ZH_MAX) {
        ignored += 1;
        continue;
      }
      const normalized = normalizeTerm(en);
      let existingIndex = -1;
      for (let termIndex = 0; termIndex < state.draft.customTerms.length; termIndex += 1) {
        if (normalizeTerm(state.draft.customTerms[termIndex].en) === normalized) {
          existingIndex = termIndex;
          break;
        }
      }
      const entry = { en: en, zh: zh };
      const note = String(raw.note || '').trim();
      if (note) entry.note = note;
      if (existingIndex >= 0) state.draft.customTerms[existingIndex] = entry;
      else state.draft.customTerms.push(entry);
      imported += 1;
    }
    markDirty(true);
    renderCustomTerms();
    showToast('已导入 ' + imported + ' 条术语' + (ignored > 0 ? '，忽略 ' + ignored + ' 条无效记录' : '') + '，保存后生效');
  } catch (error) {
    showToast('导入失败：' + (error && error.message ? error.message : '文件格式不正确'), 'error');
  } finally {
    input.value = '';
  }
}

/* ---------------------------- 术语表 ---------------------------- */

function renderGlossaryCategoryOptions() {
  const categories = getCategories(GLOSSARY);
  dom.glossaryCategory.textContent = '';
  const allOption = document.createElement('option');
  allOption.value = '';
  allOption.textContent = '全部分类（' + GLOSSARY_STATS.total + '）';
  dom.glossaryCategory.appendChild(allOption);
  let categoryExists = false;
  for (let index = 0; index < categories.length; index += 1) {
    const item = categories[index];
    const option = document.createElement('option');
    option.value = item.category;
    option.textContent = item.category + '（' + item.count + '）';
    dom.glossaryCategory.appendChild(option);
    if (item.category === state.category) categoryExists = true;
  }
  if (!categoryExists) state.category = '';
  dom.glossaryCategory.value = state.category;
}

function renderGlossaryStats() {
  dom.glossaryTotal.textContent = String(GLOSSARY_STATS.total);
  dom.glossaryCategoryCount.textContent = String(GLOSSARY_STATS.categories.length);
  dom.glossaryStats.textContent = '';
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < GLOSSARY_STATS.categories.length; index += 1) {
    const item = GLOSSARY_STATS.categories[index];
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'stat-chip';
    chip.dataset.category = item.category;
    if (state.category === item.category) chip.classList.add('is-active');
    const name = document.createElement('span');
    name.className = 'stat-chip-name';
    name.textContent = item.category;
    const count = document.createElement('span');
    count.className = 'stat-chip-count';
    count.textContent = String(item.count);
    chip.appendChild(name);
    chip.appendChild(count);
    fragment.appendChild(chip);
  }
  dom.glossaryStats.appendChild(fragment);
}

function updateStatChips() {
  const chips = dom.glossaryStats.querySelectorAll('.stat-chip');
  for (let index = 0; index < chips.length; index += 1) {
    chips[index].classList.toggle('is-active', chips[index].dataset.category === state.category);
  }
}

function getFilteredEntries() {
  const query = state.query.trim();
  const matched = query ? searchGlossary(query, GLOSSARY, GLOSSARY.length) : GLOSSARY;
  if (!state.category) return matched;
  return matched.filter(function (entry) {
    return entry.category === state.category;
  });
}

function renderGlossaryTable() {
  const entries = getFilteredEntries();
  const totalPages = Math.max(1, Math.ceil(entries.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  if (state.page < 1) state.page = 1;
  const start = (state.page - 1) * state.pageSize;
  const pageEntries = entries.slice(start, start + state.pageSize);

  dom.glossaryRows.textContent = '';
  if (pageEntries.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'term-empty';
    empty.textContent = '没有匹配的术语，试试其他关键词或分类。';
    dom.glossaryRows.appendChild(empty);
  } else {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < pageEntries.length; index += 1) {
      const entry = pageEntries[index];
      const node = dom.termRowTemplate.content.firstElementChild.cloneNode(true);
      node.querySelector('.term-en').textContent = entry.en;
      node.querySelector('.term-zh').textContent = entry.zh;
      node.querySelector('.term-category').textContent = entry.category;
      const note = node.querySelector('.term-note');
      note.textContent = entry.note || '';
      note.title = entry.note || '';
      if (entry.noEnforce) {
        const tag = document.createElement('span');
        tag.className = 'term-tag';
        tag.textContent = '不强制';
        node.querySelector('.term-zh').appendChild(tag);
      }
      fragment.appendChild(node);
    }
    dom.glossaryRows.appendChild(fragment);
  }

  dom.glossaryCount.textContent = '共 ' + entries.length + ' 条';
  dom.glossaryPageInfo.textContent = '第 ' + state.page + ' / ' + totalPages + ' 页';
  dom.glossaryPrev.disabled = state.page <= 1;
  dom.glossaryNext.disabled = state.page >= totalPages;
}

/* ---------------------------- 关于 ---------------------------- */

function renderAbout() {
  dom.aboutVersion.textContent = 'v' + VERSION;
  dom.aboutGlossary.textContent = GLOSSARY_STATS.total + ' 条 / ' + GLOSSARY_STATS.categories.length + ' 个分类';
  dom.aboutCustom.textContent = sanitizeCustomTerms().length + ' 条';
  const excluded = parseExcludedSites(state.excludedText);
  dom.aboutExcluded.textContent = excluded.sites.length + ' 个';
}

/* ================================================================
 * 校验与保存
 * ================================================================ */

function validateDraft() {
  const errors = [];
  const meta = PROVIDER_META[state.draft.provider];
  if (meta) {
    const config = state.draft.providers[meta.id] || {};
    for (let index = 0; index < meta.fields.length; index += 1) {
      const field = meta.fields[index];
      const value = String(config[field.key] || '').trim();
      if (field.required && !value) {
        errors.push({ target: 'provider-field-' + field.key, message: '「' + meta.label + '」的' + field.label + '不能为空' });
      }
      if ((field.key === 'baseUrl' || field.key === 'endpoint') && value && !/^https?:\/\//i.test(value)) {
        errors.push({ target: 'provider-field-' + field.key, message: field.label + '需以 http:// 或 https:// 开头' });
      }
      if (field.type === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        errors.push({ target: 'provider-field-' + field.key, message: field.label + '格式不正确' });
      }
    }
  }

  const limit = Number(state.draft.batchCharLimit);
  if (!Number.isFinite(limit) || limit < 1000 || limit > 6000) {
    errors.push({ target: 'batch-char-limit', message: '单批字符数需在 1000 - 6000 之间' });
  }

  const parsed = parseExcludedSites(state.excludedText);
  if (parsed.invalid.length > 0) {
    errors.push({ target: 'excluded-sites', message: '站点排除中有格式错误的行：' + parsed.invalid.slice(0, 3).join('、') });
  }

  const terms = Array.isArray(state.draft.customTerms) ? state.draft.customTerms : [];
  for (let index = 0; index < terms.length; index += 1) {
    const term = terms[index] || {};
    const en = String(term.en || '').trim();
    const zh = String(term.zh || '').trim();
    if (!en && !zh) continue;
    if (!en || !zh) {
      errors.push({ target: 'custom-rows', message: '第 ' + (index + 1) + ' 条自定义术语：英文与中文都不能为空' });
      break;
    }
    if (en.length > CUSTOM_EN_MAX || zh.length > CUSTOM_ZH_MAX) {
      errors.push({ target: 'custom-rows', message: '第 ' + (index + 1) + ' 条自定义术语超出长度限制' });
      break;
    }
  }
  return errors;
}

function clearInvalidMarks() {
  const nodes = document.querySelectorAll('.is-invalid');
  for (let index = 0; index < nodes.length; index += 1) nodes[index].classList.remove('is-invalid');
}

function showValidationErrors(errors) {
  if (!errors || errors.length === 0) return;
  clearInvalidMarks();
  const first = errors[0];
  for (let index = 0; index < errors.length; index += 1) {
    const target = document.getElementById(errors[index].target);
    if (target) target.classList.add('is-invalid');
  }
  if (first.target.indexOf('provider-field-') === 0) showSection('provider');
  else if (first.target === 'batch-char-limit') showSection('translation');
  else if (first.target === 'excluded-sites') showSection('excluded');
  else if (first.target === 'custom-rows' || first.target === 'custom-error') showSection('glossary');
  setCustomError(first.target === 'custom-rows' ? first.message : '');

  const targetNode = document.getElementById(first.target);
  if (targetNode) {
    targetNode.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (typeof targetNode.focus === 'function') {
      window.setTimeout(function () {
        try {
          targetNode.focus({ preventScroll: true });
        } catch (error) {
          targetNode.focus();
        }
      }, 60);
    }
  }
  showToast(first.message, 'error');
}

async function persistDraft() {
  const errors = validateDraft();
  if (errors.length > 0) {
    showValidationErrors(errors);
    return false;
  }
  state.draft.excludedSites = parseExcludedSites(state.excludedText).sites;
  state.draft.customTerms = sanitizeCustomTerms();
  try {
    const saved = await saveSettings(state.draft);
    state.settings = saved;
    state.draft = clone(saved);
    state.excludedText = (saved.excludedSites || []).join('\n');
    markDirty(false);
    return true;
  } catch (error) {
    showToast('保存失败：' + (error && error.message ? error.message : '未知错误'), 'error');
    return false;
  }
}

async function onSave() {
  if (state.saving) return;
  state.saving = true;
  dom.saveBtn.disabled = true;
  dom.saveBtn.textContent = '保存中…';
  const ok = await persistDraft();
  state.saving = false;
  dom.saveBtn.disabled = false;
  if (ok) {
    renderAll();
    renderGlossaryCategoryOptions();
    renderGlossaryTable();
    setCustomError('');
    dom.saveBtn.textContent = '已保存 ✓';
    showToast('设置已保存');
    window.setTimeout(function () {
      if (!state.saving) dom.saveBtn.textContent = '保存设置';
    }, 1800);
  } else {
    dom.saveBtn.textContent = '保存设置';
  }
}

/* ================================================================
 * 测试连接 / 缓存 / 恢复默认
 * ================================================================ */

function formatSample(sample) {
  if (!sample) return '';
  if (typeof sample === 'string') return '（示例：' + sample.slice(0, 120) + '）';
  if (typeof sample === 'object') {
    const source = sample.source || sample.text || sample.input || sample.original || '';
    const translation = sample.translation || sample.output || sample.result || '';
    if (source || translation) {
      return '（示例：' + String(source).slice(0, 60) + ' → ' + String(translation).slice(0, 60) + '）';
    }
  }
  return '';
}

async function onTestProvider() {
  const meta = PROVIDER_META[state.draft.provider];
  if (!meta) return;
  const errors = validateDraft();
  if (errors.length > 0) {
    showValidationErrors(errors);
    return;
  }
  // 后台读取的是已保存的配置，因此测试前先静默保存
  const saved = await persistDraft();
  if (!saved) return;

  dom.testBtn.disabled = true;
  setTestResult('pending', '正在测试连接…');
  try {
    const response = await runtimeMessage({ type: MSG.TEST_PROVIDER, providerId: meta.id });
    if (response && response.ok === true) {
      setTestResult('success', '连接成功：' + (response.message || '服务可用') + formatSample(response.sample));
      showToast('连接成功');
    } else {
      setTestResult('error', '连接失败：' + errorMessageOf(response));
    }
  } catch (error) {
    setTestResult('error', '连接失败：无法连接扩展后台，请重新加载扩展后重试');
  } finally {
    dom.testBtn.disabled = false;
  }
}

async function onClearCache() {
  dom.clearCache.disabled = true;
  try {
    const response = await runtimeMessage({ type: MSG.CLEAR_CACHE });
    if (response && response.ok === true) {
      const removed = Number(response.removed);
      showToast(Number.isFinite(removed) && removed > 0 ? '已清除 ' + removed + ' 条翻译缓存' : '翻译缓存已清除');
    } else {
      showToast('清除缓存失败：' + errorMessageOf(response), 'error');
    }
  } catch (error) {
    showToast('清除缓存失败：无法连接扩展后台', 'error');
  } finally {
    dom.clearCache.disabled = false;
  }
}

async function onResetAll() {
  if (!window.confirm('恢复默认设置会清空已保存的 API Key、自定义术语与站点排除列表。确定继续吗？')) return;
  if (!window.confirm('再次确认：此操作不可撤销，确定要恢复默认设置吗？')) return;
  try {
    const saved = await saveSettings(clone(DEFAULT_SETTINGS));
    state.settings = saved;
    state.draft = clone(saved);
    state.excludedText = (saved.excludedSites || []).join('\n');
    state.page = 1;
    state.query = '';
    state.category = '';
    dom.glossarySearch.value = '';
    renderAll();
    markDirty(false);
    setCustomError('');
    showToast('已恢复默认设置');
  } catch (error) {
    showToast('恢复默认设置失败：' + (error && error.message ? error.message : '未知错误'), 'error');
  }
}

/* ================================================================
 * 事件绑定
 * ================================================================ */

function bindSwitch(element, key) {
  element.addEventListener('change', function () {
    state.draft[key] = element.checked;
    if (key === 'selectionEnabled') dom.selectionTrigger.disabled = !element.checked;
    markDirty(true);
  });
}

function bindEvents() {
  dom.saveBtn.addEventListener('click', function () {
    void onSave();
  });

  dom.providerList.addEventListener('change', function (event) {
    const target = event.target;
    if (target && target.name === 'provider') selectProvider(target.value);
  });

  dom.testBtn.addEventListener('click', function () {
    void onTestProvider();
  });

  dom.targetLang.addEventListener('change', function () {
    state.draft.targetLang = dom.targetLang.value;
    markDirty(true);
  });

  dom.selectionTrigger.addEventListener('change', function () {
    state.draft.selectionTrigger = dom.selectionTrigger.value;
    markDirty(true);
  });

  dom.batchCharLimit.addEventListener('input', function () {
    const value = Number(dom.batchCharLimit.value);
    state.draft.batchCharLimit = value;
    dom.batchCharOutput.textContent = String(value);
    markDirty(true);
  });

  bindSwitch(dom.enforceTerms, 'enforceTerms');
  bindSwitch(dom.highlightTerms, 'highlightTerms');
  bindSwitch(dom.selectionEnabled, 'selectionEnabled');
  bindSwitch(dom.cacheEnabled, 'cacheEnabled');
  bindSwitch(dom.freeFallback, 'freeFallback');

  dom.glossarySearch.addEventListener('input', function () {
    if (searchTimer) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(function () {
      searchTimer = 0;
      state.query = dom.glossarySearch.value.trim();
      state.page = 1;
      renderGlossaryTable();
    }, SEARCH_DEBOUNCE_MS);
  });

  dom.glossaryCategory.addEventListener('change', function () {
    state.category = dom.glossaryCategory.value;
    state.page = 1;
    updateStatChips();
    renderGlossaryTable();
  });

  dom.glossaryStats.addEventListener('click', function (event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const chip = target.closest('.stat-chip');
    if (!chip) return;
    const category = chip.dataset.category || '';
    state.category = state.category === category ? '' : category;
    state.page = 1;
    dom.glossaryCategory.value = state.category;
    updateStatChips();
    renderGlossaryTable();
  });

  dom.glossaryPrev.addEventListener('click', function () {
    if (state.page > 1) {
      state.page -= 1;
      renderGlossaryTable();
      dom.glossaryRows.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });

  dom.glossaryNext.addEventListener('click', function () {
    state.page += 1;
    renderGlossaryTable();
    dom.glossaryRows.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  dom.customAdd.addEventListener('click', addCustomTerm);
  dom.customEn.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') addCustomTerm();
  });
  dom.customZh.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') addCustomTerm();
  });
  dom.customNote.addEventListener('keydown', function (event) {
    if (event.key === 'Enter') addCustomTerm();
  });

  dom.termsExport.addEventListener('click', exportCustomTerms);
  dom.termsImport.addEventListener('change', function (event) {
    void importCustomTerms(event);
  });

  dom.excludedSites.addEventListener('input', function () {
    state.excludedText = dom.excludedSites.value;
    updateExcludedHint();
    markDirty(true);
  });

  dom.clearExcluded.addEventListener('click', function () {
    dom.excludedSites.value = '';
    state.excludedText = '';
    updateExcludedHint();
    markDirty(true);
  });

  dom.clearCache.addEventListener('click', function () {
    void onClearCache();
  });
  dom.resetAll.addEventListener('click', function () {
    void onResetAll();
  });

  window.addEventListener('beforeunload', function (event) {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

/* ================================================================
 * 启动
 * ================================================================ */

void init();
