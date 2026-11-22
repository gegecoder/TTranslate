/**
 * ============================================================================
 * utils.mjs —— 杂项工具函数
 * ============================================================================
 * 散落在各处的小工具集中在这里，保持其他模块聚焦核心逻辑。
 * ============================================================================
 */

/**
 * 简易 MD5（FNV-1a 的 32 位变体 + 字符串哈希），用作翻译缓存 key。
 * 自实现避免引入外部依赖，碰撞概率在小规模数据场景可接受；大规模数据场景建议换 xxhash。
 */
export function hashKey(str) {
  let h1 = 0xdeadbeef ^ 0, h2 = 0x41c6ce57 ^ 0;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h2 = Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  return (Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 16), 3266489909))
    .toString(16);
}

/** 判断一段文本看起来像 CJK（中文/日文/韩文）——决定用字符数还是词数做长度阈值 */
export function looksCJK(text) {
  // CJK 统一表意符号 + 假名 + 谚文
  return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/.test(text);
}

/**
 * 判断文本是否可译——剥掉 URL/邮箱/#话题/@提及/纯数字后剩下的有效内容够不够。
 */
export function isTranslatable(text, opts = {}) {
  const { minChar = 5, minWord = 2 } = opts;

  // 先剥掉不该翻译的东西（URL / 邮箱 / #话题 / @提及）
  const cleaned = text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\S+@\S+/g, '')
    .replace(/(^|\s)[#@]\w+/g, '');

  // 只保留"有意义的字符"（字母、数字、CJK）来做长度判断。
  // ★ 注意：删空格只能用于长度判断，不能用来断词——
  // 之前把空格一起删掉再 split(/\s+/)，英文永远只有 1 个"词"，
  // 导致所有英文段落都被 minWord 判为不可译（页面毫无反应）。
  const meaningful = cleaned.replace(/[^\p{L}\p{N}]/gu, '');
  if (!meaningful) return false;

  if (looksCJK(cleaned)) {
    return meaningful.length >= minChar;
  }

  // 英文在保留空格的原串上断词
  const words = cleaned.split(/\s+/).filter(w => /\p{L}/u.test(w));
  return words.length >= minWord && meaningful.length >= minChar;
}

/** URL 匹配：把 chrome 扩展的 glob 模式转正则（简化版） */
export function matchesUrl(url, patterns) {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some(p => {
    const regexStr = '^' + p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*') + '$';
    return new RegExp(regexStr).test(url);
  });
}

/** 给 promise 加超时——后台 fetch 代理和 iframe postMessage 都会用到 */
export function withTimeout(promise, ms, label = 'op') {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    promise.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

/** 日志统一由 constants.mjs 提供（生产模式下自动静默） */
export { log } from './constants.mjs';

/** display 值缓存：收集阶段同一元素的 computed display 不会变，避免重复触发样式重算 */
const displayCache = new WeakMap();

/**
 * 获取元素 display 值，走 WeakMap 缓存避免重复 getComputedStyle 触发同步布局。
 * walker.mjs 的 isBlockElement、utils.mjs 的 getBlockAncestor、isAnchorIndependent
 * 都统一走这个入口，三处共享同一份缓存。
 */
export function getCachedDisplay(el) {
  let d = displayCache.get(el);
  if (d === undefined) {
    try { d = getComputedStyle(el).display; } catch { d = 'inline'; }
    displayCache.set(el, d);
  }
  return d;
}

/**
 * 语义块级标签：即使 computed display 是 inline-block
 * （button 默认 inline-block，<li> 也常被写成 inline-block），
 * 它们仍然应该作为段落分组的根。
 * walker.mjs 的 BLOCK_TAGS 从此处导出，两处保持同一份权威定义。
 */
export const BLOCK_TAGS = new Set([
  'P', 'LI', 'DT', 'DD', 'TD', 'TH', 'BUTTON', 'BLOCKQUOTE',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'ADDRESS',
]);

/** 把 display 视为块级的 A 标签（nav/flex 菜单里的 inline-block / block / flex / grid） */
function isAnchorIndependent(a) {
  if (a.tagName !== 'A') return false;
  try {
    return getCachedDisplay(a) !== 'inline';
  } catch { return false; }
}

/**
 * 获取元素相对于 container 的「块级祖先」——用于段落根。
 *
 * 两段式判断：
 *  1) 语义块级标签（button 默认 inline-block / h1~h6 / li / dt / dd ...）
 *     → 直接返回自身，作为段落根
 *  2) <A> 且 display !== inline（导航菜单 / 工具栏操作链接等 inline-block / block / flex / grid）
 *     → 也返回自身，防止多个相邻链接被合并成一段
 *  3) 其他：按 computed display 往上爬升，inline/inline-block/inline-flex/none 跳过
 *
 * 背景：旧版只看 display 会把 lemmaBtn + siteBtn + intlBtn + helpBtn 全部爬到同一个 block 祖先、合并成一段，
 * 译文串写导致后三个按钮被清空（fixedWrapper 滚动条同样受影响）。
 */
export function getBlockAncestor(el, container) {
  let cur = el;
  while (cur && cur !== container) {
    if (cur.nodeType === 1) {
      if (BLOCK_TAGS.has(cur.tagName)) return cur;
      if (isAnchorIndependent(cur)) return cur;

      const d = getCachedDisplay(cur);
      if (d !== 'inline' && d !== 'inline-block' && d !== 'inline-flex' && d !== 'none') {
        return cur;
      }
    }
    cur = cur.parentNode;
  }
  return container;
}

/** 防抖工具——MutationObserver 回调、URL 变化检测都用得到 */
export function debounce(fn, waitMs) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(null, args), waitMs);
  };
}
