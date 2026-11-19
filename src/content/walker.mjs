/**
 * ============================================================================
 * content/walker.mjs —— DOM 遍历与段落收集
 * ============================================================================
 * 哪些文本节点要译、哪些跳过、
 * 怎么把文本节点组合成段落（段落是翻译请求的基本单位）。
 * ============================================================================
 */

import { MARK, log } from '../shared/constants.mjs';
import { BLOCK_TAGS, getBlockAncestor, isTranslatable, looksCJK } from '../shared/utils.mjs';

/**
 * BLOCK_TAGS 的权威定义已迁移到 utils.mjs，这里直接复用。
 * 注释保留在此（两处语义块级标签的一致说明）：
 * 无论 CSS display 是什么，都当作"段落边界"的标签。
 * 典型场景：导航菜单用 `li { display: inline-block }`，
 * 如果只看 display，整排菜单会被合并成一个巨大段落，
 * 或者干脆因为被当成行内而无法单独成段——表现为"菜单项没被翻译"。
 */

/** 导航类容器：这些区域里的短文本（单词/两三字符）也应该翻译 */
const NAV_LIKE = 'a, li, dt, dd, nav, header, footer, button, aside, h1, h2, h3, h4, h5, h6';

/**
 * 导航/侧栏/面包屑区域：渲染译文时要用"紧凑内联"样式，
 * 而不是块级译文卡片——否则会把导航栏撑高、把面包屑挤乱。
 * 在顶部工具栏（topbar/searchbar/pageHeader）里的段落也统一按导航紧凑样式处理，
 * 避免按钮/操作链接被撑出块级卡片导致顶部布局错乱。
 */
const NAV_SCOPE = [
  'nav', 'header', 'footer', 'aside',
  '[role="navigation"]',
  '[aria-label*="readcrumb" i]', '[class*="breadcrumb" i]',
  '[class*="sidebar" i]', '[class*="menu" i]', '[class*="toc" i]',
  '[class*="nav" i]', '[class*="navbar" i]',
  '[class*="topbar" i]', '[class*="top-bar" i]',
  '[class*="searchbar" i]', '[class*="search-bar" i]',
  '[class*="page-header" i]', '[class*="pageHeader" i]',
].join(',');

const blockIds = new WeakMap();
let nextBlockId = 1;

/**
 * 生成段落 ID。
 * ★ 必须对同一个块元素稳定 —— 不能用自增计数器，
 * 否则 MutationObserver 每次重扫都会生成新 ID，导致"内容没变也重新翻译"，
 * 甚至和渲染互相触发形成死循环。
 * 这里用 blockEl 的 WeakMap 序号做稳定前缀；文本变化由 engine 侧比较 text 判断。
 */
function makeParaId(blockEl) {
  let bid = blockIds.get(blockEl);
  if (!bid) {
    bid = nextBlockId++;
    blockIds.set(blockEl, bid);
  }
  return `p${bid}`;
}

/**
 * 把选择器字符串数组编译成 Set 做快速命中直接用 el.matches
 */
function compileMatchers(selectors) {
  return selectors?.length ? selectors.filter(Boolean) : [];
}

/** 组合选择器缓存：同一个 selectors 数组只拼一次（collect 阶段每个文本节点都会用到） */
const combinedCache = new WeakMap();

/** 把选择器数组用逗号合并成一个组合选择器（带缓存），空数组返回空串 */
function combineSelectors(selectors) {
  let combined = combinedCache.get(selectors);
  if (combined === undefined) {
    combined = selectors.filter(Boolean).join(',');
    combinedCache.set(selectors, combined);
  }
  return combined;
}

/** 判断元素是否命中选择器列表（包含自身和祖先链，直到容器） */
function matchesAny(el, selectors, container) {
  if (!selectors.length) return false;
  // 优化：一次 closest（自身 + 全部祖先链）替代"每个祖先 × 每个选择器"的逐次 matches
  try {
    const combined = combineSelectors(selectors);
    if (!combined) return false;
    const hit = el.closest(combined);
    // 保持原语义：判断范围到 container 为止（不含 container 自身及其外层）
    return !!hit && (!container || (hit !== container && container.contains(hit)));
  } catch {
    // 组合选择器含伪类/组合器等导致 invalid selector → 回退到逐层逐选择器判断
  }
  let cur = el;
  while (cur && cur !== container && cur.nodeType === 1) {
    for (const sel of selectors) {
      try { if (cur.matches(sel)) return true; } catch { /* 忽略无效选择器 */ }
    }
    cur = cur.parentNode;
  }
  return false;
}

/**
 * 判断一个元素是"块级"还是"行内"——决定它的文本节点要跟兄弟合并成段，还是各自独立。
 */
function isBlockElement(el, rule) {
  // 显式 atomic block → 整体不拆分（代码块、SVG、textarea）
  if (matchesAny(el, compileMatchers(rule.atomicBlockTags?.map(t => t)), null)) return true;
  // 显式块级（从 selectors 里挑出来的）
  if (matchesAny(el, compileMatchers(rule.selectors), null)) return true;
  // 语义块级标签优先（见 BLOCK_TAGS 注释：inline-block 的 li 也要独立成段）
  if (BLOCK_TAGS.has(el.tagName)) return true;

  // 菜单常见写法：<div style="display:flex"><a>news</a><a>about</a></div>
  // 这种 <a> 是行内元素，不特殊处理就会把整排菜单合并成一段。
  if (el.tagName === 'A') {
    const parent = el.parentElement;
    if (parent) {
      if (['NAV', 'UL', 'OL'].includes(parent.tagName)) return true;
      const pd = getComputedStyle(parent).display;
      if (pd.includes('flex') || pd.includes('grid')) return true;
    }
    // 自身 display 非 inline（inline-block / inline-flex / block / flex / grid）
    // 也视为独立块：搜索栏/工具栏里的操作链接常被写成 inline-block，
    // 多个相邻 <a> 会共享父级块祖先被合并成一段，导致翻译后兄弟元素互相污染
    // （百度百科顶部 intlBtn + helpBtn 被串译成一个 <a>）。
    // 正文里默认 inline 的 <a>（如《论语·阳货》里的书名号链接）仍和周围文本合并，
    // 保持句级翻译连贯。
    const selfD = getComputedStyle(el).display;
    if (selfD !== 'inline') return true;
  }
  const cs = getComputedStyle(el);
  const d = cs.display;
  if (d === 'none') return false;
  // inline / inline-block / inline-flex / inline-table 都算行内
  if (/^inline|^table/.test(d) && d !== 'inline-block' && d !== 'inline-flex') return false;
  if (d === 'inline-block' || d === 'inline-flex') return false;
  // br 也是"内联但要开新段落"的特例
  if (el.tagName === 'BR') return false;
  return true;
}

/**
 * 主函数：从 container（默认 body）里收集所有要翻译的段落。
 * 返回 Map<paraId, { id, blockEl, nodes, text, isBlock }>
 *   1. 建 TreeWalker（SHOW_TEXT 只看文本节点）
 *   2. 跳过那些父元素命中 excludeSelectors / stayOriginalSelectors 的
 *   3. 按"块级祖先"把文本节点归成段落
 *   4. 合并段落文本（行内节点之间的空白归一）
 *   5. 跑可译性校验（URL/邮箱/数字剥离 + 长度阈值）
 */
export function collectParagraphs(container, rule) {
  const paras = new Map();
  if (!container) return paras;

  const excludeSel = compileMatchers(rule.excludeSelectors);
  const staySel = compileMatchers(rule.stayOriginalSelectors);
  const inlineTags = new Set(rule.inlineTags || []);

  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    {
      /**
       * 给 TreeWalker 的每个元素做过滤：命中 exclude 拒绝深入子树，
       * 元素自身被拒就跳过它的子节点。文本节点则交给 acceptNode 判断。
       */
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) {
          // 原处替换模式改写过的文本节点（内容已是译文）：跳过收集，
          // 否则重收集会把中文译文当新原文，造成回环翻译
          if (node.__tmtReplaced) return NodeFilter.FILTER_REJECT;
          // 直接父元素是 script/style 等
          if (!node.parentNode) return NodeFilter.FILTER_REJECT;
          const parent = node.parentNode;
          if (parent.nodeType !== 1) return NodeFilter.FILTER_REJECT;
          // 本扩展注入的译文壳 / 错误壳内的文本不收集：
          // 否则 SPA 重扫会把译文甚至错误文案当新原文再翻译，
          // 产生"翻译失败：获取失败"这类回声行
          if (parent.closest?.('.' + MARK.TARGET_WRAPPER)) return NodeFilter.FILTER_REJECT;
          if (matchesAny(parent, excludeSel, container)) return NodeFilter.FILTER_REJECT;
          if (matchesAny(parent, staySel, container)) return NodeFilter.FILTER_REJECT;
          const text = node.textContent;
          if (!text || !text.trim()) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          if (matchesAny(node, excludeSel, container)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
        return NodeFilter.FILTER_REJECT;
      },
    },
  );

  // 把 TreeWalker 给出的所有文本节点按"块级祖先"分组——
  // 同一个块级祖先下的所有文本节点合并成一个段落。
  const groups = new Map();  // blockEl → textNode[]
  // 被跳过的文本样本，用于排查"为什么这段没翻译"
  const skipped = [];
  let node;
  while ((node = walker.nextNode())) {
    const block = getBlockAncestor(node, container);
    if (!groups.has(block)) groups.set(block, []);
    groups.get(block).push(node);
  }

  // 对每组：合并文本 → 判定可译 → 构造段落
  for (const [blockEl, textNodes] of groups) {
    // 用 JS 属性标访问过的节点，减少 dataset 污染
    // 不过 dataset 也打一个，MutationObserver 需要
    textNodes.forEach(n => { n.parentNode?.setAttribute?.(MARK.WALKED, '1'); });

    // 合并文本，行内节点之间保留单一空格，块级之间保留换行
    const text = textNodes
      .map((n, i) => {
        let t = n.textContent || '';
        // 去掉首尾空白
        t = t.replace(/^\s+|\s+$/g, '');
        if (!t) return '';
        // 如果是块级祖先的开头/结尾（相对于其他块），前后加换行
        return t;
      })
      .filter(Boolean)
      .join('\n');

    if (!text) continue;

    // 导航/侧栏里的短文本（news、about、FAQ、TLS/SSL）也要翻译，
    // 否则会出现"正文译了、菜单全是英文"的割裂感。
    const navLike = blockEl.closest?.(NAV_LIKE);
    const minChar = navLike ? 2 : (rule.paragraphMinTextCount || 5);
    const minWord = navLike ? 1 : (rule.paragraphMinWordCount || 2);

    // 可译性校验
    if (!isTranslatable(text, { minChar, minWord })) {
      skipped.push(text.replace(/\s+/g, ' ').slice(0, 40));
      continue;
    }

    const isBlock = isBlockElement(blockEl, rule);
    const id = makeParaId(blockEl);

    // 是否位于导航/侧栏/面包屑：决定渲染时用"紧凑内联"还是"块级卡片"
    const isNav = !!blockEl.closest?.(NAV_SCOPE);

    paras.set(id, {
      id,
      blockEl,           // 块级容器元素
      nodes: textNodes,  // 原文本节点数组
      text,              // 合并后的文本
      isBlock,           // 块/行内
      isNav,             // 导航区域（紧凑渲染）
      state: 'pending',  // pending → queued → translating → done → error
      targetWrapper: null, // 渲染后引用译文包装层
    });
  }

  if (skipped.length > 0) {
    log.info(`walker: 跳过 ${skipped.length} 段（过短/纯符号/非文本），样本：`, skipped.slice(0, 8));
  }

  return paras;
}
