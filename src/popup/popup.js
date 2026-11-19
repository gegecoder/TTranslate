/**
 * ============================================================================
 * popup/popup.js —— 弹窗逻辑
 * ============================================================================
 * 原生 DOM 事件绑定。弹窗只做配置展示 + 修改，所有变更经background 的 UPDATE_CONFIG 消息合并后广播到所有 content 脚本。
 * ============================================================================
 */

import { MSG, LANGUAGES, DEFAULT_CONFIG, BUILD_MODE, TERM_TEMPLATES, redactDataUrls } from '../shared/constants.mjs';
import { playWord } from '../shared/speech.mjs';
import {
  t, setUiLang, resolveUiLang, regionLabel, langLabel, serviceName,
  collectStaticI18n, applyStaticI18n,
} from '../shared/i18n.mjs';

// 生产构建不输出任何日志
const devLog = BUILD_MODE === 'prod' ? () => {} : (...args) => console.log('[TTranslate popup]', ...args);

const ids = {
  enabled: 'cfg-enabled',
  source: 'cfg-source',
  target: 'cfg-target',
  service: 'cfg-service',
  baseUrl: 'cfg-baseUrl',
  mode: 'cfg-mode',
  theme: 'cfg-theme',
  themeColor: 'cfg-theme-color',
  themeColorCustom: 'cfg-theme-color-custom',
  themeColorRow: 'theme-color-row',
  position: 'cfg-position',
  fontScale: 'cfg-font-scale',
  textColor: 'cfg-text-color',
  textColorCustom: 'cfg-text-color-custom',
  ignoreEnabled: 'cfg-ignore-enabled',
  selection: 'cfg-selection',
  selectionMode: 'cfg-selection-mode',
  uiLanguage: 'cfg-ui-language',
  uiTheme: 'cfg-ui-theme',
  themeImage: 'cfg-theme-image',
  themeImageClear: 'btn-theme-image-clear',
  themeImageRow: 'theme-image-row',
  themeAlpha: 'cfg-theme-alpha',
  themeImageAlpha: 'cfg-theme-image-alpha',
  themeAlphaVal: 'theme-alpha-val',
  themeImageAlphaVal: 'theme-image-alpha-val',
  themeTextColor: 'cfg-theme-text-color',
  themeImagePreview: 'theme-image-preview',
  toggle: 'btn-toggle',
  test: 'btn-test',
  debugCopy: 'btn-debug-copy',
  debugClear: 'btn-debug-clear',
  debugOut: 'debug-out',
  pin: 'btn-pin',
  settingsStatus: 'settings-status',
  debugStatus: 'debug-status',
  dictPhonetic: 'cfg-dict-phonetic',
  dictSpeak: 'cfg-dict-speak',
  dictProvider: 'cfg-dict-provider',
  protectTerms: 'cfg-protect-terms',
  termsTemplate: 'cfg-terms-template',
  termsList: 'cfg-terms-list',
  termsApply: 'btn-terms-apply',
  termsReset: 'btn-terms-reset',
  textSource: 'text-source',
  textTarget: 'text-target',
  textInput: 'text-input',
  textTranslate: 'btn-text-translate',
  textStatus: 'text-status',
  textResult: 'text-result',
  textOut: 'text-out',
  textPhonetic: 'text-phonetic',
  copyText: 'btn-copy-text',
};

/**
 * 显示主题 / 字号 / 颜色 / 译文位置只对"会产生译文框"的模式有意义；
 * 原处替换、原处替换+悬停、悬停浮层（译文只在气泡里）都没有译文框可调样式，
 * 把这一组控件整体隐藏，避免无效配置。
 */
function refreshModeDependentUI() {
  const mode = document.getElementById(ids.mode).value;
  const show = !['replace', 'replaceHover', 'hoverTip'].includes(mode);
  const box = document.getElementById('mode-dependent');
  if (box) box.hidden = !show;
}

/** 只有单个英文单词才查音标、给朗读按钮 */
const WORD_RE = /^[A-Za-z][A-Za-z'’-]{0,29}$/;

let currentConfig = null;

/**
 * 固定模式：点击图钉后，popup 会以独立窗口打开自己，
 * URL 带上 pinned=1 和当时的标签页 id（targetTab）。
 * 独立窗口里没有"当前标签页"概念，必须用 targetTab 定位原页面。
 */
const params = new URLSearchParams(location.search);
const isPinned = params.get('pinned') === '1';
const pinnedTabId = Number(params.get('targetTab')) || null;

/** 初始化：从后台读配置 → 填表单 → 绑定事件 */
async function init() {
  // 在 header 右侧显示版本号（从 manifest 读，每次改代码 bump 一下）
  const man = chrome.runtime.getManifest();
  document.getElementById('version').textContent = `v${man.version}`;

  // 固定模式 & tab 栏 ----------------------------------------------------
  initPin();
  initTabs();
  initAbout();

  // 开发模式专属的卡片：翻译服务、音标与发音服务、调试信息。
  // 生产构建（--build-prod）里整块隐藏，用户看不到这些高级配置。
  if (BUILD_MODE !== 'prod') {
    for (const cardId of ['service-card', 'dict-card', 'debug-card']) {
      const card = document.getElementById(cardId);
      if (card) card.hidden = false;
    }
    watchPopupErrors();
    startDebugAutoRefresh();
  }

  const resp = await chrome.runtime.sendMessage({ method: MSG.GET_CONFIG });
  currentConfig = resp?.ok ? resp.config : structuredClone(DEFAULT_CONFIG);

  // 界面主题：尽早应用，避免打开弹窗时先闪一下默认配色
  applyPopupTheme();

  // 界面语言：解析配置（auto 跟随浏览器）→ 设置模块状态 → 静态文本反查替换
  setUiLang(resolveUiLang(currentConfig.uiLanguage));
  collectStaticI18n();
  applyStaticI18n();
  // 固定窗口模式：initPin 早于配置加载，这里按当前语言重设一次标题
  if (isPinned) document.getElementById(ids.pin).title = t('popup.pin.unpinTitle');

  // 填充语言下拉：网页翻译与普通翻译各有一套，互不影响
  renderLangSelects();

  // 服务下拉
  renderServiceSelect();

  // 专有名词模板下拉（跟随界面语言）
  renderTermTemplateSelect();

  // 回填值
  document.getElementById(ids.enabled).checked = currentConfig.enabled;
  syncLanguageUI();          // 两个面板的语言下拉一起回填
  document.getElementById(ids.service).value = currentConfig.service;
  document.getElementById(ids.uiLanguage).value = currentConfig.uiLanguage || 'auto';
  document.getElementById(ids.uiTheme).value = currentConfig.popupTheme || 'light';
  document.getElementById(ids.baseUrl).value = currentConfig.services[currentConfig.service]?.baseUrl || '';

  // 旧版本已移除的模式（仅译文 / 仅原文等）回退到双语对照
  const LEGACY_MODES = { translation: 'dual', translationHover: 'dual', original: 'dual' };
  const savedMode = currentConfig.translationMode;
  document.getElementById(ids.mode).value = LEGACY_MODES[savedMode] || savedMode;
  document.getElementById(ids.theme).value =
    ({ markerGreen: 'marker', markerPink: 'marker' })[currentConfig.theme] || currentConfig.theme;
  // 荧光笔颜色：命中预设色则选中，否则走自定义取色器
  const themeColor = currentConfig.themeColor || '#ffec9c';
  const themeSel = document.getElementById(ids.themeColor);
  const isPreset = [...themeSel.options].some(o => o.value === themeColor);
  themeSel.value = isPreset ? themeColor : 'custom';
  document.getElementById(ids.themeColorCustom).value = themeColor;
  syncThemeColorUI();
  document.getElementById(ids.position).value = currentConfig.translationPosition;
  document.getElementById(ids.fontScale).value = String(currentConfig.translationFontScale ?? 1);
  // 旧配置里的 auto / gray / black 统一回退到「暗色」
  const LEGACY_COLORS = { auto: 'dark', gray: 'dark', black: 'dark' };
  const savedColor = currentConfig.translationColor || 'dark';
  document.getElementById(ids.textColor).value = LEGACY_COLORS[savedColor] || savedColor;
  document.getElementById(ids.textColorCustom).value = currentConfig.translationColorCustom || '#000000';
  syncColorPicker();
  document.getElementById(ids.ignoreEnabled).checked = currentConfig.ignoreEnabled !== false;
  refreshModeDependentUI();
  document.getElementById(ids.selection).checked = currentConfig.selection?.enabled ?? false;
  document.getElementById(ids.selectionMode).value = currentConfig.selection?.showMode ?? 'icon';
  document.getElementById(ids.dictPhonetic).checked = currentConfig.dict?.phonetic !== false;
  document.getElementById(ids.dictSpeak).checked = currentConfig.dict?.speak !== false;
  document.getElementById(ids.dictProvider).value = currentConfig.dict?.provider || 'auto';
  document.getElementById(ids.protectTerms).checked = currentConfig.protectTerms !== false;
  // 关键词为空时展示内置「技术通用」模板，便于用户直接改
  document.getElementById(ids.termsList).value =
    currentConfig.protectTermsList || TERM_TEMPLATES.general.terms.join('|');

  // 绑定事件
  document.getElementById(ids.enabled).addEventListener('change', sync);

  // 网页翻译语言对 → sourceLanguage / targetLanguage
  // 普通翻译语言对 → textSourceLanguage / textTargetLanguage
  const langBindings = [
    [document.getElementById(ids.source), 'sourceLanguage'],
    [document.getElementById(ids.target), 'targetLanguage'],
    [document.getElementById(ids.textSource), 'textSourceLanguage'],
    [document.getElementById(ids.textTarget), 'textTargetLanguage'],
  ];
  for (const [el, key] of langBindings) {
    el.addEventListener('change', () => {
      currentConfig[key] = el.value;
      syncLanguageUI();
      sync();
    });
  }
  document.getElementById(ids.service).addEventListener('change', (e) => {
    // 换服务时同步 baseUrl 显示
    const svc = currentConfig.services[e.target.value];
    document.getElementById(ids.baseUrl).value = svc.baseUrl;
    sync(e);
  });
  document.getElementById(ids.baseUrl).addEventListener('change', (e) => {
    // baseUrl 存进对应服务的配置里
    const svc = currentConfig.services[currentConfig.service];
    svc.baseUrl = e.target.value;
    sync(e);
  });
  document.getElementById(ids.mode).addEventListener('change', () => {
    refreshModeDependentUI();
    sync();
  });
  document.getElementById(ids.theme).addEventListener('change', () => {
    syncThemeColorUI();
    sync();
  });
  document.getElementById(ids.themeColor).addEventListener('change', () => {
    syncThemeColorUI();
    sync();
  });
  let themeColorTimer = null;
  document.getElementById(ids.themeColorCustom).addEventListener('input', () => {
    clearTimeout(themeColorTimer);
    themeColorTimer = setTimeout(sync, 300);
  });
  document.getElementById(ids.position).addEventListener('change', sync);
  document.getElementById(ids.fontScale).addEventListener('change', sync);
  document.getElementById(ids.textColor).addEventListener('change', () => {
    syncColorPicker();
    sync();
  });
  // 自定义颜色：拖动取色器时防抖保存，避免频繁写配置
  let colorTimer = null;
  document.getElementById(ids.textColorCustom).addEventListener('input', () => {
    clearTimeout(colorTimer);
    colorTimer = setTimeout(sync, 300);
  });
  document.getElementById(ids.ignoreEnabled).addEventListener('change', sync);
  document.getElementById(ids.selection).addEventListener('change', sync);
  document.getElementById(ids.selectionMode).addEventListener('change', sync);
  document.getElementById(ids.dictPhonetic).addEventListener('change', sync);
  document.getElementById(ids.dictSpeak).addEventListener('change', sync);
  document.getElementById(ids.dictProvider).addEventListener('change', sync);
  document.getElementById(ids.protectTerms).addEventListener('change', sync);
  document.getElementById(ids.termsList).addEventListener('change', sync);
  // 输入时防抖保存：避免关闭弹窗（未失焦）导致编辑内容丢失
  let termsTimer = null;
  document.getElementById(ids.termsList).addEventListener('input', () => {
    clearTimeout(termsTimer);
    termsTimer = setTimeout(sync, 500);
  });
  // 切换模板即自动写入关键词（「自定义」保留当前词表，不覆盖）
  document.getElementById(ids.termsTemplate).addEventListener('change', () => {
    const tpl = TERM_TEMPLATES[document.getElementById(ids.termsTemplate).value];
    if (!tpl?.terms?.length) return;
    document.getElementById(ids.termsList).value = tpl.terms.join('|');
    sync();
  });
  // 应用：把下拉所选模板写入关键词框并保存（「自定义」保留当前词表）
  document.getElementById(ids.termsApply).addEventListener('click', () => {
    const tpl = TERM_TEMPLATES[document.getElementById(ids.termsTemplate).value];
    if (!tpl?.terms?.length) return;
    document.getElementById(ids.termsList).value = tpl.terms.join('|');
    sync();
  });
  // 还原：恢复默认的「计算机通用」模板
  document.getElementById(ids.termsReset).addEventListener('click', () => {
    document.getElementById(ids.termsList).value = TERM_TEMPLATES.general.terms.join('|');
    sync();
  });

  // 界面语言切换：保存配置 + 立即重渲当前弹窗
  document.getElementById(ids.uiLanguage).addEventListener('change', async (e) => {
    currentConfig.uiLanguage = e.target.value;
    await sync(e);
    applyUiLanguage();
  });

  // 界面主题：立即应用到当前弹窗并保存
  document.getElementById(ids.uiTheme).addEventListener('change', (e) => {
    currentConfig.popupTheme = e.target.value;
    applyPopupTheme();
    sync();
  });
  // 自定义背景图：本地图片压缩成 dataURL 后存配置
  document.getElementById(ids.themeImage).addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      currentConfig.popupThemeImage = await compressImage(file);
    } catch {
      return;
    }
    applyPopupTheme();
    await sync();
  });
  document.getElementById(ids.themeImageClear).addEventListener('click', async () => {
    currentConfig.popupThemeImage = '';
    document.getElementById(ids.themeImage).value = '';
    applyPopupTheme();
    await sync();
  });
  // 自定义主题：组件 / 背景图透明度滑块，拖动即时预览、防抖保存
  let themeAlphaTimer = null;
  const onAlphaInput = () => {
    currentConfig.popupThemeOpacity = Number(document.getElementById(ids.themeAlpha).value) / 100;
    currentConfig.popupThemeImageOpacity = Number(document.getElementById(ids.themeImageAlpha).value) / 100;
    applyPopupTheme();
    clearTimeout(themeAlphaTimer);
    themeAlphaTimer = setTimeout(sync, 300);
  };
  document.getElementById(ids.themeAlpha).addEventListener('input', onAlphaInput);
  document.getElementById(ids.themeImageAlpha).addEventListener('input', onAlphaInput);
  // 文字颜色：取色即时预览、防抖保存
  document.getElementById(ids.themeTextColor).addEventListener('input', (e) => {
    currentConfig.popupThemeTextColor = e.target.value;
    applyPopupTheme();
    clearTimeout(themeAlphaTimer);
    themeAlphaTimer = setTimeout(sync, 300);
  });

  document.getElementById(ids.toggle).addEventListener('click', onToggleClick);
  document.getElementById(ids.test).addEventListener('click', onTestService);
  document.getElementById(ids.debugCopy).addEventListener('click', onCopyDebug);
  document.getElementById(ids.debugClear).addEventListener('click', onClearDebug);

  // 普通翻译面板
  document.getElementById(ids.textTranslate).addEventListener('click', onTranslateText);
  document.getElementById(ids.textInput).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onTranslateText();
  });
  // 输入内容不再是单个单词时，立即收掉旧音标
  document.getElementById(ids.textInput).addEventListener('input', () => {
    const text = document.getElementById(ids.textInput).value.trim();
    if (!WORD_RE.test(text)) hideTextPhonetic();
  });
  document.getElementById(ids.copyText).addEventListener('click', onCopyText);

  // 打开弹窗时同步按钮状态：页面已在翻译中则继续显示进度
  const p = await refreshButton();
  if (p?.translating) startPolling();
}

/** 专有名词模板下拉（模板名跟随界面语言） */
function renderTermTemplateSelect() {
  const sel = document.getElementById(ids.termsTemplate);
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '';
  for (const [key, tpl] of Object.entries(TERM_TEMPLATES)) {
    sel.innerHTML += `<option value="${key}">${t(tpl.nameKey)}</option>`;
  }
  if (prev) sel.value = prev;
}

/** 按当前界面语言重建四个语言下拉（保留已选值） */
function renderLangSelects() {
  const langSelects = [ids.source, ids.target, ids.textSource, ids.textTarget]
    .map(id => document.getElementById(id));
  for (const sel of langSelects) {
    const prev = sel.value;
    sel.innerHTML = '';
    for (const l of LANGUAGES) {
      sel.innerHTML += `<option value="${l.code}">${langLabel(l)}</option>`;
    }
    if (prev) sel.value = prev;
  }
}

/** 服务下拉（服务名跟随界面语言） */
function renderServiceSelect() {
  const svcSel = document.getElementById(ids.service);
  const prev = svcSel.value;
  svcSel.innerHTML = '';
  for (const [key, svc] of Object.entries(currentConfig.services)) {
    svcSel.innerHTML += `<option value="${key}">${serviceName(svc)} (${key})</option>`;
  }
  if (prev) svcSel.value = prev;
}

/**
 * 应用界面主题：
 *  - 内置主题只切 <html data-tmt-popup-theme>，配色由 popup.css 的变量块决定
 *  - 自定义主题额外把本地背景图内联到 body，并显示换图/预览区
 */
function applyPopupTheme() {
  const theme = currentConfig?.popupTheme || 'light';
  const img = currentConfig?.popupThemeImage || '';
  document.documentElement.setAttribute('data-tmt-popup-theme', theme);

  // 自定义主题的两个透明度：组件（卡片/头部/输入框）与背景图
  const alpha = clamp01(Number(currentConfig?.popupThemeOpacity ?? 0.86), 0.35);
  const imgAlpha = clamp01(Number(currentConfig?.popupThemeImageOpacity ?? 1), 0);
  document.documentElement.style.setProperty('--tmt-alpha', String(alpha));

  // 自定义文字颜色
  const fg = /^#[0-9a-f]{6}$/i.test(currentConfig?.popupThemeTextColor || '')
    ? currentConfig.popupThemeTextColor
    : '#1f2328';
  document.documentElement.style.setProperty('--tmt-custom-fg', fg);
  const fgEl = document.getElementById(ids.themeTextColor);
  if (fgEl) fgEl.value = fg;

  const body = document.body;
  const useImg = theme === 'custom' && !!img;
  // 图片透明度用白色蒙版模拟：图片越透明，蒙版越白
  const scrim = 1 - imgAlpha;
  body.style.backgroundImage = useImg
    ? `linear-gradient(rgba(255,255,255,${scrim}), rgba(255,255,255,${scrim})), url("${img}")`
    : '';
  body.style.backgroundSize = useImg ? 'cover' : '';
  body.style.backgroundPosition = useImg ? 'center' : '';

  // 滑块数值回显
  const alphaEl = document.getElementById(ids.themeAlpha);
  if (alphaEl) alphaEl.value = String(Math.round(alpha * 100));
  const imgAlphaEl = document.getElementById(ids.themeImageAlpha);
  if (imgAlphaEl) imgAlphaEl.value = String(Math.round(imgAlpha * 100));
  const alphaVal = document.getElementById(ids.themeAlphaVal);
  if (alphaVal) alphaVal.textContent = `${Math.round(alpha * 100)}%`;
  const imgAlphaVal = document.getElementById(ids.themeImageAlphaVal);
  if (imgAlphaVal) imgAlphaVal.textContent = `${Math.round(imgAlpha * 100)}%`;

  const row = document.getElementById(ids.themeImageRow);
  if (row) row.hidden = theme !== 'custom';
  const prev = document.getElementById(ids.themeImagePreview);
  if (prev) {
    prev.hidden = !useImg;
    prev.style.backgroundImage = useImg ? `url("${img}")` : '';
  }
}

/** 限制到 [min, 1]，避免滑块/旧配置越界 */
function clamp01(v, min) {
  if (!Number.isFinite(v)) return min;
  return Math.min(1, Math.max(min, v));
}

/**
 * 本地图片 → 压缩后的 dataURL。
 * storage.local 容量有限，先按最长边 1200px 缩放，再以 JPEG 0.82 编码。
 */
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('image decode failed'));
      img.onload = () => {
        const maxSide = 1200;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.82));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/** 界面语言变化后的整体重渲：静态文本 + 动态下拉 + 按钮状态 */
function applyUiLanguage() {
  setUiLang(resolveUiLang(currentConfig.uiLanguage));
  applyStaticI18n();
  renderLangSelects();
  renderServiceSelect();
  renderTermTemplateSelect();
  syncLanguageUI();
  document.getElementById(ids.service).value = currentConfig.service;
  // 固定窗口的 title 是初始化后动态写入的，静态词条收集不到，需单独刷新
  if (isPinned) document.getElementById(ids.pin).title = t('popup.pin.unpinTitle');
  refreshButton();
}

// ---- 按钮状态机：翻译 → 翻译中 x/y（禁用）→ 还原 ---------------------------

let pollTimer = null;

function setStatus(text, kind = '') {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

/** 设置面板里的状态提示（测试服务、收集调试信息） */
function setSettingsStatus(text, kind = '') {
  const el = document.getElementById(ids.settingsStatus);
  if (!el) return;
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

/** 调试卡片自己的状态提示 */
function setDebugStatus(text, kind = '') {
  const el = document.getElementById(ids.debugStatus);
  if (!el) return;
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

/** 按引擎进度渲染按钮文案与可用状态 */
function setButtonState(p) {
  const btn = document.getElementById(ids.toggle);
  if (!btn) return;

  if (!p || !p.ok) {
    btn.disabled = false;
    btn.textContent = t('popup.page.translate');
    return;
  }
  if (p.translating) {
    // 翻译中：显示进度并禁用点击
    btn.disabled = true;
    btn.textContent = p.total
      ? t('popup.page.translatingProgress', { done: p.done, total: p.total })
      : t('popup.page.translating');
  } else {
    btn.disabled = false;
    btn.textContent = p.translated ? t('popup.page.restore') : t('popup.page.translate');
  }
}

// ---- 图钉 / tab 栏 ---------------------------------------------------------

/**
 * 图钉：让面板常驻显示，并停靠在屏幕右侧。
 *
 * 说明：点工具栏图标弹出的 action popup，位置完全由浏览器决定
 * （永远紧贴图标下方），扩展没有任何 API 可以移动它——这是浏览器限制。
 * 所以这里用 chrome.windows.create 开一个独立窗口，窗口的 left/top 可以自己指定，
 * 从而实现"停靠在屏幕右侧"。同时把当前标签页 id 通过 URL 带过去，
 * 新窗口里的"翻译/还原"仍然作用于原网页。
 */
function initPin() {
  const btn = document.getElementById(ids.pin);

  if (isPinned) {
    document.body.classList.add('pinned');
    btn.classList.add('active');
    btn.title = t('popup.pin.unpinTitle');
  }

  btn.addEventListener('click', async () => {
    if (isPinned) { window.close(); return; }

    const tab = await getActiveTab();
    if (!tab?.id) { setStatus(t('popup.page.noTab'), 'error'); return; }

    const url = chrome.runtime.getURL(
      `popup/popup.html?pinned=1&targetTab=${tab.id}`
    );

    // 停靠到屏幕右上角：紧贴顶边、紧贴右边，高度铺满可用屏幕，
    // 视觉上就像浏览器自带的侧边栏。
    const screenW = window.screen.availWidth || 1920;
    const screenH = window.screen.availHeight || 1080;
    const screenTop = window.screen.availTop || 0;
    const width = 460;
    const height = screenH;
    const left = Math.max(0, screenW - width);   // 贴右
    const top = Math.max(0, screenTop);          // 贴顶

    await chrome.windows.create({
      url, type: 'popup', width, height, left, top, focused: true,
    });
    window.close();
  });
}

/** tab 切换：只切面板显隐，不重新加载任何东西 */
function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.panel').forEach(p => {
        p.hidden = p.id !== `panel-${tab.dataset.tab}`;
      });
    });
  });
}

/* ============================================================
   关于页：版本信息 / 检测更新 / 作者信息 / 打赏
   数据源是构建时拷进 dist/public/app.config.json 的根配置；
   打赏图片位于 dist/public/donate.png（构建从 src/public/ 原样拷贝）。
   ============================================================ */
let aboutCfg = null;

function initAbout() {
  loadAboutConfig();
  document.getElementById('btn-check-update').addEventListener('click', onCheckUpdate);
  document.getElementById('btn-open-blog').addEventListener('click', () => {
    const url = aboutCfg?.author?.blog;
    if (url) chrome.tabs.create({ url });
  });
  // 打赏图缺失时给出提示（src/public/donate.png 未放置或被删）
  const img = document.getElementById('donate-img');
  img.addEventListener('error', () => {
    img.hidden = true;
    document.getElementById('donate-missing').hidden = false;
  });
}

async function loadAboutConfig() {
  try {
    const resp = await fetch(chrome.runtime.getURL('public/app.config.json'), { cache: 'no-store' });
    aboutCfg = await resp.json();
  } catch {
    aboutCfg = null;
  }
  const man = chrome.runtime.getManifest();
  document.getElementById('about-name').textContent = aboutCfg?.name || man.name;
  document.getElementById('about-version').textContent = `v${aboutCfg?.version || man.version}`;

  const author = aboutCfg?.author || {};
  document.getElementById('about-author-name').textContent = author.name || '—';
  const blogRow = document.getElementById('about-blog-row');
  if (author.blog) {
    document.getElementById('about-blog-url').textContent = author.blog;
    blogRow.hidden = false;
  }
}

/** 语义化版本比较：a > b 返回 1，相等返回 0，a < b 返回 -1 */
function compareVersions(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

async function onCheckUpdate() {
  const btn = document.getElementById('btn-check-update');
  const statusEl = document.getElementById('about-update-status');
  const linkEl = document.getElementById('about-release-link');
  const apiUrl = aboutCfg?.update?.apiUrl;
  if (!apiUrl) {
    statusEl.textContent = t('popup.about.noApi');
    statusEl.className = 'status error';
    return;
  }
  btn.disabled = true;
  statusEl.textContent = t('popup.about.checking');
  statusEl.className = 'status';
  linkEl.hidden = true;
  try {
    const rel = await fetch(apiUrl, { cache: 'no-store' }).then(r => r.json());
    // GitCode 返回 tag_name ；兼容只有 name 的响应
    const latest = String(rel?.tag_name || rel?.name || '').replace(/^v/i, '').trim();
    const current = chrome.runtime.getManifest().version;
    if (latest && compareVersions(latest, current) > 0) {
      statusEl.textContent = t('popup.about.newVersion', { ver: latest });
      statusEl.className = 'status error';
      if (aboutCfg?.update?.releasePageBase) {
        linkEl.href = aboutCfg.update.releasePageBase;
        linkEl.hidden = false;
      }
    } else {
      statusEl.textContent = t('popup.about.upToDate');
      statusEl.className = 'status ok';
    }
  } catch (err) {
    statusEl.textContent = t('popup.about.checkFail', { err: err.message });
    statusEl.className = 'status error';
  } finally {
    btn.disabled = false;
  }
}

/** 普通翻译：把输入框里的文本发给后台翻译，并展示结果 */
async function onTranslateText() {
  const input = document.getElementById(ids.textInput);
  const resultEl = document.getElementById(ids.textResult);
  const out = document.getElementById(ids.textOut);
  const statusEl = document.getElementById(ids.textStatus);
  const btn = document.getElementById(ids.textTranslate);

  const text = input.value.trim();
  if (!text) { statusEl.textContent = t('popup.text.empty'); statusEl.className = 'status error'; return; }

  // 单个英文单词：额外查音标（不阻塞翻译）
  renderPhonetic(text);

  btn.disabled = true;
  statusEl.textContent = t('popup.page.translating');
  statusEl.className = 'status';
  resultEl.hidden = true;

  // 无网络：不发起必然失败的请求，直接显示(无译文) + 明确提示
  if (navigator.onLine === false) {
    out.textContent = t('common.noTranslation');
    resultEl.hidden = false;
    statusEl.textContent = t('common.offline');
    statusEl.className = 'status error';
    btn.disabled = false;
    return;
  }

  try {
    const resp = await chrome.runtime.sendMessage({
      method: MSG.TRANSLATE_BATCH,
      data: {
        service: currentConfig.service,
        from: currentConfig.textSourceLanguage,
        to: currentConfig.textTargetLanguage,
        texts: [text],
      },
    });
    const r = resp?.results?.[0];
    if (r?.ok) {
      out.textContent = r.translation || t('common.noTranslation');
      resultEl.hidden = false;
      statusEl.textContent = '';
    } else {
      out.textContent = t('common.noTranslation');
      resultEl.hidden = false;
      statusEl.textContent = t('common.translateFailed', { err: r?.error || t('common.unknownError') });
      statusEl.className = 'status error';
    }
  } catch (err) {
    out.textContent = t('common.noTranslation');
    resultEl.hidden = false;
    statusEl.textContent = t('common.requestError', { err: err.message });
    statusEl.className = 'status error';
  } finally {
    btn.disabled = false;
  }
}

/**
 * 查音标并渲染到输入框下方 —— 只对单个英文单词生效。
 * 句子 / 中文 / 词组直接隐藏，不发起请求。
 */
async function renderPhonetic(text) {
  const box = document.getElementById(ids.textPhonetic);
  const word = (text || '').trim();
  if (!box) return;

  // 音标 + 朗读都关掉时，整行不出现、也不发请求
  const showPhonetic = currentConfig?.dict?.phonetic !== false;
  const showSpeak = currentConfig?.dict?.speak !== false;
  if (!showPhonetic && !showSpeak) { hideTextPhonetic(); return; }

  if (!WORD_RE.test(word)) { hideTextPhonetic(); return; }

  box.hidden = false;
  box.textContent = t('common.phoneticLoading');

  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({
      method: MSG.GET_WORD_INFO,
      data: { text: word, provider: currentConfig?.dict?.provider || 'auto' },
    });
  } catch { /* 查询失败静默降级 */ }

  // 输入框已经改了：丢弃过期结果
  const latest = document.getElementById(ids.textInput).value.trim();
  if (latest !== word) return;

  if (!resp?.ok || !Array.isArray(resp.phonetics) || resp.phonetics.length === 0) {
    hideTextPhonetic();
    return;
  }

  box.textContent = '';
  for (const p of resp.phonetics) {
    const item = document.createElement('span');
    item.className = 'phonetic-item';

    if (showPhonetic) {
      if (p.region) {
        const region = document.createElement('span');
        region.className = 'phonetic-region';
        region.textContent = p.region;
        item.appendChild(region);
      }

      const ph = document.createElement('span');
      ph.className = 'phonetic-text';
      ph.textContent = p.text;
      item.appendChild(ph);
    }

    if (showSpeak) {
      const speakBtn = document.createElement('button');
      speakBtn.type = 'button';
      speakBtn.className = 'phonetic-speak';
      // 不显示音标时，按钮上带口音标签，避免两个按钮完全一样
      const region = regionLabel(p.region);
      speakBtn.textContent = showPhonetic ? '🔊' : `🔊${region ? ' ' + region : ''}`;
      speakBtn.title = region ? t('common.speakTip', { region }) : t('common.speakTipNoRegion');
      speakBtn.addEventListener('click', () => {
        playWord(word, p.audio, p.region === '英' ? 'en-GB' : 'en-US');
      });
      item.appendChild(speakBtn);
    }

    box.appendChild(item);
  }
}

/** 隐藏普通翻译的音标行 */
function hideTextPhonetic() {
  const box = document.getElementById(ids.textPhonetic);
  if (!box) return;
  box.hidden = true;
  box.textContent = '';
}

/** 复制普通翻译的译文，按钮短暂反馈"已复制" */
async function onCopyText() {
  const out = document.getElementById(ids.textOut);
  const btn = document.getElementById(ids.copyText);
  const text = out.textContent || '';
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = t('common.copied');
    btn.classList.add('done');
    setTimeout(() => {
      btn.textContent = t('common.copyTranslation');
      btn.classList.remove('done');
    }, 1200);
  } catch {
    // 剪贴板不可用时退化为选中文本，让用户手动 Ctrl+C
    const range = document.createRange();
    range.selectNodeContents(out);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    btn.textContent = t('common.pressCtrlC');
  }
}

async function getActiveTab() {
  // 固定窗口模式：没有"当前活动标签页"，用 URL 带过来的 id
  if (pinnedTabId) {
    try { return await chrome.tabs.get(pinnedTabId); } catch { return null; }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/** 只发给顶层 frame：content script 是 all_frames，否则可能被 iframe 抢先响应 */
async function askContent(tabId, method) {
  try {
    return await chrome.tabs.sendMessage(tabId, { method }, { frameId: 0 });
  } catch (err) {
    return { ok: false, error: err.message, noReceiver: true };
  }
}

async function refreshButton() {
  const tab = await getActiveTab();
  if (!tab?.id) return null;
  const p = await askContent(tab.id, MSG.GET_PROGRESS);
  setButtonState(p);
  return p;
}

/**
 * 确保页面里有翻译引擎。
 *
 * 为什么需要这个？MV3 里扩展被重载后，**已经打开的标签页不会自动重新注入**
 * content script，此时点击按钮只会得到"没有接收方"，表现就是"点了没反应"。
 * 这里用 scripting.executeScript 手动注入一次 guard.js，再重试。
 */
async function ensureEngine(tabId) {
  let p = await askContent(tabId, MSG.GET_PROGRESS);
  if (!p?.noReceiver) return p;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/guard.js'],
    });
  } catch (err) {
    return { ok: false, noReceiver: true, error: err.message };
  }

  // 等 guard 动态 import 引擎 + 引擎读完配置
  await new Promise(r => setTimeout(r, 600));
  p = await askContent(tabId, MSG.GET_PROGRESS);
  return p;
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(async () => {
    const p = await refreshButton();
    if (!p?.ok) return;
    if (p.translating) return;

    stopPolling();
    // 翻译结束：把结果明确写出来，避免"看起来什么都没发生"
    if (p.empty) {
      setStatus(
        navigator.onLine === false
          ? t('common.offline')
          : t('popup.page.empty'),
        'error'
      );
    } else if (p.total > 0) {
      setStatus(t('popup.page.done', { n: p.total }), 'ok');
    }
  }, 400);
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

async function onToggleClick() {
  devLog('点击翻译按钮');
  const tab = await getActiveTab();
  if (!tab?.id) { setStatus(t('popup.page.noTab'), 'error'); return; }

  // 立即给出反馈：点击后就能看到文字变化，避免"点了像没反应"
  setStatus(t('popup.page.connecting'));

  // 先确保引擎存在（必要时手动注入），再决定这次是"翻译"还是"还原"
  const current = await ensureEngine(tab.id);
  devLog('页面引擎状态', current);
  if (current?.noReceiver) {
    setStatus(t('popup.page.cannotEnable', { msg: current.error || t('popup.page.refreshRetry') }), 'error');
    return;
  }
  if (!current?.ok) {
    setStatus(t('popup.page.noResponse', { msg: current?.error || 'unknown' }), 'error');
    return;
  }

  const method = current.translated ? MSG.RESTORE_PAGE : MSG.TRANSLATE_PAGE;

  // 无网络时只拦"翻译"，"还原"是纯本地操作，不受影响
  if (method === MSG.TRANSLATE_PAGE && navigator.onLine === false) {
    setStatus(t('common.offline'), 'error');
    return;
  }

  const resp = await askContent(tab.id, method);
  devLog('发送', method, '→', resp);

  if (!resp?.ok) {
    setStatus(t('popup.page.noResponse', { msg: resp?.error || 'unknown' }), 'error');
    return;
  }

  setStatus('');
  setButtonState(resp);
  if (resp.translating) startPolling();
}

/**
 * 测试当前选中的翻译服务是否可用。
 * 用途：区分"接口挂了"和"扩展本身有问题"——
 * 如果这里能返回中文，说明程序链路正常，问题只会在具体服务上。
 */
async function onTestService() {
  const btn = document.getElementById(ids.test);
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = t('popup.settings.testing');
  setSettingsStatus('');

  try {
    const service = document.getElementById(ids.service).value;
    const to = document.getElementById(ids.target).value || 'zh-CN';
    const resp = await chrome.runtime.sendMessage({
      method: MSG.TRANSLATE_BATCH,
      data: {
        service,
        from: 'en',
        to,
        texts: ['Hello, this is a test from TTranslate.'],
      },
    });
    const r = resp?.results?.[0];
    if (r?.ok) setSettingsStatus(t('popup.settings.testOk', { text: r.translation }), 'ok');
    else setSettingsStatus(t('popup.settings.testFail', { err: r?.error || t('common.unknownError') }), 'error');
  } catch (err) {
    setSettingsStatus(t('common.requestError', { err: err.message }), 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/** popup 自身捕获的运行时错误，一并展示在调试面板里 */
const popupErrors = [];
let lastDebugText = '';

function nowLabel() {
  return new Date().toTimeString().slice(0, 8);
}

/** 记录 popup 侧 JS 报错（含未处理的 Promise 拒绝） */
function watchPopupErrors() {
  window.addEventListener('error', (e) => {
    popupErrors.push(`${nowLabel()}  ERROR [popup] ${e.message} (${e.filename || ''}:${e.lineno || 0})`);
  });
  window.addEventListener('unhandledrejection', (e) => {
    popupErrors.push(`${nowLabel()}  ERROR [popup] 未处理 Promise 拒绝：${e.reason?.message || String(e.reason)}`);
  });
}

/**
 * 采集调试信息：构建模式 + 配置 + guard 面包屑 + 引擎进度/日志 + popup 报错。
 * 关键点：面包屑存在 storage 里，即使页面引擎完全没加载也能读到，
 * 这样"点了没反应"至少能定位到卡在哪一步。
 */
async function collectDebugText() {
  const lines = [];
  lines.push(`TTranslate v${chrome.runtime.getManifest().version}  构建模式=${BUILD_MODE}`);
  lines.push(`时间：${new Date().toLocaleString()}`);

  // 1) 后台配置（能反映迁移是否生效、当前服务是什么）
  try {
    const resp = await chrome.runtime.sendMessage({ method: MSG.GET_CONFIG });
    const c = resp?.config;
    if (c) {
      lines.push(`配置：service=${c.service} enabled=${c.enabled} ` +
        `${c.sourceLanguage}→${c.targetLanguage} mode=${c.translationMode} cfgVer=${c.configVersion ?? '?'}`);
    } else {
      lines.push('配置：读取失败（后台无响应）');
    }
  } catch (err) {
    lines.push('配置：读取异常 ' + err.message);
  }

  // 2) guard 面包屑
  try {
    const obj = await chrome.storage.local.get('__tmt_debug');
    const tr = obj?.['__tmt_debug'];
    lines.push('', '--- guard 面包屑（最近 20 条）---');
    if (Array.isArray(tr) && tr.length) {
      tr.slice(-20).forEach(x => {
        lines.push(`${x.t} ${x.step}${x.extra ? ' :: ' + x.extra : ''}` +
          `${x.top ? '' : ' [iframe]'}  ${x.url}`);
      });
    } else {
      lines.push('（空）→ content script 从未执行（检查扩展是否启用、页面是否 chrome:// 页面）');
    }
  } catch (err) {
    lines.push('面包屑：读取异常 ' + err.message);
  }

  // 3) 页面引擎状态
  const tab = await getActiveTab();
  if (!tab?.id) {
    lines.push('', '当前没有可用的标签页');
  } else {
    lines.push('', `--- 标签页 ---`, `id=${tab.id} url=${(tab.url || '').slice(0, 160)}`);

    const p = await askContent(tab.id, MSG.GET_PROGRESS);
    lines.push('', '--- 引擎状态 ---');
    if (p?.noReceiver) {
      lines.push(`无接收方（${p.error}）→ 引擎未加载`);
    } else {
      lines.push(`ok=${p?.ok} translated=${p?.translated} translating=${p?.translating} ` +
        `${p?.done ?? 0}/${p?.total ?? 0}`);
    }

    const lg = await askContent(tab.id, MSG.GET_LOGS);
    lines.push('', '--- 引擎日志 ---');
    if (lg?.ok && Array.isArray(lg.logs) && lg.logs.length) {
      lines.push(...lg.logs);
    } else {
      lines.push('（拿不到引擎日志，通常是引擎没加载）');
    }
  }

  // popup 自身报错（页面侧报错已由引擎写进上面的引擎日志）
  if (popupErrors.length) {
    lines.push('', '--- popup 报错 ---');
    lines.push(...popupErrors.slice(-50));
  }

  return limitDebugText(redactDataUrls(lines.join('\n')));
}

/**
 * 调试区容量控制：只保留最近 5000 行、最多 10 万字符。
 * 超字符上限时从头部裁剪，并丢掉被截断的半行。
 */
function limitDebugText(text) {
  let out = text.split('\n').slice(-5000).join('\n');
  if (out.length > 100000) {
    out = out.slice(out.length - 100000);
    const nl = out.indexOf('\n');
    if (nl > 0) out = out.slice(nl + 1);
  }
  return out;
}

/** 刷新黑窗口；内容有变化时自动滚到最底部 */
async function refreshDebugInfo() {
  const out = document.getElementById(ids.debugOut);
  if (!out) return;
  const text = await collectDebugText();
  if (text === lastDebugText) return;   // 没变化就不重绘，避免打断正在选中的文本
  lastDebugText = text;
  out.textContent = text;
  out.scrollTop = out.scrollHeight;
}

/** 打开弹窗后定时刷新，新日志/新报错会自动出现 */
function startDebugAutoRefresh() {
  refreshDebugInfo();
  setInterval(refreshDebugInfo, 2000);
}

/** 复制黑窗口里的全部内容 */
async function onCopyDebug() {
  const text = document.getElementById(ids.debugOut)?.textContent || '';
  if (!text.trim()) {
    setDebugStatus(t('popup.settings.debugEmpty'));
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    setDebugStatus(t('popup.settings.debugCopied'), 'ok');
  } catch {
    setDebugStatus(t('popup.settings.debugManual'), 'ok');
  }
}

/** 清空：窗口内容 + popup 报错记录 + 页面侧日志缓冲 + guard 面包屑 */
async function onClearDebug() {
  popupErrors.length = 0;
  lastDebugText = '';
  const out = document.getElementById(ids.debugOut);
  if (out) out.textContent = '';
  setDebugStatus('');

  const tab = await getActiveTab();
  if (tab?.id) await askContent(tab.id, MSG.CLEAR_LOGS);
  try { await chrome.storage.local.remove('__tmt_debug'); } catch { /* 忽略 */ }
}

/** 装饰类主题才显示「颜色配置」；颜色选自定义时再显示取色器 */
function syncThemeColorUI() {
  const theme = document.getElementById(ids.theme).value;
  const isDecorated = ['marker', 'dashed', 'underline', 'wavy', 'blockquote', 'card', 'glass'].includes(theme);
  document.getElementById(ids.themeColorRow).hidden = !isDecorated;
  const isCustom = document.getElementById(ids.themeColor).value === 'custom';
  document.getElementById(ids.themeColorCustom).hidden = !isDecorated || !isCustom;
}

/** 「译文颜色」选中自定义时才显示右侧取色器 */
function syncColorPicker() {
  const isCustom = document.getElementById(ids.textColor).value === 'custom';
  document.getElementById(ids.textColorCustom).hidden = !isCustom;
}

/** 把当前配置同步到四个语言下拉框（网页一套、普通翻译一套） */
function syncLanguageUI() {
  document.getElementById(ids.source).value = currentConfig.sourceLanguage;
  document.getElementById(ids.target).value = currentConfig.targetLanguage;
  document.getElementById(ids.textSource).value = currentConfig.textSourceLanguage;
  document.getElementById(ids.textTarget).value = currentConfig.textTargetLanguage;
}

/** 把表单值写回 config，然后通知后台保存 */
async function sync(ev) {
  currentConfig.enabled = document.getElementById(ids.enabled).checked;
  currentConfig.sourceLanguage = document.getElementById(ids.source).value;
  currentConfig.targetLanguage = document.getElementById(ids.target).value;
  currentConfig.textSourceLanguage = document.getElementById(ids.textSource).value;
  currentConfig.textTargetLanguage = document.getElementById(ids.textTarget).value;
  currentConfig.service = document.getElementById(ids.service).value;

  // 显示模式 / 主题（全局生效）
  currentConfig.translationMode = document.getElementById(ids.mode).value;
  currentConfig.theme = document.getElementById(ids.theme).value;
  const themeSel = document.getElementById(ids.themeColor);
  currentConfig.themeColor = themeSel.value === 'custom'
    ? (document.getElementById(ids.themeColorCustom).value || '#ffec9c')
    : themeSel.value;

  currentConfig.translationFontScale = Number(document.getElementById(ids.fontScale).value) || 1;
  currentConfig.translationColor = document.getElementById(ids.textColor).value;
  currentConfig.translationColorCustom = document.getElementById(ids.textColorCustom).value;
  currentConfig.ignoreEnabled = document.getElementById(ids.ignoreEnabled).checked;
  currentConfig.translationPosition = document.getElementById(ids.position).value;
  currentConfig.selection = {
    enabled: document.getElementById(ids.selection).checked,
    showMode: document.getElementById(ids.selectionMode).value,
  };
  currentConfig.dict = {
    provider: document.getElementById(ids.dictProvider).value,
    phonetic: document.getElementById(ids.dictPhonetic).checked,
    speak: document.getElementById(ids.dictSpeak).checked,
  };
  currentConfig.uiLanguage = document.getElementById(ids.uiLanguage).value;
  currentConfig.popupTheme = document.getElementById(ids.uiTheme).value;
  currentConfig.popupThemeOpacity = Number(document.getElementById(ids.themeAlpha).value) / 100;
  currentConfig.popupThemeImageOpacity = Number(document.getElementById(ids.themeImageAlpha).value) / 100;
  currentConfig.popupThemeTextColor = document.getElementById(ids.themeTextColor).value;
  currentConfig.protectTerms = document.getElementById(ids.protectTerms).checked;
  currentConfig.protectTermsList = document.getElementById(ids.termsList).value.trim();

  // 发给后台合并保存；后台会广播 SET_THEME / SET_SERVICE 等消息给所有 content
  await chrome.runtime.sendMessage({
    method: MSG.UPDATE_CONFIG,
    data: currentConfig,
  });
}

// 模块脚本是 defer 的，正常情况 DOMContentLoaded 还没触发；
// 但用 readyState 判断更稳妥（例如脚本被动态注入时）。
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
