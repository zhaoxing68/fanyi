/**
 * 设置的读写与合并（Lead 维护）。
 * 仅被 Service Worker 与扩展页面使用（它们有 chrome.storage 权限）。
 * 纯函数 + 注入 chrome.storage，便于 Node 测试时 mock。
 */

import { DEFAULT_SETTINGS, PROVIDER_META, SETTINGS_KEY } from './constants.js';

export function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function normalizeSites(value) {
  if (!Array.isArray(value)) return [];
  const set = new Set();
  for (const item of value) {
    const host = String(item || '')
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    if (host) set.add(host);
  }
  return [...set];
}

function normalizeCustomTerms(value) {
  if (!Array.isArray(value)) return [];
  const list = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const en = String(raw.en || '').trim();
    const zh = String(raw.zh || '').trim();
    if (!en || !zh) continue;
    const entry = { en, zh };
    const note = String(raw.note || '').trim();
    if (note) entry.note = note;
    list.push(entry);
  }
  return list;
}

/** 把存储中的设置与默认值深合并（providers 按服务商合并） */
export function mergeSettings(stored) {
  const base = clone(DEFAULT_SETTINGS);
  if (!stored || typeof stored !== 'object') return base;
  const merged = Object.assign({}, base, stored);
  merged.providers = Object.assign({}, base.providers);
  const storedProviders = stored.providers && typeof stored.providers === 'object' ? stored.providers : {};
  for (const id of Object.keys(storedProviders)) {
    merged.providers[id] = Object.assign({}, base.providers[id] || {}, storedProviders[id] || {});
  }
  merged.customTerms = normalizeCustomTerms(stored.customTerms);
  merged.excludedSites = normalizeSites(stored.excludedSites);
  return merged;
}

export async function getSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return mergeSettings(stored ? stored[SETTINGS_KEY] : undefined);
}

export async function saveSettings(settings) {
  const next = mergeSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export async function updateSettings(patch) {
  const current = await getSettings();
  const providers = Object.assign({}, current.providers, (patch && patch.providers) || {});
  const next = mergeSettings(Object.assign({}, current, patch, { providers }));
  await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  return next;
}

export function isProviderConfigured(providerId, settings) {
  const meta = PROVIDER_META[providerId];
  if (!meta) return false;
  const config = (settings.providers && settings.providers[providerId]) || {};
  return meta.fields
    .filter((field) => field.required)
    .every((field) => String(config[field.key] || '').trim().length > 0);
}

export function providerLabel(providerId) {
  const meta = PROVIDER_META[providerId];
  return meta ? meta.label : String(providerId || '');
}

/** 发给 content script 的设置（不含任何密钥） */
export function toPublicSettings(settings) {
  return {
    provider: settings.provider,
    providerLabel: providerLabel(settings.provider),
    providerConfigured: isProviderConfigured(settings.provider, settings),
    targetLang: settings.targetLang,
    pageMode: settings.pageMode,
    enforceTerms: settings.enforceTerms,
    highlightTerms: settings.highlightTerms,
    selectionEnabled: settings.selectionEnabled,
    selectionTrigger: settings.selectionTrigger,
    batchCharLimit: settings.batchCharLimit,
    excludedSites: settings.excludedSites.slice(),
  };
}

export function onSettingsChanged(callback) {
  const listener = (changes, areaName) => {
    if (areaName !== 'local' || !changes || !changes[SETTINGS_KEY]) return;
    callback(mergeSettings(changes[SETTINGS_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
