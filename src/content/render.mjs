/**
 * ============================================================================
 * content/render.mjs —— 渲染管线
 * ============================================================================
 * 支持多种显示模式（双语对照 / 左右对照 / 句级交错 / 悬停展开 /
 * 悬停浮层 / 点击展开 / 原处替换 / 原处替换+悬停看原文），
 * 以及纯文本、各类下划线、引用块、荧光笔、卡片、毛玻璃、缩进等显示主题。
 * 事件保真：wrapper 里的译文点击时不阻止冒泡，这样页面的原 listener 依然能收到事件。
 * ============================================================================
 */

import { MARK, log } from '../shared/constants.mjs';
import { BLOCK_TAGS } from '../shared/utils.mjs';

/**
 * 这些标签内部插入 div/span 属于非法 HTML（浏览器会把节点甩出表格渲染，
 * 导致译文变成表格旁的竖条、表格布局塌陷）。译文必须放进单元格内部。
 */
const INVALID_TABLE_PARENT = new Set(['TR', 'TBODY', 'THEAD', 'TFOOT', 'TABLE', 'CAPTION', 'COLGROUP', 'COL']);

/** 译文颜色取值：与 popup「译文颜色」下拉一一对应 */
const TEXT_COLORS = {
  light: '#ffffff',
  dark: '#000000',
  red: '#d93025',
  orange: '#e8710a',
  yellow: '#b58900',
  green: '#188038',
  blue: '#1a73e8',
  purple: '#7b1fa2',
  pink: '#d01884',
};

/** 解析译文颜色；旧配置（auto / gray / black）统一回退到暗色，custom 用自定义色值 */
function resolveTextColor(value, custom) {
  if (value === 'custom') return /^#[0-9a-f]{6}$/i.test(custom || '') ? custom : '#000000';
  const v = (value === 'auto' || value === 'gray' || value === 'black') ? 'dark' : value;
  return TEXT_COLORS[v] || TEXT_COLORS.dark;
}

/**
 * 译文字号 / 颜色热更新：只改已有译文元素的这两个属性，不重新翻译、不重排页面。
 * 原处替换模式没有译文壳，字号颜色由页面原文继承，无需处理。
 */
export function applyTranslationStyleToExisting(scale, colorValue, customColor) {
  const wrappers = document.querySelectorAll(`.${MARK.TARGET_WRAPPER}`);
  if (!wrappers.length) return;
  const size = `${Number(scale) || 1}em`;
  const color = resolveTextColor(colorValue, customColor);
  wrappers.forEach(el => {
    // 导航栏内联译文保持继承原元素颜色/字号，避免彩色导航条上突兀
    if (el.classList.contains('tmt-nav-trans')) return;
    el.style.fontSize = size;
    el.style.color = color;
  });
}

/**
 * 渲染一批结果。engine 拿到 pipeline 的结果后调这个函数。
 * @param {Array<{ para, ok, translation?, error? }>} results 批结果
 * @param {object} state engine 的 state
 */
export function renderBatch(results, state) {
  if (!results?.length) return;

  // 1) 一次性挂主题 CSS 变量（只做一次，换主题时由 SET_THEME 消息重设）
  applyThemeVars(state.config.theme, state.config.themes, state.config.themeColor);

  // 2) 同步显示模式：注入模式 CSS + 把当前模式打到 <html> 上。
  //    （首次渲染时 state.mode 可能不是 dual，必须在这里兜底设置）
  ensureModeStyle();
  document.documentElement.setAttribute('data-tmt-mode', state.mode);

  for (const r of results) {
    if (!r.ok) {
      renderError(r.para, r.error);
      continue;
    }
    renderTranslation(r.para, r.translation, state);
  }
}

/**
 * 把译文壳插到原文前/后。三种容器情形：
 *  - 表格结构（父节点是 tr/tbody 等）：兄弟插入属非法 HTML，放进单元格内部；
 *  - blockEl 是从行内元素向上爬升得到的块级祖先时（卡片里的按钮链接等），
 *    锚定行内源元素，译文留在同一容器内，避免被抛到 grid 网格层；
 *  - 普通情形：blockEl 兄弟插入。
 * 译文位置热更新（applyPositionToExisting）与首次渲染共用此逻辑。
 */
function placeWrapper(para, wrapper, pos) {
  const parent = para.blockEl.parentNode;
  if (!parent) return;

  if (INVALID_TABLE_PARENT.has(parent.tagName)) {
    const cell = para.blockEl.closest?.('td,th') || para.blockEl;
    if (pos === 'after') cell.appendChild(wrapper);
    else cell.insertBefore(wrapper, cell.firstChild);
    return;
  }

  let anchor = para.blockEl;
  if (para.isBlock) {
    const pick = pickBlockAnchor(para);
    if (pick !== para.blockEl) anchor = pick;
  }
  if (pos === 'after') anchor.after(wrapper);
  else anchor.before(wrapper);
}

/**
 * 译文位置热更新：把已有译文壳按新位置重新插入，只移动 DOM 节点，不重新翻译。
 * 导航内联译文（tmt-nav-trans）固定跟随原文同行，位置配置对它不生效，跳过。
 */
export function applyPositionToExisting(state) {
  const pos = state.config.translationPosition || 'after';
  for (const para of state.paragraphs.values()) {
    const wrapper = para.targetWrapper;
    if (!wrapper?.isConnected) continue;
    if (wrapper.classList.contains('tmt-nav-trans')) continue;
    placeWrapper(para, wrapper, pos);
  }
}

/**
 * 渲染单条译文。核心思路：
 *   - 块级段落：建一个 div.tmt-target-wrapper，插在 blockEl 的 parent 里
 *   - 行内段落：建一个 span.tmt-target-wrapper，插到行内
 *   - wrapper 用 data-tmt-state 反映当前显示模式
 */
function renderTranslation(para, translation, state) {
  // 同一个段落可能被重复处理，先清掉旧的
  para.targetWrapper?.remove();

  // 打段落锚点：忽略功能与悬停类模式（hoverTip / replaceHover）都靠它定位段落。
  // 各模式的可见性规则见 ensureModeStyle；restorePage 会统一清理。
  para.blockEl.setAttribute(MARK.PARAGRAPH, para.id);

  // 原处替换：不插入任何 wrapper，直接改写文本节点。
  // 元素树、属性、事件监听一概不动，按钮/链接/表单完全保持原样可交互。
  if (state.mode === 'replace' || state.mode === 'replaceHover') {
    renderReplaceInPlace(para, translation, state);
    return;
  }

  // 导航栏 / 侧边栏 / 面包屑：用紧凑内联样式，直接追加在元素内部。
  // 这些区域是 flex/inline 布局，插入块级卡片会撑高导航、挤乱面包屑。
  if (para.isNav && state.mode === 'dual') {
    renderNavInline(para, translation);
    return;
  }

  const wrapper = document.createElement(para.isBlock ? 'div' : 'span');
  wrapper.className = MARK.TARGET_WRAPPER + (para.isBlock ? ' ' + MARK.TRANSLATION_BLOCK_WRAPPER : '');
  wrapper.setAttribute(MARK.STATE, state.mode);
  wrapper.setAttribute('translate', 'no');
  wrapper.setAttribute('lang', state.config.targetLanguage);

  // 译文文本里保留段落换行；句级交错模式改成逐句成对渲染
  if (state.mode === 'sentence' && para.isBlock) {
    fillSentencePairs(wrapper, para.text, translation);
  } else {
    wrapper.textContent = translation;
  }

  // ---- 基础可见 CSS ----
  // 颜色/字号可配置，改动后由 applyTranslationStyleToExisting 热更新到已有译文
  const scale = Number(state.config.translationFontScale) || 1;
  const color = resolveTextColor(state.config.translationColor, state.config.translationColorCustom);
  const styles = [
    `color:${color}`,
    `font-size:${scale}em`,
    'line-height:1.55',
    'box-sizing:border-box',
    'word-break:break-word',
    // 主题装饰全部走 CSS 变量，切主题只更新变量、不遍历 DOM
    'box-shadow:var(--tmt-theme-shadow,none)',
    'text-indent:var(--tmt-theme-indent,0)',
    'text-decoration:var(--tmt-theme-deco,none)',
    'backdrop-filter:var(--tmt-theme-filter,none)',
  ];

  if (para.isBlock) {
    // 块级：紧跟原文下方的独立一行。视觉装饰全部由主题变量提供，
    // 默认主题（纯文本）无背景无边框，等价于"原位置换行嵌入译文"。
    styles.push(
      'display:block',
      'margin:3px 0 2px',
      'background:var(--tmt-theme-bg,transparent)',
      'border-bottom:var(--tmt-theme-bb,none)',
      'border-left:var(--tmt-theme-bl,none)',
      'padding:var(--tmt-theme-pad,0)',
      'border-radius:var(--tmt-theme-radius,0)',
    );
  } else {
    // 行内：同一行内紧跟在原文片段之后
    styles.push(
      'display:inline',
      'margin:0 2px',
      'background:var(--tmt-theme-bg,transparent)',
      'border-bottom:var(--tmt-theme-bb,none)',
      'padding:var(--tmt-theme-pad,0)',
      'border-radius:var(--tmt-theme-radius,0)',
    );
  }

  wrapper.style.cssText = styles.join(';');

  // ---- 插入位置 ----
  const pos = state.config.translationPosition || 'after';
  const parent = para.blockEl.parentNode;
  if (!parent) return;

  // 装饰性定位条（横幅/提示条等）：块级兄弟插入会溢出固定高度条带或与原文
  // 重叠（spring.io 顶部横幅 bug）。退化为行内副文案，译文与原文同行、
  // 共用容器原有的垂直居中。
  if (para.isBlock && !INVALID_TABLE_PARENT.has(parent.tagName) && isDecorativePositioned(para, parent)) {
    renderNavInline(para, translation);
    return;
  }
  placeWrapper(para, wrapper, pos);

  // 左右对照：原文与译文各占一栏（inline-block 等比并排）。
  // 表格单元格/行改成 inline-block 会破坏表格布局，这类元素跳过。
  const TABLEY = new Set(['TD', 'TH', 'TR', 'TABLE', 'TBODY', 'THEAD', 'TFOOT']);
  if (state.mode === 'sideBySide' && para.isBlock && !TABLEY.has(para.blockEl.tagName)) {
    applySideBySide(para.blockEl);
    wrapper.style.display = 'inline-block';
    wrapper.style.width = '46%';
    wrapper.style.verticalAlign = 'top';
    wrapper.style.marginLeft = '3%';
  }

  para.targetWrapper = wrapper;
}

/**
 * 句级交错：把原文与译文按句配对，逐句成行展示。
 * 句数对不上时退回整段译文（宁可不交错，也不能错位）。
 */
function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?。！？；;])\s*/)
    .map(s => s.trim())
    .filter(Boolean);
}

function fillSentencePairs(wrapper, source, translation) {
  const src = splitSentences(source);
  const dst = splitSentences(translation);
  wrapper.textContent = '';
  if (!src.length || src.length !== dst.length) {
    wrapper.textContent = translation;
    return;
  }
  src.forEach((s, i) => {
    const srcLine = document.createElement('div');
    srcLine.textContent = s;
    srcLine.style.cssText = 'opacity:0.6;font-size:0.95em;margin-top:2px';
    const dstLine = document.createElement('div');
    dstLine.textContent = dst[i];
    dstLine.style.cssText = 'margin-top:1px';
    wrapper.append(srcLine, dstLine);
  });
}

/** 左右对照：记录原文元素原样式，切模式时恢复 */
const sideBySidePrev = new WeakMap();

function applySideBySide(el) {
  if (!sideBySidePrev.has(el)) {
    sideBySidePrev.set(el, el.getAttribute('style') || '');
  }
  el.setAttribute('data-tmt-sbs', '1');
  el.style.display = 'inline-block';
  el.style.width = '50%';
  el.style.verticalAlign = 'top';
  el.style.marginRight = '0';
}

/** 还原所有被并排模式改过样式的原文元素（切模式/还原原文时调用） */
export function clearSideBySide() {
  document.querySelectorAll('[data-tmt-sbs]').forEach(el => {
    const prev = sideBySidePrev.get(el);
    if (prev) el.setAttribute('style', prev);
    else el.removeAttribute('style');
    sideBySidePrev.delete(el);
    el.removeAttribute('data-tmt-sbs');
  });
}

/**
 * 块级译文的插入锚点：正常情况下是 blockEl 自身（兄弟插入）。
 * 但当文本实际在 blockEl 内部的某个行内元素里（blockEl 是向上爬升的祖先，
 * 典型如 article 里的 <a> 按钮），按 blockEl 兄弟插入会把译文抛出该视觉
 * 容器；此时改锚定行内源元素，紧跟原文插入。
 * p/h1~h6 的内容模型只允许 phrasing 内容，块级 div 插进去会被浏览器拆开
 * 元素，因此源元素位于这类容器里时仍锚定 blockEl。
 */
function pickBlockAnchor(para) {
  const src = para.nodes?.[0]?.parentElement;
  if (!src || src === para.blockEl || !para.blockEl.contains(src)) return para.blockEl;
  if (src.closest?.('p,h1,h2,h3,h4,h5,h6')) return para.blockEl;
  return src;
}

/**
 * 装饰性定位场景：原元素自身脱离文档流（absolute/fixed），或父容器脱离文档流
 * 且高度钉死在单行左右（如 spring.io 顶部 40px 横幅）。这类容器里插入块级
 * 兄弟节点会与原文重叠或溢出条带，需要退化为行内副文案。
 */
function isDecorativePositioned(para, parent) {
  const selfPos = getComputedStyle(para.blockEl).position;
  if (selfPos === 'absolute' || selfPos === 'fixed') return true;
  const parentPos = getComputedStyle(parent).position;
  if (parentPos === 'absolute' || parentPos === 'fixed') {
    // 整屏高的绝对定位容器（弹层、悬浮面板等）不在此列，块级插入仍然安全
    return parent.getBoundingClientRect().height < 60;
  }
  return false;
}

/**
 * 原处替换：把译文直接写进原文文本节点。
 *  - 只动文本节点的 textContent，元素结构与事件监听完全不动；
 *  - 段落有多个文本节点时，译文写入第一个，其余清空（译文落点取段落起始处）；
 *  - 改写前在每个节点上保留原文（__tmtOriginal）并打标记（__tmtReplaced）：
 *    walker 收集时跳过带标记的节点，防止把译文当新原文回环翻译；
 *    切换显示模式/还原原文时用 __tmtOriginal 恢复（见 engine.restoreReplacedText）。
 *  - state.replaceActive 置位，让 rerenderAll/restorePage 知道需要恢复文本。
 */
function renderReplaceInPlace(para, translation, state) {
  const nodes = (para.nodes || []).filter(n => n.isConnected);
  if (!nodes.length) return;
  for (const n of nodes) {
    if (!n.__tmtReplaced) {
      n.__tmtOriginal = n.textContent;
      n.__tmtReplaced = true;
    }
  }
  nodes[0].textContent = translation;
  for (let i = 1; i < nodes.length; i++) nodes[i].textContent = '';
  // 「原处替换 + 悬停看原文」需要原文：文本节点里存了分段原文，
  // 这里另存整段，悬停时直接取用，避免再拼接。
  para.blockEl.__tmtOrigText = para.text;
  state.replaceActive = true;
  para.targetWrapper = null;

  // ---- 导航/固定宽度容器的溢出保护 ----
  // 只对 BLOCK_TAGS 里的语义块级标签（dt/dd/button/li/h1-h6）加约束：
  // 它们天然有父容器的固定宽度限制；div 这类布局容器（如下拉菜单里的navBarItem）宽度自适应，加 ellipsis 反而会误截断下拉子项。
  if (para.isNav && BLOCK_TAGS.has(para.blockEl.tagName)) {
    const el = para.blockEl;
    if (el.nodeType === 1) {
      // 保存原始 inline style 的 3 个属性，restore 时精确还原
      el.__tmtNavStyle = {
        overflow: el.style.overflow || '',
        whiteSpace: el.style.whiteSpace || '',
        textOverflow: el.style.textOverflow || '',
      };
      el.style.overflow = 'hidden';
      el.style.whiteSpace = 'nowrap';
      el.style.textOverflow = 'ellipsis';
    }
  }
}

/**
 * 导航区域的紧凑译文：一个小号、半透明的行内文本，紧跟在原文后面。
 * 不产生块级盒子，所以不会改变导航栏高度、不会打断面包屑排列。
 */
function renderNavInline(para, translation) {
  const el = document.createElement('span');
  el.className = `${MARK.TARGET_WRAPPER} tmt-nav-trans`;
  el.setAttribute(MARK.STATE, 'dual');
  el.setAttribute('translate', 'no');
  el.textContent = ' ' + translation;

  el.style.cssText = [
    // inline-block：block 布局里可整体换行；flex 里会被块化为独立 item
    'display:inline-block',
    'margin-left:2px',
    'font-size:0.85em',
    'line-height:1.3',
    'color:inherit',       // 跟随原元素颜色（深浅主题都适配）
    'opacity:0.68',        // 视觉降权，和原文区分开
    'background:none',
    'border:0',
    'padding:0',
    'font-style:normal',
    // nowrap：译文永不内部断行。中文可在任意字符间断行，宽度受限的
    // flex 导航项里译文会被压成两字宽、竖排堆叠（下拉菜单竖条 bug）。
    'white-space:nowrap',
    // flex 导航项（.navbar-item 等）里译文是独立 flex item，默认
    // flex-shrink:1 会被压缩；禁止收缩才能保持横向完整宽度。
    'flex-shrink:0',
    // 超宽时按容器截断，不撑爆固定宽度的下拉菜单
    'max-width:100%',
  ].join(';');

  // 追加到元素内部（而不是作为兄弟节点），保持在同一行内流里
  para.blockEl.appendChild(el);
  para.targetWrapper = el;

  // 自适应回退：行内放不下时改为"副标题"块级行。
  // nowrap + max-width:100% 会把 span 盒子封顶在容器宽度，但长句文字会从
  // 盒子里横向溢出（scrollWidth > clientWidth），穿过卡片/菜单边界。
  // 此时改为块级：显示在原文下方、按容器宽度正常换行。
  // nav 段落数量有限（几十个量级），逐个测量不会造成布局抖动问题。
  if (el.scrollWidth > el.clientWidth + 1) {
    el.style.cssText = [
      'display:block',
      'margin-top:2px',
      'font-size:0.85em',
      'line-height:1.45',
      'color:inherit',
      'opacity:0.68',
      'background:none',
      'border:0',
      'padding:0',
      'font-style:normal',
      'white-space:normal',
      'word-break:break-word',
    ].join(';');
  }
}

/**
 * 段落翻译失败：不在页面 DOM 里插入错误文案。
 *  - 整页网络故障时红字会刷满页面，且错误文本会被重收集、被翻译成
 *    "翻译失败：获取失败"的回声行；
 *  - 原文保持原样即可，失败详情在 popup 调试面板查看。
 */
function renderError(para, error) {
  para.state = 'error';
  log.warn('段落翻译失败', para.id, error);
}

/** #rrggbb → rgba(r,g,b,a)，用于荧光笔半透明底色 */
function hexToRgba(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}

/** 每次 renderBatch 都会调一次，确保主题 CSS 变量已经注入 */
function applyThemeVars(themeName, themes, themeColor) {
  const rule = themes[themeName] || themes.none;
  const root = document.documentElement.style;
  const c = /^#[0-9a-f]{6}$/i.test(themeColor || '') ? themeColor : '';
  // 「颜色配置」作用于各装饰主题：荧光笔底色、下划线、引用块、卡片投影、毛玻璃
  let bg = rule.backgroundColor;
  let bb = rule.borderBottom;
  let bl = rule.borderLeft;
  let shadow = rule.boxShadow || 'none';
  let deco = rule.textDecoration || 'none';
  if (c) {
    if (themeName === 'marker') bg = hexToRgba(c, 0.6);
    else if (themeName === 'dashed') bb = `2px dashed ${c}`;
    else if (themeName === 'underline') bb = `2px solid ${c}`;
    else if (themeName === 'wavy') deco = `underline wavy ${c} 1.5px`;
    else if (themeName === 'blockquote') { bl = `4px solid ${c}`; bg = hexToRgba(c, 0.08); }
    else if (themeName === 'card') shadow = `0 1px 5px ${hexToRgba(c, 0.45)}`;
    else if (themeName === 'glass') {
      bl = `1px solid ${hexToRgba(c, 0.3)}`;
      bg = hexToRgba(c, 0.14);
      shadow = `0 1px 6px ${hexToRgba(c, 0.22)}`;
    }
  }
  root.setProperty('--tmt-theme-bg', bg);
  root.setProperty('--tmt-theme-bb', bb);
  root.setProperty('--tmt-theme-bl', bl);
  root.setProperty('--tmt-theme-pad', rule.padding);
  root.setProperty('--tmt-theme-radius', rule.borderRadius);
  root.setProperty('--tmt-theme-shadow', shadow);
  root.setProperty('--tmt-theme-indent', rule.textIndent || '0');
  root.setProperty('--tmt-theme-deco', deco);
  root.setProperty('--tmt-theme-filter', rule.backdropFilter || 'none');
}

let modeStyleInjected = false;

/**
 * 显示模式的可见性规则，只注入一次：
 *  - hover（悬停展开）：默认藏译文，鼠标悬停段落时在原文下方展开（纯 CSS，无需 JS）。
 *  - hoverTip（悬停浮层）：页面保持原文，译文只在气泡里展示，不插入正文。
 *  - click（点击展开）：默认藏译文，点击段落切换显示（类名 tmt-revealed）。
 */
function ensureModeStyle() {
  if (modeStyleInjected) return;
  modeStyleInjected = true;
  const W = `.${MARK.TARGET_WRAPPER}`;
  const P = `[${MARK.PARAGRAPH}]`;
  const style = document.createElement('style');
  style.id = 'tmt-mode-style';
  style.textContent = [
    // hover：段落悬停时在原位置展开译文（三种插入位置都要覆盖）
    `html[data-tmt-mode='hover'] ${W}{display:none!important}`,
    `html[data-tmt-mode='hover'] ${P}:hover + ${W},` +
    `html[data-tmt-mode='hover'] ${P}:hover ${W},` +
    `html[data-tmt-mode='hover'] ${W}:has(+ ${P}:hover){display:block!important}`,
    `html[data-tmt-mode='hover'] ${P}:hover + ${W}:not(.tmt-block-wrapper),` +
    `html[data-tmt-mode='hover'] ${P}:hover ${W}:not(.tmt-block-wrapper),` +
    `html[data-tmt-mode='hover'] ${W}:not(.tmt-block-wrapper):has(+ ${P}:hover){display:inline-block!important}`,

    // hoverTip：页面保持原文，译文只在浮层里展示（不插入正文、不改变布局）
    `html[data-tmt-mode='hoverTip'] ${W}{display:none!important}`,

    // click：点击段落展开/收起该段译文
    `html[data-tmt-mode='click'] ${W}{display:none!important}`,
    `html[data-tmt-mode='click'] ${W}.tmt-revealed{display:block!important}`,
    `html[data-tmt-mode='click'] ${W}.tmt-revealed:not(.tmt-block-wrapper){display:inline-block!important}`,
  ].join('\n');
  (document.head || document.documentElement).appendChild(style);
}

// ---- 模式交互（点击切换 / 悬停看原文） ------------------------------------
let interactionsInstalled = false;
let originalTip = null;

function wrapperClass() {
  return `.${MARK.TARGET_WRAPPER}`;
}

/** 找到某段落对应的译文壳（相邻 / 内部） */
function findWrapperOf(paragraphEl) {
  const next = paragraphEl.nextElementSibling;
  if (next?.classList?.contains(MARK.TARGET_WRAPPER)) return next;
  const prev = paragraphEl.previousElementSibling;
  if (prev?.classList?.contains(MARK.TARGET_WRAPPER)) return prev;
  return paragraphEl.querySelector?.(wrapperClass()) || null;
}

function ensureOriginalTip() {
  if (originalTip?.isConnected) return originalTip;
  originalTip = document.createElement('div');
  originalTip.className = 'tmt-original-tip';
  originalTip.setAttribute('translate', 'no');
  originalTip.style.cssText = [
    'position:fixed', 'z-index:2147483647', 'max-width:440px',
    'padding:8px 10px', 'border-radius:6px', 'background:#fff', 'color:#1f2328',
    'font-size:13px', 'line-height:1.5', 'box-shadow:0 4px 16px rgba(0,0,0,0.18)',
    'pointer-events:none', 'display:none',
  ].join(';');
  document.body.appendChild(originalTip);
  return originalTip;
}

/** 在指定锚点上方浮出提示气泡（原文/译文共用） */
function showTip(anchorEl, text) {
  const content = String(text || '').trim();
  if (!content) return;
  const tip = ensureOriginalTip();
  tip.textContent = content;
  tip.style.display = 'block';
  const r = anchorEl.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - 460);
  tip.style.left = `${Math.max(8, Math.min(r.left, maxLeft))}px`;
  tip.style.top = `${Math.max(8, r.top - tip.offsetHeight - 6)}px`;
}

/** 悬停浮层模式：页面保持原文，悬停段落时浮出该段译文 */
function showTranslationTip(paragraphEl) {
  const wrapperEl = findWrapperOf(paragraphEl);
  showTip(paragraphEl, wrapperEl?.textContent);
}

/** 原处替换 + 悬停看原文：原文已被替换，从渲染时保存的整段原文里取 */
function showReplacedOriginalTip(paragraphEl) {
  showTip(paragraphEl, paragraphEl.__tmtOrigText);
}

function hideOriginalTip() {
  if (originalTip) originalTip.style.display = 'none';
}

/**
 * 安装模式交互（幂等，只会装一次）：
 *  - click：点击段落展开/收起该段译文
 *  - hoverTip：悬停段落浮出译文气泡
 *  - replaceHover：原处替换后，悬停段落浮出被替换的原文
 */
export function installModeInteractions() {
  if (interactionsInstalled) return;
  interactionsInstalled = true;

  document.addEventListener('click', (e) => {
    if (document.documentElement.getAttribute('data-tmt-mode') !== 'click') return;
    const paragraphEl = e.target.closest?.(`[${MARK.PARAGRAPH}]`);
    if (!paragraphEl) return;
    findWrapperOf(paragraphEl)?.classList.toggle('tmt-revealed');
  }, true);

  document.addEventListener('mouseover', (e) => {
    const mode = document.documentElement.getAttribute('data-tmt-mode');

    // 悬停浮层：悬停原文浮出译文
    if (mode === 'hoverTip') {
      const paragraphEl = e.target.closest?.(`[${MARK.PARAGRAPH}]`);
      if (paragraphEl) showTranslationTip(paragraphEl);
      return;
    }
    // 原处替换 + 悬停看原文：悬停替换后的段落，浮出被替换掉的原文
    if (mode === 'replaceHover') {
      const paragraphEl = e.target.closest?.(`[${MARK.PARAGRAPH}]`);
      if (paragraphEl) showReplacedOriginalTip(paragraphEl);
    }
  });

  document.addEventListener('mouseout', (e) => {
    const mode = document.documentElement.getAttribute('data-tmt-mode');
    if (mode !== 'hoverTip' && mode !== 'replaceHover') return;
    if (e.target.closest?.(`[${MARK.PARAGRAPH}]`)) hideOriginalTip();
  });
}

/**
 * 应用主题到整个文档上现有的 wrapper（切主题时用）。
 * wrapper 的装饰全部引用 CSS 变量，所以只更新变量即可，无需遍历 DOM。
 */
export function applyThemeToExisting(themeName, themes, themeColor) {
  applyThemeVars(themeName, themes, themeColor);
}
