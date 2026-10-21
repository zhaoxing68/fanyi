/**
 * 术语精准翻译 · content script（经典脚本，不使用 ESM 模块语法）
 *
 * 职责：
 *   1. 划词翻译：选区附近浮动「译」按钮 / 自动翻译，弹出译文卡片与术语提示；
 *   2. 整页翻译：按段落批处理，支持「双语对照」与「仅显示译文」，行内代码占位保护，术语高亮；
 *   3. 页面状态查询，供 popup / background 调用；
 *   4. SPA 动态内容补翻、排除站点提示、完整错误反馈。
 *
 * 安全约定：所有来自接口 / 页面数据的内容一律通过 textContent 或 createElement 写入 DOM，
 *           绝不拼接 HTML 字符串。
 * 样式约定：所有类名以 dsh- 前缀，样式集中在 content.css，不改变页面原有布局。
 */
(function () {
  'use strict';

  // 全局幂等标记：同一页面只初始化一次
  if (window.__DSH_TERMS_TRANSLATOR_LOADED__) return;
  window.__DSH_TERMS_TRANSLATOR_LOADED__ = true;

  /* ================================================================
   * 消息类型：必须与 src/lib/constants.js 中的 MSG 逐字一致
   * ================================================================ */
  const MSG = Object.freeze({
    PING: 'dsh:ping',
    GET_SETTINGS: 'dsh:get-settings',
    GET_GLOSSARY: 'dsh:get-glossary',
    TRANSLATE_BATCH: 'dsh:translate-batch',
    TRANSLATE_SELECTION: 'dsh:translate-selection',
    OPEN_OPTIONS: 'dsh:open-options',
    PAGE_TRANSLATE: 'dsh:page-translate',
    PAGE_RESTORE: 'dsh:page-restore',
    PAGE_STATUS: 'dsh:page-status',
    PAGE_SET_MODE: 'dsh:page-set-mode',
    SELECTION_TRANSLATE: 'dsh:selection-translate',
  });

  /* ================================================================
   * 常量
   * ================================================================ */
  const ROOT_ID = 'dsh-translator-root';
  const MAX_SELECTION_CHARS = 5000;
  const MAX_BATCH_TEXTS = 20;
  const MAX_CONCURRENT_BATCHES = 2;
  const MIN_BATCH_CHAR_LIMIT = 1000;
  const MAX_BATCH_CHAR_LIMIT = 6000;
  const DEFAULT_BATCH_CHAR_LIMIT = 3000;
  const SELECTION_DEBOUNCE_MS = 220;
  const SPA_DEBOUNCE_MS = 800;
  const NOTICE_AUTO_HIDE_MS = 7000;
  const LETTER_PATTERN = /\p{L}/u;
  const LATIN_LETTER_PATTERN = /[A-Za-z\u00C0-\u024F\u0400-\u04FF\u1E00-\u1EFF]/;

  /** 可翻译块（段落级元素 + 可能的叶子容器） */
  const TRANSLATABLE_SELECTOR = [
    'p', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'td', 'th', 'blockquote', 'figcaption', 'dt', 'dd',
    'article', 'section', 'div', 'main', 'aside', 'header', 'footer', 'nav', 'figure', 'details',
    'summary', 'address', 'form', 'fieldset',
  ].join(',');

  /** 通用容器：只有内部完全没有块级子元素时才作为「叶子块」翻译 */
  const GENERIC_CONTAINER_TAGS = new Set([
    'ARTICLE', 'SECTION', 'DIV', 'MAIN', 'ASIDE', 'HEADER', 'FOOTER', 'NAV',
    'FIGURE', 'DETAILS', 'SUMMARY', 'ADDRESS', 'FORM', 'FIELDSET',
  ]);

  /** 含以下任一后代即视为非叶子块 */
  const BLOCK_LEVEL_SELECTOR = [
    'address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'dt', 'dd',
    'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'header', 'hgroup', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre', 'section', 'table',
    'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
  ].join(',');

  /** 命中这些祖先节点的块整体跳过 */
  const SKIP_ANCESTOR_SELECTOR = [
    'script', 'style', 'noscript', 'template', 'textarea', 'input', 'select', 'option', 'button',
    'svg', 'canvas', 'video', 'audio', 'iframe', 'object', 'embed',
    '[contenteditable=""]', '[contenteditable="true"]', '[contenteditable="plaintext-only"]',
    '[data-dsh-ignore]', '[data-dsh-block]', '#' + ROOT_ID,
  ].join(',');

  /** 收集文本时整棵跳过的标签 */
  const SKIP_SUBTREE_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'TEXTAREA', 'INPUT', 'SELECT', 'OPTION',
    'BUTTON', 'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED',
  ]);

  /** 行内代码类标签：提取为占位符，翻译后还原为 code 元素 */
  const INLINE_CODE_TAGS = new Set(['CODE', 'KBD', 'SAMP']);

  /** 双语模式下优先追加到元素内部末尾的块级元素 */
  const INNER_APPEND_TAGS = new Set(['LI', 'TD', 'TH', 'DT', 'DD']);

  /** 行内代码占位符：⟦C0⟧ ⟦C1⟧ …（翻译引擎会原样保留） */
  const CODE_MARKER_PATTERN = /⟦C(\d+)⟧/g;

  const UNAVAILABLE_SELECTION_SELECTOR = 'input, textarea, select';
  const EDITABLE_SELECTOR = '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

  // 与 src/lib/constants.js 的 SETTINGS_KEY 保持一致（content 脚本无法引用模块）
  const SETTINGS_STORAGE_KEY = 'techTermsTranslator.settings';

  /* ================================================================
   * 运行状态
   * ================================================================ */
  const state = {
    // 设置与术语表（均来自 background，content 不直接读 storage）
    settings: null,
    settingsRequest: null,
    settingsReloadTimer: 0,
    glossary: null,
    glossaryRequest: null,
    // 整页翻译
    active: false,
    running: false,
    mode: 'bilingual',
    progress: { done: 0, total: 0 },
    translatedCount: 0,
    failedCount: 0,
    lostMarkerCount: 0,
    lastError: '',
    hudStatus: null,
    warnings: [],
    runToken: 0,
    processedBlocks: new Set(),
    failedBlocks: new Set(),
    observer: null,
    spaTimer: 0,
    spaPending: false,
    noticeTimer: 0,
    // 划词翻译
    selectionTimer: 0,
    lastSelection: null,
    lastAutoText: '',
    selectionRequestId: 0,
    cardInfo: null,
    cardCopyText: '',
    // 界面引用
    ui: {
      root: null,
      hud: null,
      fab: null,
      selectionBtn: null,
      card: null,
      hudRefs: null,
      cardRefs: null,
    },
  };

  /* ================================================================
   * 通用工具
   * ================================================================ */

  function createEl(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function createButton(className, label, action, title) {
    const button = document.createElement('button');
    button.type = 'button';
    if (className) button.className = className;
    if (label !== undefined && label !== null) button.textContent = String(label);
    if (action) button.setAttribute('data-dsh-action', action);
    if (title) button.title = title;
    return button;
  }

  function clearNode(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  function isExtensionContext() {
    try {
      return typeof chrome !== 'undefined' && !!chrome.runtime && typeof chrome.runtime.sendMessage === 'function';
    } catch (error) {
      return false;
    }
  }

  /** 向 background 发送消息（Promise 包装，兼容回调式 API） */
  function sendToBackground(message) {
    return new Promise(function (resolve, reject) {
      if (!isExtensionContext()) {
        reject(new Error('扩展上下文不可用'));
        return;
      }
      let settled = false;
      try {
        chrome.runtime.sendMessage(message, function (response) {
          if (settled) return;
          settled = true;
          const runtimeError = chrome.runtime && chrome.runtime.lastError;
          if (runtimeError) {
            reject(new Error(runtimeError.message || '消息发送失败'));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
    });
  }

  function normalizeErrorMessage(error) {
    let message = '';
    if (error && typeof error === 'object' && typeof error.message === 'string') message = error.message;
    else if (typeof error === 'string') message = error;
    message = String(message || '').trim();
    if (!message) return '未知错误，请稍后重试';
    if (/Could not establish connection|Receiving end does not exist|message port closed/i.test(message)) {
      return '无法连接扩展后台，请刷新页面后重试';
    }
    if (/Extension context invalidated/i.test(message)) return '扩展已更新，请刷新页面后重试';
    if (/Failed to fetch|NetworkError|Load failed|fetch failed/i.test(message)) return '网络请求失败，请检查网络连接';
    return message;
  }

  function extractErrorMessage(response) {
    if (response && response.error) {
      if (typeof response.error.message === 'string' && response.error.message.trim()) return response.error.message.trim();
      if (typeof response.error.code === 'string' && response.error.code.trim()) return '错误代码：' + response.error.code;
    }
    if (response && typeof response.message === 'string' && response.message.trim()) return response.message.trim();
    return '服务返回了异常结果';
  }

  function formatTranslationError(message) {
    const text = String(message || '').trim() || '未知错误';
    return /^翻译失败[:：]/.test(text) ? text : '翻译失败：' + text;
  }

  function clampBatchCharLimit(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_BATCH_CHAR_LIMIT;
    return Math.min(MAX_BATCH_CHAR_LIMIT, Math.max(MIN_BATCH_CHAR_LIMIT, Math.round(number)));
  }

  function escapeRegExp(text) {
    return String(text).replace(/[.*+?^\u0024{}()|[\]\\]/g, '\\$&');
  }

  /* ================================================================
   * 根节点与显示同步
   * ================================================================ */

  function ensureRoot() {
    if (state.ui.root && state.ui.root.isConnected) return state.ui.root;
    let root = document.getElementById(ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = ROOT_ID;
      root.hidden = true;
      root.setAttribute('data-dsh-ignore', '');
      const host = document.body || document.documentElement;
      host.appendChild(root);
    }
    state.ui.root = root;
    return root;
  }

  function syncRootVisibility() {
    const root = ensureRoot();
    const ui = state.ui;
    const visible = Boolean(
      (ui.hud && !ui.hud.hidden) ||
      (ui.fab && !ui.fab.hidden) ||
      (ui.card && !ui.card.hidden) ||
      (ui.selectionBtn && !ui.selectionBtn.hidden)
    );
    if (visible) root.removeAttribute('hidden');
    else root.setAttribute('hidden', '');
  }

  /* ================================================================
   * 设置 / 术语表读取（经 background 中转）
   * ================================================================ */

  function applySettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    state.settings = settings;
    if (!state.active && !state.running) {
      state.mode = settings.pageMode === 'replace' ? 'replace' : 'bilingual';
    }
    if (!settings.selectionEnabled) hideSelectionButton();
    if (state.active) applyModeAttribute();
  }

  function ensureSettings(force) {
    if (!force && state.settings) return Promise.resolve(state.settings);
    if (state.settingsRequest) return state.settingsRequest;
    state.settingsRequest = (async function () {
      try {
        const response = await sendToBackground({ type: MSG.GET_SETTINGS });
        if (response && response.ok === true && response.settings) {
          applySettings(response.settings);
          return state.settings;
        }
        return null;
      } catch (error) {
        return null;
      } finally {
        state.settingsRequest = null;
      }
    })();
    return state.settingsRequest;
  }

  function currentProviderLabel() {
    if (state.settings && state.settings.providerLabel) return state.settings.providerLabel;
    return '默认服务商';
  }

  function ensureGlossary() {
    if (state.glossary && state.glossary.ready) return Promise.resolve(state.glossary);
    if (state.glossaryRequest) return state.glossaryRequest;
    state.glossaryRequest = (async function () {
      try {
        const response = await sendToBackground({ type: MSG.GET_GLOSSARY });
        if (response && response.ok === true && Array.isArray(response.entries)) {
          state.glossary = {
            ready: true,
            entries: response.entries,
            matcher: buildGlossaryMatcher(response.entries),
            total: typeof response.total === 'number' ? response.total : response.entries.length,
            version: response.version || '',
            categories: Array.isArray(response.categories) ? response.categories : [],
          };
        }
      } catch (error) {
        // 术语表不可用不影响翻译本身
      } finally {
        state.glossaryRequest = null;
      }
      return state.glossary;
    })();
    return state.glossaryRequest;
  }

  function isExcludedSite(settings) {
    const sites = settings && Array.isArray(settings.excludedSites) ? settings.excludedSites : [];
    if (!sites.length) return false;
    const host = String(location.hostname || '').toLowerCase();
    if (!host) return false;
    return sites.some(function (site) {
      const normalized = String(site || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '');
      if (!normalized) return false;
      return host === normalized || host.endsWith('.' + normalized);
    });
  }

  /* ================================================================
   * HUD 状态条
   * ================================================================ */

  function ensureHud() {
    if (state.ui.hud) return state.ui.hud;
    const root = ensureRoot();

    const hud = createEl('div', 'dsh-hud');
    hud.setAttribute('role', 'status');
    hud.setAttribute('aria-live', 'polite');
    hud.dataset.state = 'idle';

    // —— 主行 ——
    const bar = createEl('div', 'dsh-hud-bar');
    const info = createEl('div', 'dsh-hud-info');
    const dot = createEl('span', 'dsh-hud-dot');
    dot.setAttribute('aria-hidden', 'true');
    const meta = createEl('div', 'dsh-hud-meta');
    const title = createEl('span', 'dsh-hud-title');
    title.textContent = '术语精准翻译';
    const sub = createEl('span', 'dsh-hud-sub');
    meta.appendChild(title);
    meta.appendChild(sub);
    info.appendChild(dot);
    info.appendChild(meta);

    const actions = createEl('div', 'dsh-hud-actions');
    const modeButton = createButton('dsh-btn dsh-btn-ghost', '仅译文', 'toggle-mode', '切换整页展示模式');
    const restoreButton = createButton('dsh-btn dsh-btn-primary', '还原', 'restore', '还原页面原文');
    const collapseButton = createButton('dsh-icon-btn', '—', 'collapse', '收起状态条');
    collapseButton.setAttribute('aria-label', '收起状态条');
    const dismissButton = createButton('dsh-icon-btn', '×', 'dismiss', '关闭提示');
    dismissButton.hidden = true;
    actions.appendChild(modeButton);
    actions.appendChild(restoreButton);
    actions.appendChild(collapseButton);
    actions.appendChild(dismissButton);
    bar.appendChild(info);
    bar.appendChild(actions);

    // —— 进度行 ——
    const progressRow = createEl('div', 'dsh-hud-progress');
    const track = createEl('div', 'dsh-hud-track');
    const fill = createEl('div', 'dsh-hud-fill');
    track.appendChild(fill);
    const progressText = createEl('span', 'dsh-hud-progress-text');
    progressRow.appendChild(track);
    progressRow.appendChild(progressText);
    progressRow.hidden = true;

    // —— 错误行 ——
    const errorRow = createEl('div', 'dsh-hud-error');
    const errorText = createEl('span', 'dsh-hud-error-text');
    const optionsButton = createButton('dsh-btn dsh-btn-warn', '去设置', 'open-options', '打开设置页');
    errorRow.appendChild(errorText);
    errorRow.appendChild(optionsButton);
    errorRow.hidden = true;

    hud.appendChild(bar);
    hud.appendChild(progressRow);
    hud.appendChild(errorRow);
    root.appendChild(hud);

    const fab = createButton('dsh-fab', '译', 'expand', '展开翻译状态条');
    fab.hidden = true;
    root.appendChild(fab);

    state.ui.hud = hud;
    state.ui.fab = fab;
    state.ui.hudRefs = {
      title: title,
      sub: sub,
      modeButton: modeButton,
      restoreButton: restoreButton,
      collapseButton: collapseButton,
      dismissButton: dismissButton,
      progressRow: progressRow,
      progressFill: fill,
      progressText: progressText,
      errorRow: errorRow,
      errorText: errorText,
      optionsButton: optionsButton,
    };
    return hud;
  }

  function showHud() {
    ensureHud();
    const ui = state.ui;
    ui.hud.hidden = false;
    ui.fab.hidden = true;
    syncRootVisibility();
  }

  function hideHud() {
    const ui = state.ui;
    if (ui.hud) ui.hud.hidden = true;
    if (ui.fab) ui.fab.hidden = true;
    clearNoticeTimer();
    syncRootVisibility();
  }

  function collapseHud(collapsed) {
    ensureHud();
    const ui = state.ui;
    if (collapsed) {
      ui.hud.hidden = true;
      ui.fab.hidden = false;
    } else {
      ui.hud.hidden = false;
      ui.fab.hidden = true;
    }
    syncRootVisibility();
  }

  function clearNoticeTimer() {
    if (state.noticeTimer) {
      window.clearTimeout(state.noticeTimer);
      state.noticeTimer = 0;
    }
  }

  function setHudStatus(kind, title, sub) {
    state.hudStatus = { kind: kind || 'notice', title: title || '', sub: sub || '' };
    ensureHud();
    showHud();
    renderHud();
    clearNoticeTimer();
    if ((kind === 'notice' || kind === 'idle') && !state.active && !state.running) {
      state.noticeTimer = window.setTimeout(function () {
        state.noticeTimer = 0;
        if (!state.active && !state.running) hideHud();
      }, NOTICE_AUTO_HIDE_MS);
    }
  }

  function showHudError(message) {
    state.lastError = String(message || '').trim() || '翻译失败：未知错误';
    state.hudStatus = { kind: 'error', title: '翻译未完成', sub: '' };
    ensureHud();
    collapseHud(false);
    renderHud();
  }

  function renderHud() {
    const ui = state.ui;
    if (!ui.hud || !ui.hudRefs) return;
    const refs = ui.hudRefs;
    let kind = 'idle';
    let title = '术语精准翻译';
    let sub = currentProviderLabel();

    if (state.running) {
      kind = 'running';
      title = '正在翻译…';
      sub = (state.progress.total ? state.progress.done + '/' + state.progress.total + ' 段 · ' : '') + currentProviderLabel();
    } else if (state.active) {
      kind = 'done';
      title = '已翻译 ' + state.translatedCount + ' 段';
      sub = currentProviderLabel();
      if (state.failedCount > 0) sub += ' · ' + state.failedCount + ' 段失败';
      if (state.lostMarkerCount > 0) sub += ' · ' + state.lostMarkerCount + ' 段保留原文';
    } else if (state.hudStatus) {
      kind = state.hudStatus.kind || 'notice';
      title = state.hudStatus.title || '';
      sub = state.hudStatus.sub || '';
    }

    ui.hud.dataset.state = kind;
    refs.title.textContent = title;
    refs.sub.textContent = sub;
    refs.modeButton.textContent = state.mode === 'bilingual' ? '仅译文' : '双语对照';
    refs.modeButton.hidden = !state.active;
    refs.restoreButton.hidden = !(state.active || state.running);
    refs.dismissButton.hidden = !(state.lastError || (state.hudStatus && !state.active && !state.running));
    refs.progressRow.hidden = !state.running;
    const percent = state.progress.total
      ? Math.max(0, Math.min(100, Math.round((state.progress.done / state.progress.total) * 100)))
      : 0;
    refs.progressFill.style.width = percent + '%';
    refs.progressText.textContent = state.progress.total ? state.progress.done + '/' + state.progress.total : '';

    if (state.lastError) {
      refs.errorRow.hidden = false;
      refs.errorText.textContent = state.lastError;
      refs.optionsButton.hidden = false;
    } else {
      refs.errorRow.hidden = true;
      refs.errorText.textContent = '';
    }

    if (ui.fab) ui.fab.dataset.busy = state.running ? 'true' : 'false';
  }

  function onHudAction(action) {
    switch (action) {
      case 'toggle-mode':
        void setPageMode(state.mode === 'bilingual' ? 'replace' : 'bilingual', { persist: true });
        break;
      case 'restore':
        void restorePage();
        break;
      case 'collapse':
        collapseHud(true);
        break;
      case 'expand':
        collapseHud(false);
        renderHud();
        break;
      case 'open-options':
        void openOptionsPage();
        break;
      case 'dismiss':
        if (!state.active) {
          hideHud();
          state.hudStatus = null;
        } else {
          state.lastError = '';
          state.hudStatus = null;
          renderHud();
        }
        break;
      default:
        break;
    }
  }

  async function openOptionsPage() {
    try {
      await sendToBackground({ type: MSG.OPEN_OPTIONS });
    } catch (error) {
      // 退化方案：让用户手动打开扩展设置
      setHudStatus('notice', '请手动打开设置', '右键扩展图标 →「扩展选项」，或在 edge://extensions 中打开设置');
    }
  }

  /* ================================================================
   * 划词翻译：浮动按钮 + 译文卡片
   * ================================================================ */

  function ensureSelectionButton() {
    if (state.ui.selectionBtn) return state.ui.selectionBtn;
    const root = ensureRoot();
    const button = createButton('dsh-selection-btn', '译', 'translate-selection', '翻译选中文字');
    button.setAttribute('aria-label', '翻译选中文字');
    button.hidden = true;
    // 阻止默认行为以保留页面选区
    button.addEventListener('mousedown', function (event) {
      event.preventDefault();
    });
    root.appendChild(button);
    state.ui.selectionBtn = button;
    return button;
  }

  function showSelectionButton(rect) {
    const button = ensureSelectionButton();
    button.hidden = false;
    syncRootVisibility();
    positionFloating(button, rect, { width: 38, height: 38, gap: 8 });
  }

  function hideSelectionButton() {
    if (!state.ui.selectionBtn || state.ui.selectionBtn.hidden) return;
    state.ui.selectionBtn.hidden = true;
    syncRootVisibility();
  }

  function ensureCard() {
    if (state.ui.card) return state.ui.card;
    const root = ensureRoot();

    const card = createEl('div', 'dsh-card');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', '划词翻译结果');
    card.hidden = true;

    const head = createEl('div', 'dsh-card-head');
    const headText = createEl('div', 'dsh-card-head-text');
    const cardTitle = createEl('span', 'dsh-card-title');
    cardTitle.textContent = '划词翻译';
    const providerLabel = createEl('span', 'dsh-card-provider');
    headText.appendChild(cardTitle);
    headText.appendChild(providerLabel);
    const closeButton = createButton('dsh-icon-btn', '×', 'card-close', '关闭');
    closeButton.setAttribute('aria-label', '关闭翻译卡片');
    head.appendChild(headText);
    head.appendChild(closeButton);

    const body = createEl('div', 'dsh-card-body');
    const loading = createEl('div', 'dsh-card-loading');
    const loadingText = createEl('span', 'dsh-card-loading-text', '翻译中…');
    loading.appendChild(createEl('span', 'dsh-spinner'));
    loading.appendChild(loadingText);

    const translation = createEl('div', 'dsh-card-translation');
    translation.hidden = true;
    const terms = createEl('div', 'dsh-card-terms');
    terms.hidden = true;
    const detail = createEl('div', 'dsh-card-detail');
    detail.hidden = true;
    const errorBox = createEl('div', 'dsh-card-error');
    errorBox.hidden = true;

    body.appendChild(loading);
    body.appendChild(translation);
    body.appendChild(terms);
    body.appendChild(detail);
    body.appendChild(errorBox);

    const foot = createEl('div', 'dsh-card-foot');
    const copyButton = createButton('dsh-btn dsh-btn-ghost', '复制译文', 'card-copy', '复制译文');
    copyButton.hidden = true;
    const retryButton = createButton('dsh-btn dsh-btn-ghost', '重试', 'card-retry', '重新翻译');
    retryButton.hidden = true;
    const hint = createEl('span', 'dsh-card-hint', 'Esc 关闭');
    foot.appendChild(copyButton);
    foot.appendChild(retryButton);
    foot.appendChild(hint);

    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(foot);
    root.appendChild(card);

    // 术语 chip 点击 / 悬停：显示英文与注释
    terms.addEventListener('click', function (event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const chip = target.closest('.dsh-chip');
      if (!chip) return;
      const index = Number(chip.getAttribute('data-index'));
      renderTermDetail(index);
    });
    terms.addEventListener('mouseover', function (event) {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const chip = target.closest('.dsh-chip');
      if (!chip) return;
      const index = Number(chip.getAttribute('data-index'));
      renderTermDetail(index);
    });

    state.ui.card = card;
    state.ui.cardRefs = {
      providerLabel: providerLabel,
      loading: loading,
      loadingText: loadingText,
      translation: translation,
      terms: terms,
      detail: detail,
      error: errorBox,
      copyButton: copyButton,
      retryButton: retryButton,
    };
    return card;
  }

  function showCard(anchorRect) {
    const card = ensureCard();
    state.cardAnchor = anchorRect || null;
    card.hidden = false;
    syncRootVisibility();
    positionFloating(card, anchorRect, { gap: 10 });
  }

  function closeCard() {
    if (!state.ui.card || state.ui.card.hidden) return;
    state.ui.card.hidden = true;
    state.selectionRequestId += 1; // 使进行中的请求失效
    syncRootVisibility();
  }

  function isCardVisible() {
    return Boolean(state.ui.card && !state.ui.card.hidden);
  }

  function setCardLoading() {
    const refs = state.ui.cardRefs;
    if (!refs) return;
    refs.loading.hidden = false;
    refs.translation.hidden = true;
    refs.terms.hidden = true;
    refs.detail.hidden = true;
    refs.error.hidden = true;
    refs.copyButton.hidden = true;
    refs.retryButton.hidden = true;
    refs.providerLabel.textContent = '';
    updateCardPosition();
  }

  function setCardError(message) {
    const refs = state.ui.cardRefs;
    if (!refs) return;
    refs.loading.hidden = true;
    refs.translation.hidden = true;
    refs.terms.hidden = true;
    refs.detail.hidden = true;
    refs.error.hidden = false;
    refs.error.textContent = message;
    refs.copyButton.hidden = true;
    refs.retryButton.hidden = false;
    updateCardPosition();
  }

  function setCardResult(response) {
    const refs = state.ui.cardRefs;
    if (!refs) return;
    const translation = typeof response.translation === 'string' ? response.translation.trim() : '';
    if (!translation) {
      setCardError('翻译结果为空，请稍后重试');
      return;
    }
    state.cardCopyText = translation;
    refs.loading.hidden = true;
    refs.error.hidden = true;
    refs.retryButton.hidden = true;
    refs.translation.hidden = false;
    refs.translation.textContent = translation;
    refs.providerLabel.textContent = response.provider ? String(response.provider) : currentProviderLabel();

    // 术语 chips
    clearNode(refs.terms);
    refs.detail.hidden = true;
    clearNode(refs.detail);
    const terms = Array.isArray(response.terms) ? response.terms : [];
    if (terms.length > 0) {
      state.cardTerms = terms;
      const label = createEl('span', 'dsh-card-terms-label', '命中术语');
      refs.terms.appendChild(label);
      terms.forEach(function (term, index) {
        const chip = createButton('dsh-chip', term.zh || term.en || '', '', '');
        chip.removeAttribute('data-dsh-action');
        chip.setAttribute('data-index', String(index));
        const titleText = term.note ? term.en + ' — ' + term.note : String(term.en || '');
        chip.title = titleText;
        refs.terms.appendChild(chip);
      });
      refs.terms.hidden = false;
    } else {
      state.cardTerms = [];
      refs.terms.hidden = true;
    }
    refs.copyButton.hidden = false;
    refs.copyButton.textContent = '复制译文';
    updateCardPosition();
  }

  function renderTermDetail(index) {
    const refs = state.ui.cardRefs;
    const terms = state.cardTerms || [];
    if (!refs || !Number.isFinite(index) || !terms[index]) return;
    const term = terms[index];
    clearNode(refs.detail);
    const english = createEl('span', 'dsh-term-en', String(term.en || ''));
    const chinese = createEl('span', 'dsh-term-zh', String(term.zh || ''));
    refs.detail.appendChild(english);
    refs.detail.appendChild(chinese);
    if (term.note) refs.detail.appendChild(createEl('span', 'dsh-term-note', String(term.note)));
    if (term.category) refs.detail.appendChild(createEl('span', 'dsh-term-category', '分类：' + term.category));
    refs.detail.hidden = false;
  }

  function updateCardPosition() {
    if (!state.ui.card || state.ui.card.hidden) return;
    positionFloating(state.ui.card, state.cardAnchor, { gap: 10 });
  }

  /** 把浮层放到锚点附近，自动夹在视口内 */
  function positionFloating(element, anchorRect, options) {
    const settings = options || {};
    const margin = 10;
    const gap = typeof settings.gap === 'number' ? settings.gap : 8;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 1024;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 768;

    element.style.left = '0px';
    element.style.top = '0px';
    const rect = element.getBoundingClientRect();
    const width = settings.width || rect.width || 320;
    const height = settings.height || rect.height || 200;

    const anchor = anchorRect && anchorRect.width + anchorRect.height > 0
      ? anchorRect
      : { left: viewportWidth / 2, right: viewportWidth / 2, top: viewportHeight * 0.22, bottom: viewportHeight * 0.22, width: 0, height: 0 };

    let left;
    if (settings.width) {
      // 小圆钮：贴在选区右侧（越界时由下方夹取逻辑处理）
      left = anchor.right + 6;
    } else {
      left = anchor.left + (anchor.width || 0) / 2 - width / 2;
    }
    left = Math.max(margin, Math.min(left, viewportWidth - width - margin));

    let top = anchor.bottom + gap;
    if (top + height > viewportHeight - margin) {
      top = anchor.top - height - gap;
    }
    if (top < margin) {
      top = Math.max(margin, Math.min(anchor.bottom + gap, viewportHeight - height - margin));
    }
    element.style.left = Math.round(left) + 'px';
    element.style.top = Math.round(top) + 'px';
  }

  async function copyText(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (error) {
      // 继续使用退化方案
    }
    try {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.top = '-1000px';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      const ok = document.execCommand('copy');
      textarea.remove();
      return ok;
    } catch (error) {
      return false;
    }
  }

  /* ---------------------------- 选区读取 ---------------------------- */

  function readSelectionRange() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const text = String(selection.toString() || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    if (text.length > MAX_SELECTION_CHARS) return null;
    if (!LETTER_PATTERN.test(text)) return null;
    let range;
    try {
      range = selection.getRangeAt(0);
    } catch (error) {
      return null;
    }
    if (!range) return null;
    const container = range.commonAncestorContainer;
    const element = container && (container.nodeType === Node.ELEMENT_NODE ? container : container.parentElement);
    if (!element) return null;
    if (element.closest(UNAVAILABLE_SELECTION_SELECTOR)) return null;
    if (element.closest(EDITABLE_SELECTOR)) return null;
    if (state.ui.root && state.ui.root.contains(element)) return null;

    const rects = typeof range.getClientRects === 'function' ? range.getClientRects() : null;
    let rect = null;
    if (rects && rects.length > 0) rect = rects[rects.length - 1];
    if (!rect) rect = range.getBoundingClientRect();
    const normalizedRect = {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height,
    };
    return { text: text, rect: normalizedRect, range: range.cloneRange() };
  }

  function scheduleSelectionCheck() {
    if (!state.settings || !state.settings.selectionEnabled) return;
    if (state.selectionTimer) window.clearTimeout(state.selectionTimer);
    state.selectionTimer = window.setTimeout(checkSelection, SELECTION_DEBOUNCE_MS);
  }

  function checkSelection() {
    state.selectionTimer = 0;
    if (!state.settings || !state.settings.selectionEnabled) {
      hideSelectionButton();
      return;
    }
    const info = readSelectionRange();
    if (!info) {
      hideSelectionButton();
      return;
    }
    state.lastSelection = info;
    if (state.settings.selectionTrigger === 'auto') {
      hideSelectionButton();
      if (info.text === state.lastAutoText && isCardVisible()) return;
      state.lastAutoText = info.text;
      void translateSelection(info);
      return;
    }
    showSelectionButton(info.rect);
  }

  async function translateSelection(info) {
    if (!info || !info.text) return;
    const requestId = state.selectionRequestId + 1;
    state.selectionRequestId = requestId;
    state.cardInfo = info;
    state.cardTerms = [];
    hideSelectionButton();
    ensureCard();
    showCard(info.rect);
    setCardLoading();

    const settings = await ensureSettings();
    if (requestId !== state.selectionRequestId) return;
    if (!settings) {
      setCardError('翻译失败：无法读取扩展设置，请刷新页面后重试');
      return;
    }
    if (!settings.providerConfigured) {
      setCardError('翻译失败：请先在设置中配置「' + (settings.providerLabel || '当前服务商') + '」的密钥');
      return;
    }
    try {
      const response = await sendToBackground({
        type: MSG.TRANSLATE_SELECTION,
        text: info.text,
        url: location.href,
        title: document.title,
      });
      if (requestId !== state.selectionRequestId) return;
      if (!response || response.ok !== true) {
        setCardError(formatTranslationError(extractErrorMessage(response)));
        return;
      }
      setCardResult(response);
    } catch (error) {
      if (requestId !== state.selectionRequestId) return;
      setCardError(formatTranslationError(normalizeErrorMessage(error)));
    }
  }

  async function retrySelectionTranslation() {
    const info = state.cardInfo || state.lastSelection;
    if (!info) {
      setCardError('翻译失败：选区已失效，请重新选中文字');
      return;
    }
    await translateSelection(info);
  }

  /* ================================================================
   * 整页翻译：块收集与文本提取
   * ================================================================ */

  function isElementVisible(element) {
    if (!element || !element.isConnected) return false;
    if (element.hidden) return false;
    if (element.closest('[hidden]')) return false;
    if (element.getClientRects().length === 0) return false;
    const style = window.getComputedStyle(element);
    if (style && (style.display === 'none' || style.visibility === 'hidden')) return false;
    return true;
  }

  function isInlineElementVisible(element) {
    if (!element || !element.isConnected) return false;
    if (element.hidden) return false;
    if (element.getClientRects().length > 0) return true;
    const style = window.getComputedStyle(element);
    return !!style && style.display === 'contents';
  }

  function hasBlockLevelDescendant(element) {
    return element.querySelector(BLOCK_LEVEL_SELECTOR) !== null;
  }

  /** 递归提取块文本，行内代码替换为占位符 */
  function collectBlockText(node, parts, codeNodes) {
    const children = node.childNodes;
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (child.nodeType === Node.TEXT_NODE) {
        parts.push(child.nodeValue || '');
        continue;
      }
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const element = child;
      const tagName = element.tagName;

      if (INLINE_CODE_TAGS.has(tagName)) {
        const codeText = element.textContent || '';
        if (codeText.trim()) {
          codeNodes.push(codeText);
          parts.push('⟦C' + (codeNodes.length - 1) + '⟧');
        }
        continue;
      }
      if (tagName === 'BR') {
        parts.push(' ');
        continue;
      }
      if (SKIP_SUBTREE_TAGS.has(tagName)) continue;
      if (tagName === 'IMG') continue;
      if (element.hasAttribute('data-dsh-ignore') || element.hasAttribute('data-dsh-block')) continue;
      if (element.getAttribute('aria-hidden') === 'true') continue;
      const editable = element.getAttribute('contenteditable');
      if (editable !== null && editable !== 'false') continue;
      if (!isInlineElementVisible(element)) continue;
      collectBlockText(element, parts, codeNodes);
    }
  }

  function shouldSkipByLanguage(text) {
    const settings = state.settings;
    if (!settings) return false;
    const targetLang = String(settings.targetLang || '');
    if (!/^zh/i.test(targetLang)) return false;
    // 目标为中文且整段没有任何拉丁 / 西里尔字母时（已经是中文），无需翻译
    return !LATIN_LETTER_PATTERN.test(text);
  }

  function createBlockRecord(element) {
    const parts = [];
    const codeNodes = [];
    try {
      collectBlockText(element, parts, codeNodes);
    } catch (error) {
      return null;
    }
    const text = parts.join('').replace(/\s+/g, ' ').trim();
    if (!text) return null;
    if (!LETTER_PATTERN.test(text)) return null;
    if (shouldSkipByLanguage(text)) return null;
    if (state.failedBlocks.has(element)) return null;
    return { el: element, text: text, codeNodes: codeNodes };
  }

  /** 收集当前页面所有待翻译块（自动排除已翻译、隐藏、代码区等） */
  function collectTranslatableBlocks() {
    const candidates = [];
    let nodes;
    try {
      nodes = document.querySelectorAll(TRANSLATABLE_SELECTOR);
    } catch (error) {
      return [];
    }
    for (let index = 0; index < nodes.length; index += 1) {
      const element = nodes[index];
      if (state.processedBlocks.has(element) || state.failedBlocks.has(element)) continue;
      if (element.hasAttribute('data-dsh-block')) continue;
      if (element.closest(SKIP_ANCESTOR_SELECTOR)) continue;
      if (!isElementVisible(element)) continue;
      if (GENERIC_CONTAINER_TAGS.has(element.tagName) && hasBlockLevelDescendant(element)) continue;
      candidates.push(element);
    }

    // 只保留最内层候选块：若某候选是另一个候选的祖先，则丢弃祖先，避免重复翻译
    const candidateSet = new Set(candidates);
    const removed = new Set();
    for (let index = 0; index < candidates.length; index += 1) {
      let parent = candidates[index].parentElement;
      while (parent && parent !== document.documentElement) {
        if (candidateSet.has(parent)) removed.add(parent);
        parent = parent.parentElement;
      }
    }

    const records = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const element = candidates[index];
      if (removed.has(element)) continue;
      const record = createBlockRecord(element);
      if (record) records.push(record);
    }
    return records;
  }

  /* ================================================================
   * 整页翻译：批处理调度
   * ================================================================ */

  /** 用 IntersectionObserver 把视口内（含提前 200px）的块排到最前面 */
  function orderByViewport(records) {
    if (records.length <= 1 || typeof IntersectionObserver !== 'function') {
      return Promise.resolve(records);
    }
    return new Promise(function (resolve) {
      const visible = new Set();
      let finished = false;
      let observer = null;

      function finish() {
        if (finished) return;
        finished = true;
        if (observer) {
          try {
            observer.disconnect();
          } catch (error) {
            // 忽略
          }
        }
        const first = [];
        const second = [];
        for (let index = 0; index < records.length; index += 1) {
          const record = records[index];
          if (visible.has(record.el)) first.push(record);
          else second.push(record);
        }
        resolve(first.concat(second));
      }

      try {
        observer = new IntersectionObserver(function (entries) {
          for (let index = 0; index < entries.length; index += 1) {
            if (entries[index].isIntersecting) visible.add(entries[index].target);
          }
          finish();
        }, { rootMargin: '200px 0px 200px 0px' });
        for (let index = 0; index < records.length; index += 1) observer.observe(records[index].el);
      } catch (error) {
        finish();
        return;
      }
      window.setTimeout(finish, 150);
    });
  }

  function buildBatches(records, charLimit) {
    const batches = [];
    let current = null;
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      const length = record.text.length;
      if (!current) current = { records: [], chars: 0 };
      if (current.records.length > 0 && (current.records.length >= MAX_BATCH_TEXTS || current.chars + length > charLimit)) {
        batches.push(current);
        current = { records: [], chars: 0 };
      }
      current.records.push(record);
      current.chars += length;
    }
    if (current && current.records.length > 0) batches.push(current);
    return batches;
  }

  async function processBatch(batch, token) {
    const texts = batch.records.map(function (record) {
      return record.text;
    });
    try {
      const response = await sendToBackground({
        type: MSG.TRANSLATE_BATCH,
        texts: texts,
        url: location.href,
        title: document.title,
      });
      if (token !== state.runToken) return;
      if (!response || response.ok !== true) {
        handleBatchFailure(batch, extractErrorMessage(response));
        return;
      }
      if (Array.isArray(response.warnings)) {
        for (let index = 0; index < response.warnings.length; index += 1) {
          const warning = response.warnings[index];
          if (warning) state.warnings.push(String(warning));
        }
      }
      const translations = Array.isArray(response.translations) ? response.translations : [];
      for (let index = 0; index < batch.records.length; index += 1) {
        if (token !== state.runToken) return;
        const record = batch.records[index];
        const raw = typeof translations[index] === 'string' ? translations[index] : '';
        const translation = raw.trim();
        if (translation) {
          applyBlockTranslation(record, translation);
        } else {
          state.failedBlocks.add(record.el);
          state.failedCount += 1;
        }
        state.progress.done += 1;
        renderHud();
      }
    } catch (error) {
      if (token !== state.runToken) return;
      handleBatchFailure(batch, normalizeErrorMessage(error));
    }
  }

  function handleBatchFailure(batch, message) {
    const formatted = formatTranslationError(message);
    state.failedCount += batch.records.length;
    state.progress.done += batch.records.length;
    for (let index = 0; index < batch.records.length; index += 1) {
      state.failedBlocks.add(batch.records[index].el);
    }
    if (!state.lastError) state.lastError = formatted;
    renderHud();
  }

  async function runBatchPool(batches, token) {
    if (!batches.length) return;
    let cursor = 0;
    const workerCount = Math.min(MAX_CONCURRENT_BATCHES, batches.length);
    const workers = [];

    async function runWorker() {
      for (;;) {
        if (token !== state.runToken) return;
        const current = cursor;
        cursor += 1;
        if (current >= batches.length) return;
        await processBatch(batches[current], token);
      }
    }

    for (let index = 0; index < workerCount; index += 1) workers.push(runWorker());
    await Promise.all(workers);
  }

  /* ================================================================
   * 整页翻译：译文渲染 / 还原 / 模式切换
   * ================================================================ */

  /** 按 ⟦Cn⟧ 占位符拆分译文；标记丢失或重复时返回 null（放弃该块） */
  function splitTranslationByCodeMarkers(translation, expectedCount) {
    const seen = new Map();
    CODE_MARKER_PATTERN.lastIndex = 0;
    let match = CODE_MARKER_PATTERN.exec(translation);
    while (match) {
      const markerIndex = Number(match[1]);
      seen.set(markerIndex, (seen.get(markerIndex) || 0) + 1);
      match = CODE_MARKER_PATTERN.exec(translation);
    }
    if (seen.size !== expectedCount) return null;
    for (let index = 0; index < expectedCount; index += 1) {
      if (seen.get(index) !== 1) return null;
    }
    const segments = [];
    let lastIndex = 0;
    CODE_MARKER_PATTERN.lastIndex = 0;
    match = CODE_MARKER_PATTERN.exec(translation);
    while (match) {
      if (match.index > lastIndex) {
        segments.push({ type: 'text', text: translation.slice(lastIndex, match.index) });
      }
      segments.push({ type: 'code', index: Number(match[1]) });
      lastIndex = match.index + match[0].length;
      match = CODE_MARKER_PATTERN.exec(translation);
    }
    if (lastIndex < translation.length) {
      segments.push({ type: 'text', text: translation.slice(lastIndex) });
    }
    return segments;
  }

  function shouldHighlightTerms() {
    const settings = state.settings;
    if (!settings || !settings.highlightTerms) return false;
    return /^zh/i.test(String(settings.targetLang || ''));
  }

  function buildGlossaryMatcher(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return null;
    const byZh = new Map();
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry || typeof entry !== 'object') continue;
      const zh = String(entry.zh || '').trim();
      if (!zh || zh.length > 80) continue;
      if (!byZh.has(zh)) byZh.set(zh, entry);
    }
    if (byZh.size === 0) return null;
    const terms = Array.from(byZh.keys()).sort(function (a, b) {
      return b.length - a.length || a.localeCompare(b);
    });
    const pattern = terms.map(escapeRegExp).join('|');
    if (!pattern) return null;
    return { regex: new RegExp(pattern, 'g'), byZh: byZh };
  }

  /** 插入译文文本，并按术语表高亮命中术语 */
  function appendHighlightedText(parent, text) {
    if (!text) return;
    const glossary = state.glossary;
    if (!glossary || !glossary.matcher || !shouldHighlightTerms()) {
      parent.appendChild(document.createTextNode(text));
      return;
    }
    const regex = glossary.matcher.regex;
    const byZh = glossary.matcher.byZh;
    regex.lastIndex = 0;
    let lastIndex = 0;
    let match = regex.exec(text);
    while (match) {
      const matched = match[0];
      if (match.index > lastIndex) parent.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
      const entry = byZh.get(matched);
      if (entry) {
        const chip = document.createElement('span');
        chip.className = 'dsh-term';
        chip.setAttribute('data-dsh-term', '');
        const title = entry.note ? String(entry.en) + ' — ' + String(entry.note) : String(entry.en || '');
        chip.setAttribute('title', title);
        chip.textContent = matched;
        parent.appendChild(chip);
      } else {
        parent.appendChild(document.createTextNode(matched));
      }
      lastIndex = match.index + matched.length;
      if (matched === '') regex.lastIndex += 1;
      match = regex.exec(text);
    }
    if (lastIndex < text.length) parent.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  /** 把原块内容包进 .dsh-original，便于「仅译文」模式隐藏与还原 */
  function wrapOriginalContent(element) {
    const first = element.firstElementChild;
    if (first && first.classList && first.classList.contains('dsh-original')) return first;
    const wrapper = document.createElement('span');
    wrapper.className = 'dsh-original';
    wrapper.setAttribute('data-dsh-ignore', '');
    while (element.firstChild) wrapper.appendChild(element.firstChild);
    element.appendChild(wrapper);
    return wrapper;
  }

  function applyBlockTranslation(record, translation) {
    const element = record.el;
    if (!element || !element.isConnected) return false;
    if (element.hasAttribute('data-dsh-block')) return false;
    const segments = splitTranslationByCodeMarkers(translation, record.codeNodes.length);
    if (!segments) {
      state.lostMarkerCount += 1;
      state.failedBlocks.add(element);
      return false;
    }

    const wrapper = wrapOriginalContent(element);
    const translationNode = document.createElement('div');
    translationNode.className = 'dsh-translation';
    translationNode.setAttribute('data-dsh-ignore', '');
    translationNode.setAttribute('lang', (state.settings && state.settings.targetLang) || 'zh-CN');
    translationNode.setAttribute('dir', 'auto');

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      if (segment.type === 'code') {
        const code = document.createElement('code');
        code.className = 'dsh-inline-code';
        code.textContent = record.codeNodes[segment.index] || '';
        translationNode.appendChild(code);
      } else {
        appendHighlightedText(translationNode, segment.text);
      }
    }

    element.setAttribute('data-dsh-block', '');
    element.setAttribute('data-dsh-block-tag', element.tagName.toLowerCase());
    state.processedBlocks.add(element);
    if (INNER_APPEND_TAGS.has(element.tagName)) {
      element.appendChild(translationNode);
    } else if (element.parentElement) {
      element.parentElement.insertBefore(translationNode, element.nextSibling);
    } else {
      wrapper.remove();
      element.removeAttribute('data-dsh-block');
      state.processedBlocks.delete(element);
      state.failedBlocks.add(element);
      return false;
    }
    state.translatedCount += 1;
    return true;
  }

  function applyModeAttribute() {
    if (state.active) document.documentElement.setAttribute('data-dsh-mode', state.mode);
    else document.documentElement.removeAttribute('data-dsh-mode');
  }

  /** 状态条切模式时同步持久化，保证下次整页翻译沿用该模式 */
  function persistPageMode(mode) {
    try {
      if (!isExtensionContext() || !chrome.storage || !chrome.storage.local) return;
      chrome.storage.local.get(SETTINGS_STORAGE_KEY, function (stored) {
        const current = stored && stored[SETTINGS_STORAGE_KEY];
        if (!current || typeof current !== 'object') return;
        const next = Object.assign({}, current, { pageMode: mode });
        chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: next });
      });
    } catch (error) {
      // 持久化失败不影响当前页面切换
    }
  }

  async function setPageMode(mode, options) {
    state.mode = mode === 'replace' ? 'replace' : 'bilingual';
    applyModeAttribute();
    if (state.ui.hud) renderHud();
    if (!options || options.persist !== false) persistPageMode(state.mode);
    return { mode: state.mode };
  }

  /* ================================================================
   * 整页翻译：主流程
   * ================================================================ */

  function beginPageTranslation(settings) {
    if (state.active || state.translatedCount > 0) restorePageSync();
    state.active = true;
    state.running = true;
    state.spaPending = false;
    state.runToken += 1;
    state.progress = { done: 0, total: 0 };
    state.translatedCount = 0;
    state.failedCount = 0;
    state.lostMarkerCount = 0;
    state.lastError = '';
    state.hudStatus = null;
    state.warnings = [];
    state.failedBlocks.clear();
    state.mode = settings.pageMode === 'replace' ? 'replace' : 'bilingual';
    applyModeAttribute();
    ensureHud();
    showHud();
    renderHud();
    startObserver();

    const token = state.runToken;
    void runTranslation(token, settings).catch(function (error) {
      finishTranslation(token, error);
    });
  }

  async function runTranslation(token, settings) {
    await ensureGlossary();
    if (token !== state.runToken) return;
    const records = collectTranslatableBlocks();
    if (token !== state.runToken) return;
    state.progress.total = records.length;
    renderHud();
    if (records.length === 0) {
      finishTranslation(token, null, 'empty');
      return;
    }
    const ordered = await orderByViewport(records);
    if (token !== state.runToken) return;
    const batches = buildBatches(ordered, clampBatchCharLimit(settings.batchCharLimit));
    await runBatchPool(batches, token);
    if (token !== state.runToken) return;
    finishTranslation(token, null);
  }

  function finishTranslation(token, error, reason) {
    if (token !== state.runToken) return;
    state.running = false;

    if (error) {
      state.lastError = formatTranslationError(normalizeErrorMessage(error));
      state.hudStatus = { kind: 'error', title: '翻译未完成', sub: '' };
      if (state.translatedCount === 0) {
        state.active = false;
        teardownTranslation();
      }
      ensureHud();
      showHud();
      renderHud();
      return;
    }

    if (reason === 'empty') {
      state.active = false;
      teardownTranslation();
      setHudStatus('notice', '未找到可翻译的内容', '这个页面里没有适合翻译的正文段落');
      return;
    }

    state.active = state.translatedCount > 0;
    state.hudStatus = null;
    ensureHud();
    showHud();
    renderHud();
    applyModeAttribute();

    if (!state.active) {
      teardownTranslation();
      setHudStatus('notice', '没有可显示的内容', '翻译结果为空，页面保持原样');
      return;
    }
    if (state.spaPending) {
      state.spaPending = false;
      scheduleSpaScan();
    } else {
      scheduleSpaScan(400);
    }
  }

  function teardownTranslation() {
    stopObserver();
    clearSpaTimer();
    document.documentElement.removeAttribute('data-dsh-mode');
    state.spaPending = false;
  }

  function restorePageSync() {
    stopObserver();
    clearSpaTimer();
    state.runToken += 1;

    // 移除所有译文节点
    let translations;
    try {
      translations = document.querySelectorAll('.dsh-translation[data-dsh-ignore]');
    } catch (error) {
      translations = [];
    }
    for (let index = 0; index < translations.length; index += 1) {
      if (translations[index].parentNode) translations[index].parentNode.removeChild(translations[index]);
    }

    // 还原被包装的原文
    let blocks;
    try {
      blocks = document.querySelectorAll('[data-dsh-block]');
    } catch (error) {
      blocks = [];
    }
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      const first = block.firstElementChild;
      if (first && first.classList && first.classList.contains('dsh-original')) {
        while (first.firstChild) block.insertBefore(first.firstChild, first);
        first.remove();
      }
      block.removeAttribute('data-dsh-block');
      block.removeAttribute('data-dsh-block-tag');
    }

    // 清理异常残留的空包装器
    let wrappers;
    try {
      wrappers = document.querySelectorAll('.dsh-original[data-dsh-ignore]');
    } catch (error) {
      wrappers = [];
    }
    for (let index = 0; index < wrappers.length; index += 1) {
      const wrapper = wrappers[index];
      if (!wrapper.parentElement || !wrapper.parentElement.hasAttribute('data-dsh-block')) wrapper.remove();
    }

    document.documentElement.removeAttribute('data-dsh-mode');
    state.processedBlocks.clear();
    state.failedBlocks.clear();
    state.translatedCount = 0;
    state.failedCount = 0;
    state.lostMarkerCount = 0;
    state.progress = { done: 0, total: 0 };
    state.active = false;
    state.running = false;
    state.lastError = '';
    state.hudStatus = null;
  }

  async function restorePage() {
    restorePageSync();
    hideHud();
    return { ok: true, restored: true, active: false };
  }

  /* ================================================================
   * 整页翻译：SPA 动态内容
   * ================================================================ */

  function startObserver() {
    if (state.observer || typeof MutationObserver !== 'function' || !document.body) return;
    state.observer = new MutationObserver(function (mutations) {
      if (!state.active && !state.running) return;
      let interesting = false;
      for (let index = 0; index < mutations.length; index += 1) {
        const mutation = mutations[index];
        if (mutation.type !== 'childList') continue;
        const added = mutation.addedNodes;
        for (let nodeIndex = 0; nodeIndex < added.length; nodeIndex += 1) {
          if (isInterestingNode(added[nodeIndex])) {
            interesting = true;
            break;
          }
        }
        if (interesting) break;
      }
      if (interesting) scheduleSpaScan();
    });
    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function stopObserver() {
    if (!state.observer) return;
    try {
      state.observer.disconnect();
    } catch (error) {
      // 忽略
    }
    state.observer = null;
  }

  function isInterestingNode(node) {
    if (!node) return false;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = String(node.nodeValue || '').trim();
      return text.length > 1 && LETTER_PATTERN.test(text);
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const element = node;
    if (element.id === ROOT_ID) return false;
    if (element.classList && (element.classList.contains('dsh-translation') || element.classList.contains('dsh-original'))) return false;
    if (element.hasAttribute('data-dsh-ignore') || element.hasAttribute('data-dsh-block')) return false;
    const text = String(element.textContent || '').trim();
    return text.length > 1 && LETTER_PATTERN.test(text);
  }

  function clearSpaTimer() {
    if (state.spaTimer) {
      window.clearTimeout(state.spaTimer);
      state.spaTimer = 0;
    }
  }

  function scheduleSpaScan(delay) {
    if (!state.active && !state.running) return;
    if (state.running) {
      state.spaPending = true;
      return;
    }
    clearSpaTimer();
    state.spaTimer = window.setTimeout(function () {
      state.spaTimer = 0;
      void translateNewBlocks();
    }, typeof delay === 'number' ? delay : SPA_DEBOUNCE_MS);
  }

  async function translateNewBlocks() {
    if (state.running || !state.active) return;
    const records = collectTranslatableBlocks();
    if (records.length === 0) return;
    const token = state.runToken;
    state.running = true;
    state.spaPending = false;
    state.progress.total += records.length;
    renderHud();
    try {
      await ensureGlossary();
      if (token !== state.runToken) return;
      const ordered = await orderByViewport(records);
      if (token !== state.runToken) return;
      const settings = state.settings || {};
      const batches = buildBatches(ordered, clampBatchCharLimit(settings.batchCharLimit));
      await runBatchPool(batches, token);
      if (token !== state.runToken) return;
    } catch (error) {
      if (token !== state.runToken) return;
      state.lastError = state.lastError || formatTranslationError(normalizeErrorMessage(error));
    } finally {
      if (token === state.runToken) {
        state.running = false;
        state.active = state.translatedCount > 0;
        if (state.spaPending) {
          state.spaPending = false;
          scheduleSpaScan();
        }
        renderHud();
        applyModeAttribute();
      }
    }
  }

  /* ================================================================
   * 页面状态
   * ================================================================ */

  function getPageStatus() {
    return {
      ok: true,
      active: state.active,
      running: state.running,
      mode: state.mode,
      providerLabel: currentProviderLabel(),
      translatedCount: state.translatedCount,
      total: state.progress.total,
      progress: { done: state.progress.done, total: state.progress.total },
    };
  }

  /* ================================================================
   * 消息处理
   * ================================================================ */

  function createResponder(sendResponse) {
    let done = false;
    return function respond(payload) {
      if (done) return;
      done = true;
      try {
        sendResponse(payload);
      } catch (error) {
        // 页面可能已关闭，忽略
      }
    };
  }

  async function handleTranslateRequest() {
    const settings = await ensureSettings(true);
    if (!settings) {
      return { ok: false, error: { code: 'SETTINGS_UNAVAILABLE', message: '无法读取扩展设置，请刷新页面后重试' } };
    }
    if (isExcludedSite(settings)) {
      setHudStatus('notice', '该站点已在排除列表', '如需整页翻译，请在设置页的「站点排除」中移除该域名');
      return { ok: true, started: false, excluded: true };
    }
    if (!settings.providerConfigured) {
      showHudError('翻译失败：请先在设置中配置「' + (settings.providerLabel || '当前服务商') + '」的密钥');
      return { ok: true, started: false, configured: false };
    }
    if (state.running) return { ok: true, started: false, alreadyRunning: true };
    beginPageTranslation(settings);
    return { ok: true, started: true };
  }

  async function handleRestoreRequest() {
    await restorePage();
    return { ok: true, restored: true, active: state.active };
  }

  async function handleSetModeRequest(message) {
    // popup / 后台已负责保存设置，这里只切换当前页面
    const result = await setPageMode(message && message.mode, { persist: false });
    return { ok: true, mode: result.mode };
  }

  async function handleSelectionTranslateRequest() {
    const settings = await ensureSettings(true);
    if (!settings) {
      return { ok: false, error: { code: 'SETTINGS_UNAVAILABLE', message: '无法读取扩展设置，请刷新页面后重试' } };
    }
    const info = readSelectionRange() || state.lastSelection;
    if (!info || !info.text) {
      setHudStatus('notice', '未选中文字', '请先用鼠标选中要翻译的文字（最多 ' + MAX_SELECTION_CHARS + ' 字符）');
      return { ok: false, error: { code: 'NO_SELECTION', message: '未选中文字' } };
    }
    state.lastSelection = info;
    void translateSelection(info);
    return { ok: true, started: true };
  }

  function handleRuntimeMessage(message, sender, sendResponse) {
    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      const respondInvalid = createResponder(sendResponse);
      respondInvalid({ ok: false, error: { code: 'UNKNOWN_MESSAGE', message: '未知的消息格式' } });
      return false;
    }

    switch (message.type) {
      case MSG.PING: {
        const respond = createResponder(sendResponse);
        respond({ ok: true, ready: true });
        return false;
      }
      case MSG.PAGE_STATUS: {
        const respond = createResponder(sendResponse);
        respond(getPageStatus());
        return false;
      }
      case MSG.PAGE_TRANSLATE: {
        const respond = createResponder(sendResponse);
        handleTranslateRequest().then(respond).catch(function (error) {
          respond({ ok: false, error: { code: 'INTERNAL_ERROR', message: normalizeErrorMessage(error) } });
        });
        return true;
      }
      case MSG.PAGE_RESTORE: {
        const respond = createResponder(sendResponse);
        handleRestoreRequest().then(respond).catch(function (error) {
          respond({ ok: false, error: { code: 'INTERNAL_ERROR', message: normalizeErrorMessage(error) } });
        });
        return true;
      }
      case MSG.PAGE_SET_MODE: {
        const respond = createResponder(sendResponse);
        handleSetModeRequest(message).then(respond).catch(function (error) {
          respond({ ok: false, error: { code: 'INTERNAL_ERROR', message: normalizeErrorMessage(error) } });
        });
        return true;
      }
      case MSG.SELECTION_TRANSLATE: {
        const respond = createResponder(sendResponse);
        handleSelectionTranslateRequest().then(respond).catch(function (error) {
          respond({ ok: false, error: { code: 'INTERNAL_ERROR', message: normalizeErrorMessage(error) } });
        });
        return true;
      }
      default: {
        const respondUnknown = createResponder(sendResponse);
        respondUnknown({
          ok: false,
          error: { code: 'UNKNOWN_MESSAGE', message: '未知消息类型：' + message.type },
        });
        return false;
      }
    }
  }

  /* ================================================================
   * 全局事件
   * ================================================================ */

  function onDocumentClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const actionNode = target.closest('[data-dsh-action]');
    if (!actionNode || !state.ui.root || !state.ui.root.contains(actionNode)) return;
    const action = actionNode.getAttribute('data-dsh-action');
    if (action === 'card-close') {
      closeCard();
      return;
    }
    if (action === 'card-copy') {
      const refs = state.ui.cardRefs;
      void copyText(state.cardCopyText).then(function (ok) {
        if (!refs) return;
        refs.copyButton.textContent = ok ? '已复制' : '复制失败';
        window.setTimeout(function () {
          if (refs.copyButton) refs.copyButton.textContent = '复制译文';
        }, 1600);
      });
      return;
    }
    if (action === 'card-retry') {
      void retrySelectionTranslation();
      return;
    }
    if (action === 'translate-selection') {
      const info = state.lastSelection;
      if (info) void translateSelection(info);
      return;
    }
    onHudAction(action);
  }

  function onDocumentMouseDown(event) {
    const target = event.target;
    if (!(target instanceof Node)) return;
    if (state.ui.root && state.ui.root.contains(target)) return;
    hideSelectionButton();
    if (isCardVisible()) closeCard();
  }

  function onDocumentMouseUp(event) {
    if (!state.settings || !state.settings.selectionEnabled) return;
    const target = event.target;
    if (state.ui.root && target instanceof Node && state.ui.root.contains(target)) return;
    scheduleSelectionCheck();
  }

  function onSelectionChange() {
    if (!state.settings || !state.settings.selectionEnabled) return;
    scheduleSelectionCheck();
  }

  function onDocumentKeyDown(event) {
    if (event.key !== 'Escape') return;
    hideSelectionButton();
    if (isCardVisible()) closeCard();
  }

  function onWindowScroll() {
    hideSelectionButton();
  }

  function onWindowResize() {
    hideSelectionButton();
    updateCardPosition();
  }

  function onStorageChanged(changes, areaName) {
    if (areaName !== 'local' || !changes) return;
    if (state.settingsReloadTimer) window.clearTimeout(state.settingsReloadTimer);
    state.settingsReloadTimer = window.setTimeout(function () {
      state.settingsReloadTimer = 0;
      state.glossary = null; // 自定义术语可能变化，下次翻译时重新拉取
      void ensureSettings(true);
    }, 250);
  }

  function attachGlobalListeners() {
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('mousedown', onDocumentMouseDown, true);
    document.addEventListener('mouseup', onDocumentMouseUp, true);
    document.addEventListener('selectionchange', onSelectionChange, true);
    document.addEventListener('keydown', onDocumentKeyDown, true);
    window.addEventListener('scroll', onWindowScroll, { passive: true, capture: true });
    window.addEventListener('resize', onWindowResize, { passive: true });
    if (isExtensionContext()) {
      try {
        chrome.runtime.onMessage.addListener(handleRuntimeMessage);
      } catch (error) {
        // 忽略注册失败（极少见）
      }
      try {
        if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener(onStorageChanged);
      } catch (error) {
        // 忽略
      }
    }
  }

  /* ================================================================
   * 初始化
   * ================================================================ */

  function init() {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', init, { once: true });
      return;
    }
    ensureRoot();
    attachGlobalListeners();
    if (isExtensionContext()) void ensureSettings();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
