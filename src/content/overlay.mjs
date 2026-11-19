/**
 * ============================================================================
 * content/overlay.mjs —— 划词翻译 + 输入框翻译
 * ============================================================================
 * 划词翻译两种展示方式：
 *   - direct：选中后直接弹出译文面板
 *   - icon：选中后在选区右下角显示 TTranslate 图标，点击图标才翻译
 * 图钉：固定后面板不被外部点击/滚动/Esc 关闭。
 * 输入框翻译：聚焦 input/textarea 里敲 / 触发。
 * ============================================================================
 */

import { MSG, log, LANGUAGES } from '../shared/constants.mjs';
import { playWord } from '../shared/speech.mjs';
import { t, langLabel, regionLabel } from '../shared/i18n.mjs';

// ---- 模块级状态 ------------------------------------------------------------
let panel = null;              // 译文面板元素
let iconBtn = null;            // 划词后的 TTranslate 图标
let currentSelection = null;   // { text, rect } 当前选区信息
let currentTranslation = '';   // 当前译文（供复制按钮用）
let pinned = false;            // 面板是否被图钉固定
let listenersBound = false;    // 事件监听器是否已绑定（只绑一次）
let debounceTimer = null;      // 原文输入框防抖定时器
let panelRefs = null;          // 面板内可重本地化元素的引用（界面语言热更新用）

// 划词翻译配置（可由 popup 热更新）
const config = {
  enabled: false,
  showMode: 'direct', // direct | icon
  dict: { phonetic: true, speak: true }, // 单词音标 / 朗读按钮开关
  theme: 'light', // 界面主题，与 popup 设置保持一致
  themeImage: '', // 自定义主题的本地背景图（dataURL）
  themeAlpha: 0.86, // 自定义主题：组件透明度（与 popup 设置同步）
  themeImageAlpha: 1, // 自定义主题：背景图透明度
  themeTextColor: '#1f2328', // 自定义主题：文字颜色
};

/**
 * 浮层配色表：与 popup 的界面主题一一对应。
 * 页面里的浮层用内联样式，无法直接读 popup.css 的变量，这里维护同一套色值。
 */
const OVERLAY_THEMES = {
  light: {
    bg: '#fff', fg: '#1a1a1a', muted: '#666', soft: '#333', faint: '#999',
    border: '#e5e5e5', surface: '#fafafa', field: '#fff', hover: '#f0f0f0',
    inputBg: '#f7f7f7', primary: '#4c8bf5', pinBg: '#eaf1fe', pinBorder: '#d5e2fb',
    outBg: '#f5f9ff', outFg: '#24364b',
    shadow: '0 6px 24px rgba(0,0,0,0.18)',
  },
  dark: {
    bg: '#26282c', fg: '#e6e7ea', muted: '#9b9ea6', soft: '#d7d9de', faint: '#8a8d94',
    border: '#34363b', surface: '#1e1f22', field: '#2e3035', hover: '#363940',
    inputBg: '#2e3035', primary: '#6ea8ff', pinBg: '#2b3a52', pinBorder: '#3a4a63',
    outBg: '#262a33', outFg: '#dce5f5',
    shadow: '0 6px 24px rgba(0,0,0,0.55)',
  },
  red: {
    bg: '#fff', fg: '#3d1f1f', muted: '#8a6666', soft: '#4a2020', faint: '#b08c8c',
    border: '#f7d4d4', surface: '#fff5f5', field: '#fff', hover: '#ffe5e5',
    inputBg: '#fff5f5', primary: '#dc2626', pinBg: '#ffe5e5', pinBorder: '#f5c2c2',
    outBg: '#fff2f2', outFg: '#4a2020',
    shadow: '0 6px 24px rgba(220,38,38,0.20)',
  },
  orange: {
    bg: '#fff', fg: '#432b16', muted: '#8d7259', soft: '#4d2f16', faint: '#b49a80',
    border: '#f8dfc6', surface: '#fff8f1', field: '#fff', hover: '#ffedda',
    inputBg: '#fff8f1', primary: '#e0781c', pinBg: '#ffedda', pinBorder: '#f7d3b0',
    outBg: '#fff4e8', outFg: '#4d2f16',
    shadow: '0 6px 24px rgba(224,120,28,0.20)',
  },
  yellow: {
    bg: '#fff', fg: '#403614', muted: '#8a7c4e', soft: '#473a12', faint: '#b3a678',
    border: '#f6e6b4', surface: '#fffbea', field: '#fff', hover: '#fff3c8',
    inputBg: '#fffbea', primary: '#c98d05', pinBg: '#fff3c8', pinBorder: '#efd997',
    outBg: '#fff9e3', outFg: '#473a12',
    shadow: '0 6px 24px rgba(201,141,5,0.20)',
  },
  green: {
    bg: '#fff', fg: '#173a24', muted: '#5b7a66', soft: '#1b3d28', faint: '#8aa895',
    border: '#d3ecdb', surface: '#f3fbf5', field: '#fff', hover: '#e3f7e9',
    inputBg: '#f3fbf5', primary: '#16a34a', pinBg: '#e3f7e9', pinBorder: '#bfe6cb',
    outBg: '#f1fbf4', outFg: '#1b3d28',
    shadow: '0 6px 24px rgba(22,163,74,0.20)',
  },
  purple: {
    bg: '#fff', fg: '#2c2140', muted: '#75668d', soft: '#33254f', faint: '#a292bc',
    border: '#e2d8f8', surface: '#f8f5ff', field: '#fff', hover: '#efe8ff',
    inputBg: '#f8f5ff', primary: '#7c4ddb', pinBg: '#efe8ff', pinBorder: '#d7c6f3',
    outBg: '#f6f1ff', outFg: '#33254f',
    shadow: '0 6px 24px rgba(124,77,219,0.20)',
  },
  pink: {
    bg: '#fff', fg: '#3d2430', muted: '#8d6674', soft: '#4a2a37', faint: '#a37f8c',
    border: '#f6d3de', surface: '#fff6f9', field: '#fff', hover: '#ffe4ee',
    inputBg: '#fff6f9', primary: '#e04a8b', pinBg: '#ffe4ee', pinBorder: '#f6c3d4',
    outBg: '#fff2f7', outFg: '#4a2433',
    shadow: '0 6px 24px rgba(224,74,139,0.20)',
  },
  blue: {
    bg: '#fff', fg: '#1b2b45', muted: '#5c6d86', soft: '#24364b', faint: '#8496ad',
    border: '#d8e4f8', surface: '#f2f7ff', field: '#fff', hover: '#e8f1ff',
    inputBg: '#f5f9ff', primary: '#2f6fed', pinBg: '#e8f1ff', pinBorder: '#cfe0fb',
    outBg: '#f0f6ff', outFg: '#20344f',
    shadow: '0 6px 24px rgba(47,111,237,0.20)',
  },
  custom: {
    // 自定义主题走浅色毛玻璃：底色更白、边框/分隔线用半透明黑，避免灰蒙蒙和"白线"
    bg: 'rgba(255,255,255,0.9)', fg: '#1f2328', muted: '#5f6672', soft: '#2b3038', faint: '#9aa1ab',
    border: 'rgba(0,0,0,0.12)', surface: 'rgba(255,255,255,0.72)', field: 'rgba(255,255,255,0.95)',
    hover: 'rgba(0,0,0,0.06)',
    inputBg: 'rgba(246,249,253,0.92)', primary: '#4c8bf5', pinBg: 'rgba(76,139,245,0.16)', pinBorder: 'rgba(76,139,245,0.32)',
    outBg: 'rgba(240,246,255,0.92)', outFg: '#24364b',
    shadow: '0 8px 28px rgba(0,0,0,0.24)',
  },
};

/** 当前主题的色板（自定义主题按 popup 的透明度/文字颜色实时派生） */
function P() {
  if (config.theme !== 'custom') return OVERLAY_THEMES[config.theme] || OVERLAY_THEMES.light;
  const a = Math.min(1, Math.max(0.35, Number(config.themeAlpha) || 0.86));
  const fg = /^#[0-9a-f]{6}$/i.test(config.themeTextColor || '') ? config.themeTextColor : '#1f2328';
  const base = OVERLAY_THEMES.custom;
  return {
    ...base,
    fg,
    soft: fg,
    // 次要文字由文字色混白得到，和 popup 的 --tmt-muted 保持一致的做法
    muted: `color-mix(in srgb, ${fg} 55%, #fff)`,
    bg: `rgba(255,255,255,${a})`,
    surface: `rgba(255,255,255,${a})`,
    field: `rgba(255,255,255,${Math.min(1, a + 0.08)})`,
    inputBg: `rgba(246,249,253,${a})`,
    outBg: `rgba(240,246,255,${a})`,
  };
}

/** 只有"单个英文单词"才查音标、给朗读按钮；句子不做 */
const WORD_RE = /^[A-Za-z][A-Za-z'’-]{0,29}$/;

/** 安装划词翻译监听。重复调用只更新 config，不重复绑事件。 */
export function installSelection(opts) {
  config.enabled = opts?.enabled ?? config.enabled ?? false;
  config.showMode = opts?.showMode ?? config.showMode ?? 'direct';
  if (opts?.dict) config.dict = { ...config.dict, ...opts.dict };
  if (opts?.themeImage !== undefined) {
    if (opts.themeImage !== config.themeImage) {
      config.themeImage = opts.themeImage;
      if (panel) hidePanel();
    }
  }
  // 自定义主题的透明度/文字颜色：与 popup 设置保持同一套值
  const nextAlpha = opts?.themeAlpha ?? config.themeAlpha;
  const nextImgAlpha = opts?.themeImageAlpha ?? config.themeImageAlpha;
  const nextFg = opts?.themeTextColor ?? config.themeTextColor;
  if (nextAlpha !== config.themeAlpha || nextImgAlpha !== config.themeImageAlpha || nextFg !== config.themeTextColor) {
    config.themeAlpha = nextAlpha;
    config.themeImageAlpha = nextImgAlpha;
    config.themeTextColor = nextFg;
    if (panel) hidePanel();
  }
  if (opts?.theme && opts.theme !== config.theme) {
    config.theme = opts.theme;
    // 已打开的面板用旧配色，关掉让下次划词用新主题重建
    if (panel) hidePanel();
  }
  // 日志里不要带背景图 dataURL（会撑爆调试区）
  log.info('[selection] config', {
    ...config,
    themeImage: config.themeImage ? `${config.themeImage.slice(0, 32)}…(${config.themeImage.length} chars)` : '',
  });

  if (listenersBound) return;
  listenersBound = true;

  // mouseup：选区完成后取词
  document.addEventListener('mouseup', onMouseUp, true);
  // mousedown：点击其他区域时隐藏浮层/图标（图钉固定时不隐藏）
  document.addEventListener('mousedown', onMouseDown, true);
  // Esc：关闭浮层（图钉固定时不关闭）
  document.addEventListener('keydown', onKeyDown, true);
  // 滚动时隐藏浮层（图钉固定时不隐藏）
  document.addEventListener('scroll', () => { hideIcon(); if (!pinned) hidePanel(); }, true);

  // ---- 输入框 triggerKey ---------------------------------------------------
  document.addEventListener('keydown', async (ev) => {
    if (ev.key !== '/') return;
    const active = document.activeElement;
    if (!active) return;
    const isInput = active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' ||
      active.isContentEditable;
    if (!isInput) return;
    const text = (active.value ?? active.textContent ?? '').trim();
    if (!text) return;

    ev.preventDefault();
    ev.stopPropagation();

    try {
      const cfg = await chrome.runtime.sendMessage({ method: MSG.GET_CONFIG });
      const { results } = await chrome.runtime.sendMessage({
        method: MSG.TRANSLATE_BATCH,
        data: {
          service: cfg.config.service,
          from: cfg.config.sourceLanguage,
          to: cfg.config.targetLanguage,
          texts: [text],
        },
      });
      const translated = results?.[0]?.translation || '';
      if (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA') {
        const start = active.selectionStart;
        const end = active.selectionEnd;
        active.value = active.value.slice(0, start) + translated + active.value.slice(end);
      } else if (active.isContentEditable) {
        active.textContent = translated;
      }
    } catch (err) {
      log.warn('输入框翻译失败', err);
    }
  }, true);
}

/** 鼠标抬起：取当前选区 */
function onMouseUp(e) {
  if (!config.enabled) return;
  // ★ 关键修复：如果鼠标是在 T 图标或译文面板内抬起的，不重新处理选区。
  // 否则 click 触发的 translateAndShow 刚创建面板，排到队的 handleSelection
  // 又会因为文本仍被选中而走 icon 分支调用 hidePanel()，表现为"闪现后消失"。
  if ((iconBtn && iconBtn.contains(e.target)) || (panel && panel.contains(e.target))) return;
  // 延迟一帧，确保 selection 已经更新到最新选区
  setTimeout(handleSelection, 0);
}

/** 鼠标按下：点到非面板/图标区域则隐藏（图钉固定的面板不隐藏） */
function onMouseDown(e) {
  if (iconBtn && !iconBtn.contains(e.target)) hideIcon();
  if (panel && !panel.contains(e.target) && !pinned) hidePanel();
}

function onKeyDown(e) {
  if (e.key === 'Escape' && !pinned) { hideIcon(); hidePanel(); }
}

/** 处理选区：根据 showMode 决定直接翻译还是先显示图标 */
function handleSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    hideIcon();
    return;
  }
  const text = sel.toString().trim();
  if (!text) {
    hideIcon();
    return;
  }
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) {
    hideIcon();
    return;
  }

  currentSelection = { text, rect };

  if (config.showMode === 'icon') {
    showIcon(rect);
    if (!pinned) hidePanel();
  } else {
    hideIcon();
    translateAndShow(text, rect);
  }
}

/** 在选区右下角显示 TTranslate 图标 */
function showIcon(rect) {
  hideIcon();
  iconBtn = document.createElement('button');
  iconBtn.type = 'button';
  iconBtn.textContent = 'T';
  iconBtn.style.cssText = [
    'position: fixed',
    'z-index: 2147483647',
    'width: 26px',
    'height: 26px',
    'border-radius: 50%',
    'border: none',
    `background: ${P().primary}`,
    'color: #fff',
    'font-size: 14px',
    'font-weight: 700',
    'cursor: pointer',
    `box-shadow: ${P().shadow}`,
    'display: flex',
    'align-items: center',
    'justify-content: center',
    'line-height: 1',
    'padding: 0',
    'font-family: inherit',
  ].join(';');
  iconBtn.title = t('overlay.iconTip');

  // 定位到选区右下角，溢出则翻到左侧/上方
  const btnSize = 26;
  const viewportW = document.documentElement.clientWidth || window.innerWidth;
  const viewportH = window.innerHeight;
  let left = rect.right + 4;
  let top = rect.bottom + 4;
  if (left + btnSize > viewportW - 4) left = rect.right - btnSize - 4;
  if (top + btnSize > viewportH - 4) top = rect.top - btnSize - 4;
  left = Math.max(4, left);
  top = Math.max(4, top);
  iconBtn.style.left = `${left}px`;
  iconBtn.style.top = `${top}px`;

  // 点击图标：立即隐藏图标 + 翻译
  iconBtn.addEventListener('mousedown', (e) => e.stopPropagation());
  iconBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    hideIcon();
    if (currentSelection) {
      translateAndShow(currentSelection.text, currentSelection.rect);
    }
  });

  document.documentElement.appendChild(iconBtn);
}

function hideIcon() {
  if (iconBtn) { iconBtn.remove(); iconBtn = null; }
}

/** 调用翻译并在选区附近显示译文面板 */
async function translateAndShow(text, rect, fromLang, toLang) {
  showPanel(rect, text, t('popup.page.translating'));
  log.info('[selection] 取词', JSON.stringify(text.slice(0, 80)), 'len=', text.length);

  // 单词才查音标；句子直接隐藏音标行（不阻塞翻译）
  updatePhonetic(text);

  // 无网络：直接给出明确提示，不发起必然失败的请求
  if (navigator.onLine === false) {
    log.warn('[selection] 无网络，跳过翻译请求');
    currentTranslation = '';
    updatePanelResult(`${t('common.noTranslation')}\n${t('common.offline')}`);
    return;
  }

  try {
    const cfg = await chrome.runtime.sendMessage({ method: MSG.GET_CONFIG });
    const from = fromLang || cfg.config.sourceLanguage;
    const to = toLang || cfg.config.targetLanguage;
    const { results } = await chrome.runtime.sendMessage({
      method: MSG.TRANSLATE_BATCH,
      data: {
        service: cfg.config.service,
        from,
        to,
        texts: [text.slice(0, 2000)],
      },
    });

    const r = results?.[0];
    if (!r?.ok || !r?.translation) {
      log.warn('[selection] 翻译失败', r?.error || '无返回');
      currentTranslation = '';
      updatePanelResult(`${t('common.noTranslation')}\n${r?.error || t('overlay.noResult')}`);
      return;
    }

    log.info('[selection] 译文', JSON.stringify(r.translation.slice(0, 80)));
    currentTranslation = r.translation;
    updatePanelResult(r.translation);
  } catch (err) {
    log.warn('[selection] 翻译失败', err?.message || err);
    currentTranslation = '';
    updatePanelResult(`${t('common.noTranslation')}\n${t('common.translateFailed', { err: err?.message || err })}`);
  }
}

// ---- 译文面板 --------------------------------------------------------------

/** 创建并显示译文面板
 * 布局（类似 popup 普通翻译）：
 *   标题栏：TTranslate  [📌] [✕]
 *   原文区：选中的文本
 *   语言对：源语言 ▼  →  目标语言 ▼
 *   译文区：翻译结果
 *   操作栏：[复制译文]
 */
function showPanel(rect, sourceText, resultText) {
  // 如果面板已存在，只更新内容，不重建（保留图钉/语言状态）
  if (panel) {
    updatePanelSource(sourceText);
    if (resultText !== undefined) updatePanelResult(resultText);
    positionPanel(rect);
    return;
  }

  panel = document.createElement('div');
  const p = P();
  panel.style.cssText = [
    'position: fixed',
    'z-index: 2147483647',
    'width: min(380px, 92vw)',
    'box-sizing: border-box',
    `background: ${p.bg}`,
    `color: ${p.fg}`,
    `border: 1px solid ${p.border}`,
    'border-radius: 8px',
    `box-shadow: ${p.shadow}`,
    'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    'font-size: 13px',
    'overflow: hidden',
  ].join(';');
  // 自定义主题：底色半透明 + 毛玻璃；选了本地背景图时铺在面板上并压低透明度
  if (config.theme === 'custom') {
    panel.style.backdropFilter = 'blur(8px)';
    if (config.themeImage) {
      // 背景图透明度与 popup 一致：图片越透明，白色蒙版越浓
      const imgA = Math.min(1, Math.max(0, Number(config.themeImageAlpha) ?? 1));
      const scrim = 1 - imgA;
      panel.style.backgroundImage = `linear-gradient(rgba(255,255,255,${scrim}), rgba(255,255,255,${scrim})), url("${config.themeImage}")`;
      panel.style.backgroundSize = 'cover';
      panel.style.backgroundPosition = 'center';
      panel.style.backdropFilter = 'none';
    }
  }

  // ---- 标题栏：标题 + 图钉 + 关闭 ----
  const header = document.createElement('div');
  header.style.cssText = [
    'display: flex',
    'align-items: center',
    'gap: 4px',
    'padding: 6px 8px',
    `border-bottom: 1px solid ${p.border}`,
    `background: ${p.surface}`,
  ].join(';');

  // 标题：左侧品牌图标 + 文字
  const title = document.createElement('span');
  title.style.cssText = [
    'display: flex', 'align-items: center', 'gap: 6px',
    'margin-right: auto',
  ].join(';');

  const logo = document.createElement('img');
  logo.alt = 'TTranslate';
  logo.style.cssText = [
    'width: 16px', 'height: 16px', 'border-radius: 4px',
    'display: block', 'flex: 0 0 auto',
  ].join(';');
  try {
    logo.src = chrome.runtime.getURL('icons/icon48.png');
  } catch {
    logo.style.display = 'none';
  }

  const titleText = document.createElement('span');
  titleText.textContent = 'TTranslate';
  titleText.style.cssText = `font-weight: 600; font-size: 13px; color: ${p.fg};`;

  title.appendChild(logo);
  title.appendChild(titleText);

  // 图钉按钮：图标与扩展弹窗头部保持一致（同一个 SVG 路径，跟随文字颜色）
  const pinBtn = document.createElement('button');
  pinBtn.type = 'button';
  pinBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M14.5 2.5a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4l-1.3 1.3a2 2 0 0 1-1.6.6l-3.4 3.4.5 3.3a1 1 0 0 1-1.7.9l-4.2-4.2-5.1 5.1a1 1 0 1 1-1.4-1.4l5.1-5.1-4.2-4.2a1 1 0 0 1 .9-1.7l3.3.5 3.4-3.4a2 2 0 0 1 .6-1.6z"/></svg>';
  pinBtn.title = t('overlay.pinTip');
  pinBtn.style.cssText = [
    'width: 24px', 'height: 24px',
    'border: 1px solid transparent', 'border-radius: 4px',
    `background: none`, `color: ${p.muted}`,
    'cursor: pointer',
    'display: flex', 'align-items: center', 'justify-content: center',
    'padding: 0', 'line-height: 1',
  ].join(';');
  const applyPinStyle = () => {
    if (pinned) {
      pinBtn.style.background = p.pinBg;
      pinBtn.style.borderColor = p.pinBorder;
      pinBtn.style.color = p.primary;
    } else {
      pinBtn.style.background = 'none';
      pinBtn.style.borderColor = 'transparent';
      pinBtn.style.color = p.muted;
    }
  };
  pinBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pinned = !pinned;
    applyPinStyle();
  });

  // 关闭按钮（图钉右边）
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.innerHTML = '✕';
  closeBtn.title = t('overlay.close');
  closeBtn.style.cssText = [
    'width: 24px', 'height: 24px',
    'border: none', 'border-radius: 4px',
    'background: none', 'cursor: pointer', 'font-size: 13px',
    `color: ${p.muted}`,
    'display: flex', 'align-items: center', 'justify-content: center',
    'padding: 0', 'line-height: 1',
  ].join(';');
  closeBtn.addEventListener('mouseenter', () => { closeBtn.style.background = p.hover; });
  closeBtn.addEventListener('mouseleave', () => { closeBtn.style.background = 'none'; });
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    pinned = false;
    hidePanel();
  });

  header.appendChild(title);
  header.appendChild(pinBtn);
  header.appendChild(closeBtn);

  // 标题栏可拖拽：按住标题栏空白处移动整个面板
  // 注意：点击按钮（图钉/关闭）不触发拖拽；用 3px 位移阈值区分点击与拖拽
  header.style.cursor = 'grab';
  header.addEventListener('mousedown', (e) => {
    // 点到按钮上就不拖
    if (e.target.closest('button')) return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startLeft = panel.offsetLeft;
    const startTop = panel.offsetTop;
    let dragged = false;

    header.style.cursor = 'grabbing';

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragged && Math.abs(dx) + Math.abs(dy) < 3) return;
      dragged = true;
      // 夹在视口内，避免拖出屏幕看不见
      const maxLeft = window.innerWidth - panel.offsetWidth;
      const maxTop = window.innerHeight - panel.offsetHeight;
      panel.style.left = `${Math.max(0, Math.min(startLeft + dx, maxLeft))}px`;
      panel.style.top = `${Math.max(0, Math.min(startTop + dy, maxTop))}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      header.style.cursor = 'grab';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  // ---- 正文区 ----
  const body = document.createElement('div');
  body.style.cssText = 'padding: 10px 12px; display: flex; flex-direction: column; gap: 10px;';

  // 1) 原文：可编辑输入框（初始为选中文本，修改后防抖自动翻译）
  const sourceEl = document.createElement('textarea');
  sourceEl.className = 'tmt-sel-source';
  sourceEl.rows = 3;
  sourceEl.placeholder = t('overlay.placeholder');
  sourceEl.style.cssText = [
    'margin: 0',
    'padding: 8px 10px',
    `background: ${p.inputBg}`,
    `border: 1px solid ${p.border}`,
    'border-radius: 4px',
    'font-size: 13px',
    'line-height: 1.6',
    `color: ${p.soft}`,
    'white-space: pre-wrap',
    'word-break: break-word',
    'resize: vertical',
    'width: 100%',
    'box-sizing: border-box',
    'min-height: 60px',
    'max-height: 30vh',
    'overflow: auto',
    'font-family: inherit',
  ].join(';');
  sourceEl.value = sourceText || '';

  // 输入防抖：停止输入 500ms 后自动翻译最新内容
  sourceEl.addEventListener('input', () => {
    const text = sourceEl.value.trim();
    // 同步 currentSelection，保证复制原文按钮拿到最新内容
    if (currentSelection) currentSelection.text = sourceEl.value;
    clearTimeout(debounceTimer);
    if (!text) {
      hidePhonetic();
      return;
    }
    // 立刻收掉不再匹配的旧音标，避免和输入内容对不上
    if (!WORD_RE.test(text)) hidePhonetic();
    debounceTimer = setTimeout(() => {
      translateAndShow(text, currentSelection?.rect || { left: 0, top: 0, bottom: 0, right: 0 }, sourceSel.value, targetSel.value);
    }, 500);
  });

  // 1.5) 音标行：仅当原文是单个英文单词时显示
  const phoneticRow = document.createElement('div');
  phoneticRow.className = 'tmt-sel-phonetic';
  phoneticRow.style.cssText = [
    'display: none',
    'align-items: center',
    'gap: 12px',
    'flex-wrap: wrap',
    'font-size: 12px',
    `color: ${p.muted}`,
    'margin-top: -4px',
  ].join(';');

  // 2) 语言对：源语言 → 目标语言
  const langRow = document.createElement('div');
  langRow.style.cssText = 'display: flex; align-items: center; gap: 6px;';
  const sourceSel = document.createElement('select');
  const arrow = document.createElement('span');
  arrow.textContent = '→';
  arrow.style.cssText = `color: ${p.faint}; font-size: 14px;`;
  const targetSel = document.createElement('select');
  const selStyle = [
    'flex: 1 1 0',
    'min-width: 0',
    'font-size: 12px',
    'padding: 4px 6px',
    `border: 1px solid ${p.border}`,
    'border-radius: 4px',
    `background: ${p.field}`,
    `color: ${p.fg}`,
    'cursor: pointer',
  ].join(';');
  sourceSel.style.cssText = selStyle;
  targetSel.style.cssText = selStyle;

  // 源语言含 auto，目标语言不含 auto
  for (const l of LANGUAGES) {
    const o1 = document.createElement('option');
    o1.value = l.code; o1.textContent = langLabel(l);
    sourceSel.appendChild(o1);
    if (l.code !== 'auto') {
      const o2 = document.createElement('option');
      o2.value = l.code; o2.textContent = langLabel(l);
      targetSel.appendChild(o2);
    }
  }
  // 回填当前全局语言
  chrome.runtime.sendMessage({ method: MSG.GET_CONFIG }).then((cfg) => {
    if (cfg?.config) {
      sourceSel.value = cfg.config.sourceLanguage || 'auto';
      targetSel.value = cfg.config.targetLanguage || 'zh-CN';
    }
  }).catch(() => {});

  // 切换语言：重新翻译 + 同步全局配置
  const onLangChange = async () => {
    if (!currentSelection) return;
    try {
      const cfg = await chrome.runtime.sendMessage({ method: MSG.GET_CONFIG });
      const next = structuredClone(cfg.config);
      next.sourceLanguage = sourceSel.value;
      next.targetLanguage = targetSel.value;
      await chrome.runtime.sendMessage({ method: MSG.UPDATE_CONFIG, data: next });
    } catch (err) {
      log.warn('[selection] 同步语言失败', err);
    }
    translateAndShow(currentSelection.text, currentSelection.rect, sourceSel.value, targetSel.value);
  };
  sourceSel.addEventListener('change', onLangChange);
  targetSel.addEventListener('change', onLangChange);

  langRow.appendChild(sourceSel);
  langRow.appendChild(arrow);
  langRow.appendChild(targetSel);

  // 3) 译文结果
  const result = document.createElement('div');
  result.className = 'tmt-sel-result';
  result.style.cssText = [
    'margin: 0',
    'padding: 10px',
    `background: ${p.outBg}`,
    `border-left: 3px solid ${p.primary}`,
    'border-radius: 4px',
    'font-size: 13px',
    'line-height: 1.6',
    `color: ${p.outFg}`,
    'white-space: pre-wrap',
    'word-break: break-word',
    'user-select: text',
    'max-height: 40vh',
    'overflow: auto',
  ].join(';');
  result.textContent = resultText || '';

  body.appendChild(sourceEl);
  body.appendChild(phoneticRow);
  body.appendChild(langRow);
  body.appendChild(result);

  // ---- 操作栏：复制原文 + 复制译文（右对齐） ----
  const footer = document.createElement('div');
  footer.style.cssText = [
    'display: flex', 'justify-content: flex-end', 'gap: 8px',
    'padding: 6px 12px 10px',
    `border-top: 1px solid ${p.hover}`,
  ].join(';');

  // 通用按钮样式（避免重复写）
  const btnBaseStyle = [
    'padding: 3px 10px',
    'font-size: 12px', 'line-height: 18px',
    `color: ${p.muted}`, `background: ${p.field}`,
    `border: 1px solid ${p.border}`, 'border-radius: 4px',
    'cursor: pointer',
  ].join(';');
  const btnHover = (b) => {
    b.addEventListener('mouseenter', () => { b.style.color = p.primary; b.style.borderColor = p.primary; });
    b.addEventListener('mouseleave', () => { b.style.color = p.muted; b.style.borderColor = p.border; });
  };
  const btnDone = (b, origKey) => {
    b.textContent = t('common.copied');
    b.style.color = '#1a9a5b';
    b.style.borderColor = '#bfe3cd';
    setTimeout(() => {
      b.textContent = t(origKey);
      b.style.color = p.muted;
      b.style.borderColor = p.border;
    }, 1200);
  };

  // 复制原文按钮（左边）
  const copySrcBtn = document.createElement('button');
  copySrcBtn.type = 'button';
  copySrcBtn.textContent = t('common.copySource');
  copySrcBtn.style.cssText = btnBaseStyle;
  btnHover(copySrcBtn);
  copySrcBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const src = currentSelection?.text;
    if (!src) return;
    try {
      await navigator.clipboard.writeText(src);
      btnDone(copySrcBtn, 'common.copySource');
    } catch {
      // 剪贴板不可用：选中原文输入框内容让用户手动 Ctrl+C
      const el = panel.querySelector('.tmt-sel-source');
      if (el && typeof el.select === 'function') el.select();
      copySrcBtn.textContent = t('common.pressCtrlC');
    }
  });

  // 复制译文按钮（右边）
  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = t('common.copyTranslation');
  copyBtn.style.cssText = btnBaseStyle;
  btnHover(copyBtn);
  copyBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!currentTranslation) return;
    try {
      await navigator.clipboard.writeText(currentTranslation);
      btnDone(copyBtn, 'common.copyTranslation');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(result);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      copyBtn.textContent = t('common.pressCtrlC');
    }
  });
  footer.appendChild(copySrcBtn);
  footer.appendChild(copyBtn);

  panel.appendChild(header);
  panel.appendChild(body);
  panel.appendChild(footer);

  // 阻止面板内的 mousedown 冒泡到 document（避免触发外部点击关闭）
  panel.addEventListener('mousedown', (e) => e.stopPropagation());

  // 记录可重本地化的元素，界面语言热更新时用
  panelRefs = { pinBtn, closeBtn, sourceEl, copySrcBtn, copyBtn, sourceSel, targetSel };

  document.documentElement.appendChild(panel);
  positionPanel(rect);
}

/** 界面语言热更新：重标已打开的面板/图标上的文案（不重建 DOM，不影响翻译内容） */
export function relocalizeOverlay() {
  if (iconBtn) iconBtn.title = t('overlay.iconTip');
  if (!panel || !panelRefs) return;
  panelRefs.pinBtn.title = t('overlay.pinTip');
  panelRefs.closeBtn.title = t('overlay.close');
  panelRefs.sourceEl.placeholder = t('overlay.placeholder');
  panelRefs.copySrcBtn.textContent = t('common.copySource');
  panelRefs.copyBtn.textContent = t('common.copyTranslation');
  // 语言下拉选项文案跟随界面语言（保留当前选中值）
  for (const sel of [panelRefs.sourceSel, panelRefs.targetSel]) {
    const prev = sel.value;
    for (const opt of sel.options) {
      const l = LANGUAGES.find(x => x.code === opt.value);
      if (l) opt.textContent = langLabel(l);
    }
    sel.value = prev;
  }
}

/** 更新面板里的原文内容 */
function updatePanelSource(text) {
  if (!panel) return;
  const el = panel.querySelector('.tmt-sel-source');
  if (el) el.value = text || '';
}

/**
 * 查音标并渲染到面板里 —— 只对单个英文单词生效。
 * 句子 / 中文 / 词组直接隐藏整行，不发起任何请求。
 */
async function updatePhonetic(text) {
  if (!panel) return;
  const word = (text || '').trim();

  // 音标 + 朗读都关掉时，整行不出现、也不发请求
  const showPhonetic = config.dict?.phonetic !== false;
  const showSpeak = config.dict?.speak !== false;
  if (!showPhonetic && !showSpeak) { hidePhonetic(); return; }

  if (!WORD_RE.test(word)) { hidePhonetic(); return; }

  const row = panel.querySelector('.tmt-sel-phonetic');
  if (!row) return;

  row.style.display = 'flex';
  row.textContent = t('common.phoneticLoading');

  let resp = null;
  try {
    resp = await chrome.runtime.sendMessage({
      method: MSG.GET_WORD_INFO,
      data: { text: word, provider: config.dict?.provider || 'auto' },
    });
  } catch (err) {
    log.warn('[selection] 音标查询失败', err?.message || err);
  }

  // 面板可能已关闭，或原文已经改了：丢弃过期结果
  if (!panel) return;
  const latest = panel.querySelector('.tmt-sel-source')?.value.trim();
  if (latest !== word) return;
  const rowNow = panel.querySelector('.tmt-sel-phonetic');
  if (!rowNow) return;

  if (!resp?.ok || !Array.isArray(resp.phonetics) || resp.phonetics.length === 0) {
    hidePhonetic();
    return;
  }

  rowNow.textContent = '';
  for (const p of resp.phonetics) {
    const item = document.createElement('span');
    item.style.cssText = 'display: inline-flex; align-items: center; gap: 4px;';

    if (showPhonetic) {
      if (p.region) {
        const region = document.createElement('span');
        region.textContent = regionLabel(p.region);
        region.style.cssText = `color: ${P().faint};`;
        item.appendChild(region);
      }

      const ph = document.createElement('span');
      ph.textContent = p.text;
      ph.style.cssText = `color: ${P().outFg}; font-size: 13px;`;
      item.appendChild(ph);
    }

    if (showSpeak) {
      const speakBtn = document.createElement('button');
      speakBtn.type = 'button';
      // 不显示音标时，按钮上带上口音标签，避免两个按钮长得一模一样
      const regionText = regionLabel(p.region);
      speakBtn.textContent = showPhonetic ? '🔊' : `🔊${regionText ? ' ' + regionText : ''}`;
      speakBtn.title = regionText ? t('common.speakTip', { region: regionText }) : t('common.speakTipNoRegion');
      speakBtn.style.cssText = [
        `border: 1px solid ${P().border}`,
        `background: ${P().field}`,
        `color: ${P().muted}`,
        'border-radius: 4px',
        'cursor: pointer',
        'padding: 0 5px',
        'font-size: 12px',
        'line-height: 18px',
      ].join(';');
      speakBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        playWord(word, p.audio, p.region === '英' ? 'en-GB' : 'en-US');
      });
      item.appendChild(speakBtn);
    }

    rowNow.appendChild(item);
  }
  rowNow.style.display = 'flex';
}

/** 隐藏音标行 */
function hidePhonetic() {
  if (!panel) return;
  const row = panel.querySelector('.tmt-sel-phonetic');
  if (!row) return;
  row.style.display = 'none';
  row.textContent = '';
}

/** 更新面板里的译文内容 */
function updatePanelResult(text) {
  if (!panel) return;
  const result = panel.querySelector('.tmt-sel-result');
  if (result) result.textContent = text;
}

/** 把面板定位到选区附近（下方优先，放不下则上方） */
function positionPanel(rect) {
  if (!panel) return;
  const tipW = panel.offsetWidth || 360;
  const tipH = panel.offsetHeight || 120;
  const viewportW = document.documentElement.clientWidth || window.innerWidth;
  const viewportH = window.innerHeight;

  const left = Math.max(8, Math.min(rect.left, viewportW - tipW - 8));
  const below = rect.bottom + 10;
  const above = rect.top - tipH - 10;
  let top;
  if (below + tipH <= viewportH - 8) {
    top = below;
  } else if (above >= 8) {
    top = above;
  } else {
    top = Math.max(8, Math.min(below, viewportH - tipH - 8));
  }
  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
}

function hidePanel() {
  if (panel) { panel.remove(); panel = null; }
  panelRefs = null;
  clearTimeout(debounceTimer);
  debounceTimer = null;
  currentTranslation = '';
  pinned = false;
}
