/**
 * 术语精准翻译 · popup 脚本（ES Module）
 * 职责：展示当前页面翻译状态、启动 / 还原整页翻译、切换展示模式、
 *       快捷开关划词翻译，并作为设置页入口。
 */

import { MSG, PROVIDER_META, VERSION } from '../lib/constants.js';
import { getSettings, saveSettings, isProviderConfigured, providerLabel } from '../lib/settings.js';

const POLL_INTERVAL_MS = 900;
const MAX_POLL_COUNT = 240;
const CONTENT_FILES = ['src/content/content.js'];
const CONTENT_CSS_FILES = ['src/content/content.css'];

const state = {
  tab: null,
  settings: null,
  available: false,
  active: false,
  running: false,
  transitioning: false,
  mode: 'bilingual',
  progress: { done: 0, total: 0 },
  translatedCount: 0,
  busy: false,
  pollTimer: 0,
  pollCount: 0,
};

const dom = {};

function $(id) {
  return document.getElementById(id);
}

function cacheDom() {
  dom.settingsBtn = $('settings-btn');
  dom.pageDot = $('page-dot');
  dom.pageStatusText = $('page-status-text');
  dom.pageTitle = $('page-title');
  dom.pageHost = $('page-host');
  dom.pageProgress = $('page-progress');
  dom.progressFill = $('progress-fill');
  dom.progressText = $('progress-text');
  dom.translateBtn = $('translate-btn');
  dom.modeBilingual = $('mode-bilingual');
  dom.modeReplace = $('mode-replace');
  dom.selectionToggle = $('selection-toggle');
  dom.providerWarning = $('provider-warning');
  dom.providerWarningText = $('provider-warning-text');
  dom.configureBtn = $('configure-btn');
  dom.providerName = $('provider-name');
  dom.providerKind = $('provider-kind');
  dom.optionsBtn = $('options-btn');
  dom.versionText = $('version-text');
  dom.toast = $('toast');
}

/* ------------------------------ 消息工具 ------------------------------ */

function sendToTab(tabId, message) {
  return new Promise(function (resolve, reject) {
    try {
      chrome.tabs.sendMessage(tabId, message, function (response) {
        const runtimeError = chrome.runtime && chrome.runtime.lastError;
        if (runtimeError) {
          reject(new Error(runtimeError.message || '无法与页面脚本通信'));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

function queryActiveTab() {
  return new Promise(function (resolve) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(tabs && tabs.length > 0 ? tabs[0] : null);
      });
    } catch (error) {
      resolve(null);
    }
  });
}

/* ------------------------------ 状态渲染 ------------------------------ */

function isSupportedUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function kindLabel(kind) {
  if (kind === 'llm') return 'AI 大模型';
  if (kind === 'mt') return '机器翻译';
  if (kind === 'local') return '离线词典';
  return '其他';
}

function isProviderReady() {
  if (!state.settings) return false;
  return isProviderConfigured(state.settings.provider, state.settings);
}

function providerMeta() {
  if (!state.settings) return null;
  return PROVIDER_META[state.settings.provider] || null;
}

function renderProvider() {
  if (!state.settings) {
    dom.providerName.textContent = '—';
    dom.providerKind.textContent = '—';
    return;
  }
  dom.providerName.textContent = providerLabel(state.settings.provider);
  const meta = providerMeta();
  dom.providerKind.textContent = meta ? kindLabel(meta.kind) : '—';
  if (!dom.selectionToggle.dataset.bound) {
    dom.selectionToggle.checked = state.settings.selectionEnabled !== false;
  }
}

function renderWarning() {
  const ready = isProviderReady();
  if (!state.available || ready) {
    dom.providerWarning.hidden = true;
    return;
  }
  const label = state.settings ? providerLabel(state.settings.provider) : '当前服务商';
  dom.providerWarning.hidden = false;
  dom.providerWarningText.textContent = '「' + label + '」尚未配置，暂时无法翻译';
}

function render() {
  // 状态圆点 + 主状态文案
  let dotState = 'idle';
  let statusText = '可以翻译此页面';
  if (!state.available) {
    dotState = 'unavailable';
    statusText = '当前页面不可用';
  } else if (state.running) {
    dotState = 'running';
    statusText = '正在翻译…';
  } else if (state.active) {
    dotState = 'active';
    statusText = '已翻译此页面';
  }
  dom.pageDot.dataset.state = dotState;
  dom.pageStatusText.textContent = statusText;

  // 进度条
  if (state.running) {
    const total = state.progress.total;
    const done = state.progress.done;
    dom.pageProgress.hidden = false;
    dom.progressFill.style.width = total ? Math.round((done / total) * 100) + '%' : '0%';
    dom.progressText.textContent = total ? done + '/' + total : '准备中…';
  } else {
    dom.pageProgress.hidden = true;
  }

  // 主按钮
  const ready = isProviderReady();
  if (!state.available) {
    dom.translateBtn.disabled = true;
    dom.translateBtn.textContent = '翻译此页面';
  } else if (state.running) {
    dom.translateBtn.disabled = state.busy;
    dom.translateBtn.textContent = '停止翻译';
  } else if (state.active) {
    dom.translateBtn.disabled = state.busy;
    dom.translateBtn.textContent = '还原原文';
  } else {
    dom.translateBtn.disabled = state.busy || !ready;
    dom.translateBtn.textContent = '翻译此页面';
  }

  // 展示模式
  const bilingualActive = state.mode === 'bilingual';
  dom.modeBilingual.classList.toggle('is-active', bilingualActive);
  dom.modeReplace.classList.toggle('is-active', !bilingualActive);
  dom.modeBilingual.setAttribute('aria-pressed', bilingualActive ? 'true' : 'false');
  dom.modeReplace.setAttribute('aria-pressed', bilingualActive ? 'false' : 'true');

  renderWarning();
}

function renderUnavailable(reason) {
  state.available = false;
  state.active = false;
  state.running = false;
  dom.pageDot.dataset.state = 'unavailable';
  dom.pageStatusText.textContent = '当前页面不可用';
  dom.pageTitle.hidden = true;
  dom.pageHost.hidden = true;
  dom.pageProgress.hidden = true;
  render();
  if (reason) showToast(reason);
}

/* ------------------------------ 提示 ------------------------------ */

let toastTimer = 0;

function showToast(message, kind) {
  if (!message) return;
  dom.toast.textContent = message;
  dom.toast.dataset.kind = kind || 'info';
  dom.toast.hidden = false;
  if (toastTimer) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(function () {
    toastTimer = 0;
    dom.toast.hidden = true;
  }, 3200);
}

function errorMessageOf(response) {
  if (response && response.error) {
    if (typeof response.error.message === 'string' && response.error.message.trim()) return response.error.message.trim();
    if (typeof response.error.code === 'string') return '错误代码：' + response.error.code;
  }
  return '操作失败，请稍后重试';
}

/* ------------------------------ 页面状态 ------------------------------ */

function applyStatus(status) {
  state.active = Boolean(status.active);
  state.translatedCount = Number(status.translatedCount) || 0;
  const progress = status.progress || {};
  state.progress = {
    done: Number(progress.done) || 0,
    total: Number(progress.total) || 0,
  };
  const inferredRunning = Boolean(status.running) ||
    (state.active && state.progress.total > 0 && state.progress.done < state.progress.total);
  state.running = inferredRunning;
  state.mode = status.mode === 'replace' ? 'replace' : 'bilingual';
  render();
}

async function refreshStatus() {
  if (!state.available || !state.tab) return null;
  try {
    const status = await sendToTab(state.tab.id, { type: MSG.PAGE_STATUS });
    if (status && status.ok === true) {
      applyStatus(status);
      return status;
    }
  } catch (error) {
    // 内容脚本尚未就绪时忽略，由轮询或重新注入兜底
  }
  return null;
}

async function ensureContentReady(tab) {
  try {
    const pong = await sendToTab(tab.id, { type: MSG.PING });
    if (pong && pong.ok) return true;
  } catch (error) {
    // 继续尝试注入
  }
  if (!chrome.scripting || typeof chrome.scripting.executeScript !== 'function') return false;
  try {
    if (typeof chrome.scripting.insertCSS === 'function') {
      await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: CONTENT_CSS_FILES });
    }
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
  } catch (error) {
    return false;
  }
  try {
    const pong = await sendToTab(tab.id, { type: MSG.PING });
    return Boolean(pong && pong.ok);
  } catch (error) {
    return false;
  }
}

/* ------------------------------ 轮询 ------------------------------ */

function stopPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = 0;
  }
}

function beginPolling() {
  stopPolling();
  state.pollCount = 0;
  state.pollTimer = window.setInterval(pollTick, POLL_INTERVAL_MS);
  void pollTick();
}

async function pollTick() {
  state.pollCount += 1;
  const status = await refreshStatus();
  if (status) {
    if (!state.running) {
      stopPolling();
      if (state.transitioning && !state.active) {
        showToast('翻译未能开始，请查看页面右下角的提示');
      }
      state.transitioning = false;
      return;
    }
  } else if (state.pollCount > 4) {
    stopPolling();
    showToast('暂时无法读取页面状态，请刷新页面后重试');
    return;
  }
  if (state.pollCount > MAX_POLL_COUNT) stopPolling();
}

/* ------------------------------ 操作 ------------------------------ */

async function startTranslate() {
  if (!isProviderReady()) {
    showToast('请先在设置中配置「' + (state.settings ? providerLabel(state.settings.provider) : '服务商') + '」');
    return;
  }
  state.busy = true;
  render();
  dom.translateBtn.textContent = '正在启动…';
  try {
    const response = await sendToTab(state.tab.id, { type: MSG.PAGE_TRANSLATE });
    state.busy = false;
    if (!response || response.ok !== true) {
      showToast(errorMessageOf(response));
      await refreshStatus();
      return;
    }
    if (response.excluded) {
      showToast('该站点已在排除列表，可在设置中移除');
      await refreshStatus();
      return;
    }
    if (response.configured === false) {
      showToast('请先在设置中配置服务商密钥');
      await refreshStatus();
      return;
    }
    // 内容脚本已开始翻译（或已在翻译中），进入轮询
    state.running = true;
    state.active = true;
    state.transitioning = true;
    render();
    beginPolling();
  } catch (error) {
    state.busy = false;
    showToast('无法与页面脚本通信，请刷新页面后重试');
    await refreshStatus();
  }
}

async function stopTranslate() {
  state.busy = true;
  render();
  try {
    await sendToTab(state.tab.id, { type: MSG.PAGE_RESTORE });
    stopPolling();
    state.transitioning = false;
    state.active = false;
    state.running = false;
    state.progress = { done: 0, total: 0 };
    showToast('已还原页面原文');
    state.busy = false;
    render();
  } catch (error) {
    state.busy = false;
    showToast('还原失败，请刷新页面后重试');
    render();
  }
}

async function onPrimaryClick() {
  if (!state.available) return;
  if (state.running || state.active) {
    await stopTranslate();
    return;
  }
  await startTranslate();
}

async function onModeClick(mode) {
  if (!state.settings) return;
  if (state.mode === mode) return;
  state.mode = mode;
  render();
  try {
    state.settings = await saveSettings(Object.assign({}, state.settings, { pageMode: mode }));
  } catch (error) {
    showToast('保存展示模式失败');
  }
  if (state.available) {
    try {
      await sendToTab(state.tab.id, { type: MSG.PAGE_SET_MODE, mode: mode });
    } catch (error) {
      // 页面未注入时仅保存设置，下次整页翻译生效
    }
  }
}

async function onSelectionToggle() {
  if (!state.settings) {
    dom.selectionToggle.checked = !dom.selectionToggle.checked;
    return;
  }
  const enabled = dom.selectionToggle.checked;
  try {
    state.settings = await saveSettings(Object.assign({}, state.settings, { selectionEnabled: enabled }));
    showToast(enabled ? '已开启划词翻译' : '已关闭划词翻译');
  } catch (error) {
    dom.selectionToggle.checked = !enabled;
    showToast('保存划词设置失败');
  }
}

function openOptionsPage() {
  try {
    chrome.runtime.openOptionsPage();
    window.close();
  } catch (error) {
    showToast('无法打开设置页，请在扩展菜单中进入「选项」');
  }
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bindEvents() {
  dom.translateBtn.addEventListener('click', function () {
    void onPrimaryClick();
  });
  dom.modeBilingual.addEventListener('click', function () {
    void onModeClick('bilingual');
  });
  dom.modeReplace.addEventListener('click', function () {
    void onModeClick('replace');
  });
  dom.selectionToggle.addEventListener('change', function () {
    void onSelectionToggle();
  });
  dom.settingsBtn.addEventListener('click', openOptionsPage);
  dom.optionsBtn.addEventListener('click', openOptionsPage);
  dom.configureBtn.addEventListener('click', openOptionsPage);
  window.addEventListener('unload', stopPolling);
}

/* ------------------------------ 初始化 ------------------------------ */

async function init() {
  cacheDom();
  dom.versionText.textContent = 'v' + VERSION;
  bindEvents();

  try {
    state.settings = await getSettings();
  } catch (error) {
    state.settings = null;
  }
  renderProvider();

  const tab = await queryActiveTab();
  state.tab = tab;
  if (!tab || !isSupportedUrl(tab.url)) {
    renderUnavailable('');
    return;
  }

  dom.pageTitle.hidden = false;
  dom.pageHost.hidden = false;
  dom.pageTitle.textContent = tab.title ? String(tab.title).trim() : '（无标题页面）';
  try {
    dom.pageHost.textContent = new URL(tab.url).hostname;
  } catch (error) {
    dom.pageHost.textContent = tab.url;
  }
  dom.pageTitle.title = dom.pageTitle.textContent;

  const ready = await ensureContentReady(tab);
  if (!ready) {
    renderUnavailable('页面脚本尚未就绪，请刷新页面后重试');
    return;
  }
  state.available = true;
  await refreshStatus();
  render();
}

void init();
