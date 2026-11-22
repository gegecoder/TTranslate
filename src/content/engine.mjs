/**
 * ============================================================================
 * content/engine.mjs —— 翻译引擎主入口
 * ============================================================================
 * runEngine() 是整个引擎的 bootstrap。拆成可独立测试的小函数：
 *   loadConfig()      读合并后的用户配置
 *   detectContainer() 找翻译起点（默认 body）
 *   collectParas()    TreeWalker 遍历 + 段落收集 + 可译性过滤
 *   queue.translate() 排队送进 pipeline（批合并 → 并发请求 → 渲染）
 *
 * 其他模块（walker / pipeline / render / observer）只暴露单一职责的函数，由 engine 串起来。
 * ============================================================================
 */

import { MSG, MARK, STORAGE_KEY, DEFAULT_CONFIG, MODE_CYCLE, PROTECT_TERMS, parseTerms, protectTermsIn, restoreTermsIn, log } from '../shared/constants.mjs';
import { hashKey } from '../shared/utils.mjs';
import { collectParagraphs } from './walker.mjs';
import { Pipeline } from './pipeline.mjs';
import { TranslationCache } from './cache.mjs';
import { renderBatch, applyThemeToExisting, clearSideBySide, installModeInteractions, applyTranslationStyleToExisting, applyPositionToExisting } from './render.mjs';
import { installObserver } from './observer.mjs';
import { installSelection, relocalizeOverlay } from './overlay.mjs';
import { setUiLang, resolveUiLang, t } from '../shared/i18n.mjs';

// ---- 引擎全局状态 --------------------------------------------------------
const state = {
  config: null,           // 当前生效的配置
  enabled: true,          // 配置里的"自动翻译"开关
  translated: false,      // 当前页面是否已经显示译文（手动按钮的依据）
  mode: 'dual',           // 当前显示模式（dual/sideBySide/sentence/hover/...）
  paragraphs: new Map(),  // paraId → { id, nodes[], text, state, translations[] }
  pipeline: null,         // 请求管线
  cache: null,            // 翻译缓存（L1 内存 + L2 storage）
  observer: null,         // MutationObserver
  // 翻译进度：popup 轮询用（total=入队段落数，done=已渲染段落数）
  progress: { total: 0, done: 0, translating: false, empty: false },

  // 是否正在批量入队（此期间不要判定"翻译结束"）
  enqueueing: false,

  // 收集代次：每次整页收集自增。语言切换会重开一代，
  // 上一代在途请求返回的结果按代次过滤，避免旧语言译文插回页面。
  gen: 0,
};

// 引擎就绪信号：消息处理器会 await 它，避免"消息先到、配置还没加载完"
let markReady;
const readyPromise = new Promise(resolve => { markReady = resolve; });

/** 引擎主入口——由 guard.js 动态 import 后调用 */
export async function runEngine() {
  log.info('engine booting');

  // ★ 关键：先注册消息监听，再加载配置。
  // 否则 popup 在配置加载完成前点按钮会收到 "Receiving end does not exist"，
  // 用户看到的就是"点击没反应"。
  installMessageHandlers();

  // 页面运行时错误（含未处理的 Promise 拒绝）写入调试日志，
  // popup 的调试面板能直接看到页面脚本报错，不用再开 devtools。
  installErrorCapture();

  try {
    // 1) 读配置
    state.config = await loadConfig();
    state.enabled = state.config.enabled;
    state.mode = state.config.translationMode;

    // 旧版本已移除的模式（仅译文 / 仅原文）回退到双语对照
    if (['translation', 'translationHover', 'original'].includes(state.mode)) state.mode = 'dual';
    // 旧版荧光笔主题合并为单一「荧光笔」，颜色由 markerColor 控制
    if (['markerGreen', 'markerPink'].includes(state.config.theme)) state.config.theme = 'marker';
    // 被"按段落忽略"的段落哈希（Alt+点击段落可加入/取消）
    state.ignored = new Set(state.config.ignoreParagraphs?.[location.hostname] || []);
    // 界面语言：作用于划词浮层、页面内错误提示等可见文案
    setUiLang(resolveUiLang(state.config.uiLanguage));
    log.info('config loaded', {
      service: state.config.service,
      enabled: state.config.enabled,
      from: state.config.sourceLanguage,
      to: state.config.targetLanguage,
      mode: state.config.translationMode,
    });

    // 2) 初始化缓存 + 管线（批合并 + 并发 + 缓存）
    state.cache = new TranslationCache();

    // 页面隐藏/关闭时立刻落盘，避免最后一批译文还没等到防抖就丢失
    window.addEventListener('pagehide', () => {
      state.cache.flush().catch(() => { /* 忽略 */ });
    });

    // 缓存键 = 服务 + 源语言 + 目标语言 + 文本 hash
    // ★ 必须带上语言：否则用户把目标语言从中文改成日文时，会命中旧的中文译文，表现为"切换语言后没变化"。
    const cacheKey = (text) => {
      const { service, sourceLanguage, targetLanguage } = state.config;
      return `${service}|${sourceLanguage}->${targetLanguage}|${hashKey(text)}`;
    };

    state.pipeline = new Pipeline({
      cacheKey,
      async fetchBatch(ids, texts) {
        const from = state.config.sourceLanguage;
        const to = state.config.targetLanguage;
        const service = state.config.service;

        // 术语保护：品牌/专有名词先换占位符，避免 Spring → 春季、Chrome → 铬
        const protect = state.config.protectTerms !== false;
        // 用户在设置里维护的关键词优先；留空时回退到内置「计算机通用」模板
        const customTerms = parseTerms(state.config.protectTermsList);
        const terms = customTerms.length ? customTerms : PROTECT_TERMS;
        const termSlots = [];
        const payload = protect
          ? texts.map((t) => {
              const r = protectTermsIn(t, terms);
              termSlots.push(r.terms);
              return r.text;
            })
          : texts;

        const { results } = await chrome.runtime.sendMessage({
          method: MSG.TRANSLATE_BATCH,
          data: { service, from, to, texts: payload },
        });

        if (protect && Array.isArray(results)) {
          for (let i = 0; i < results.length; i++) {
            if (results[i]?.translation) {
              results[i].translation = restoreTermsIn(results[i].translation, termSlots[i]);
            }
          }
        }
        return results;
      },
      // 缓存直接读写 chrome.storage.local（L1 内存 + 批量落盘，见 cache.mjs），
      // 不再逐条走消息往返——79 段只要 1 次载入、1~2 次写回。
      readCache: (keys) => state.cache.getMany(keys),
      writeCache: (entries /* Map */) => {
        state.cache.setMany(entries);
        return Promise.resolve();
      },
      intervalMs: state.config.services[state.config.service]?.intervalMs || 300,
      concurrency: state.config.services[state.config.service]?.concurrency || 5,
      maxBatchSize: state.config.services[state.config.service]?.maxBatchSize || 20,
    });

    // 3) 给 DOM 上打一个根级属性，方便调试时确认引擎已加载
    document.documentElement.setAttribute('data-tmt-root', 'true');
    const container = document.body || document.documentElement;

    // 4) 翻译第一波（异步，不阻塞）
    if (state.enabled) {
      const start = () => kickOffTranslation(container).catch(err => log.warn('kickOffTranslation failed', err));
      // SSR / React 页面（spring.io 等）在 DOMContentLoaded 后仍在水合，
      // 提前插入译文会触发 hydration mismatch（React #418）。
      // 等到 window load 再起播，最多等 3s 兜底；手动点翻译不受此限制。
      if (document.readyState === 'complete') {
        start();
      } else {
        const timer = setTimeout(start, 3000);
        window.addEventListener('load', () => { clearTimeout(timer); start(); }, { once: true });
      }
    }

    // 5) MutationObserver 监听后续内容变化
    state.observer = installObserver(container, onMutations);

    // 6) 划词翻译 + 输入框翻译（overlay.mjs）
    installSelection({
      enabled: state.config.selection?.enabled,
      showMode: state.config.selection?.showMode,
      dict: state.config.dict,
      theme: state.config.popupTheme,
      themeImage: state.config.popupThemeImage || '',
      themeAlpha: state.config.popupThemeOpacity,
      themeImageAlpha: state.config.popupThemeImageOpacity,
      themeTextColor: state.config.popupThemeTextColor,
    });

    // 6.5) 显示模式交互（点击展开 / 悬停看原文）与快捷键轮转
    installModeInteractions();
    installShortcut();
    installParagraphIgnore();

    // 7) 通知背景：引擎已就绪
    chrome.runtime.sendMessage({ method: MSG.REPORT, data: { event: 'page_ready' } });
  } catch (err) {
    log.error('engine bootstrap 失败', err);
  } finally {
    markReady(true);
  }
}

/** 读配置：先读 background 拿合并后的版本（含默认值补齐） */
async function loadConfig() {
  try {
    const resp = await chrome.runtime.sendMessage({ method: MSG.GET_CONFIG });
    if (resp?.ok && resp.config) return resp.config;
  } catch { /* 回退到 storage 直接读 */ }
  try {
    const { fullLocalUserConfig } = await chrome.storage.local.get(STORAGE_KEY.CONFIG);
    if (fullLocalUserConfig) return fullLocalUserConfig;
  } catch { /* ignore */ }
  // ★ 兜底：即使后台没起来、storage 也是空的，也不能让 config 为 null，
  // 否则后续 state.config.rule 会直接抛错，表现为"点击毫无反应"。
  log.warn('读取配置失败，使用默认配置');
  return structuredClone(DEFAULT_CONFIG);
}

/**
 * 第一波翻译：收集 + 排队。
 * domready 竞速——guard 在 document_start 就 import 引擎，此时 body 可能还没出现（异步框架 SPA 更可能是纯 html 壳）。
 * 等 DOM 就绪的策略（比 500ms 盲等稳健）：
 *   1) body 存在且正文有文本 → 立即开跑
 *   2) 否则 waitForBodyContent：MutationObserver 监听 document.documentElement，
 *      只要 body 出现且非空就 resolve；最多等 5s，超时也放行。
 */
async function kickOffTranslation(container) {
  if (!container || !hasContentToTranslate(container)) {
    log.info('kickOffTranslation: 正文尚未就绪，等待...');
    container = await waitForBodyContent(5000);
  }
  if (!container) {
    log.warn('kickOffTranslation: 等了 5s 还没内容，放弃首轮');
    state.progress.translating = false;
    return;
  }

  const paras = collectParagraphs(container, state.config.rule);
  // 开启新一代收集：此前的在途请求结果已过期（例如切换了目标语言）
  const gen = ++state.gen;
  for (const para of paras.values()) para.gen = gen;
  // 按段落忽略：命中忽略哈希的段落直接剔除，不计入进度
  if (state.ignored?.size) {
    for (const [id, para] of [...paras]) {
      if (state.ignored.has(paragraphKey(para.text))) paras.delete(id);
    }
  }
  state.paragraphs = paras;
  log.info(`collected ${paras.size} paragraphs (service=${state.config.service} → ${state.config.targetLanguage})`);

  if (paras.size === 0) {
    log.warn('没有收集到任何可译段落——可能页面结构特殊，排除了太多，或引擎时机太早');
    state.progress.translating = false;
    state.progress.empty = true;   // 让 popup 明确提示"未找到可译内容"
    return;
  }

  // ★ 必须先设置回调，再入队。
  // 因为 enqueue 命中缓存时会同步调用 onBatchComplete，晚设会丢结果。
  state.pipeline.onBatchComplete = (rawResults) => {
    // 过滤上一代的结果（切语言/重开收集后，旧语言的译文不能插回页面）
    const results = rawResults.filter(r => r.para?.gen === state.gen);
    state.progress.done += results.length;
    if (results.length) {
      log.info(`pipeline flush: ${results.length} results (${state.progress.done}/${state.progress.total})`);
      renderBatch(results, state);
    }

    // ★ 完成判据用"管线是否空闲"，而不是 done >= total。
    // 只看计数的话，去重/缓存等路径会让 done 永远差几条，
    // 表现为进度卡在 75/79、按钮一直停在"翻译中"。
    if (!state.enqueueing && state.pipeline.isIdle()) {
      if (state.progress.done < state.progress.total) {
        log.warn(`提前结束：${state.progress.done}/${state.progress.total}（部分段落被跳过或合并）`);
      }
      state.progress.translating = false;
      log.info(`翻译结束：${state.progress.done}/${state.progress.total} 段，${state.cache?.summary()}`);
    }
  };

  // 重置进度：每次主动触发翻译都从 0 开始
  state.progress.total = paras.size;
  state.progress.done = 0;
  state.progress.translating = true;

  state.enqueueing = true;
  for (const para of paras.values()) {
    state.pipeline.enqueue(para);
  }
  state.enqueueing = false;

  state.translated = true;
  // 整页入队完成：连续排空队列，批间不再等 intervalMs，缩短大页面翻译总时长
  state.pipeline.drain();

  // 兜底看门狗：每秒检查一次，只要管线空闲就收掉"翻译中"，
  // 避免任何异常路径让按钮永远卡在进度上。
  const watchdog = setInterval(() => {
    if (!state.progress.translating) { clearInterval(watchdog); return; }
    if (!state.enqueueing && state.pipeline.isIdle()) {
      state.progress.translating = false;
      clearInterval(watchdog);
      log.info(`看门狗收尾：${state.progress.done}/${state.progress.total}`);
    }
  }, 1000);
}

/**
 * 计算容器可译文本总长度——用 textContent 而非 innerText，
 * innerText 会强制同步布局（layout thrashing），textContent 只扫 DOM 节点。
 * 过滤掉 script/style/link 等非展示元素。
 */
function getContentLen(container) {
  if (!container) return 0;
  const TEXT_NODES = ['script', 'style', 'link', 'meta', 'title', 'template', 'noscript'];
  let len = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentNode;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.nodeName;
      if (TEXT_NODES.includes(tag)) return NodeFilter.FILTER_REJECT;
      // 跳过 display:none 的元素？这里不做——会强制布局。
      // 少量隐藏节点文本被计入没关系，只用来判断"有没有足够内容"。
      const t = (node.nodeValue || '').trim();
      if (!t) return NodeFilter.FILTER_REJECT;
      len += t.length;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (walker.nextNode()) { /* len 已在 acceptNode 里累加 */ }
  return len;
}

/** 判断容器里有没有"值得翻译的内容"——简单看文本节点总长度 */
function hasContentToTranslate(container) {
  if (!container || !document.body) return false;
  return getContentLen(document.body) > 200;
}

/**
 * 等 body 有内容。用 MutationObserver 轮询 documentElement，
 * 一看到 body 出现且有足够文本就 resolve。超时用 setTimeout。
 */
function waitForBodyContent(timeoutMs) {
  return new Promise(resolve => {
    const deadline = Date.now() + timeoutMs;

    const checkAndResolve = () => {
      const body = document.body;
      if (body && getContentLen(body) > 200) {
        resolve(body);
        return true;
      }
      return false;
    };

    if (checkAndResolve()) return;

    const io = new MutationObserver(() => {
      if (checkAndResolve()) { io.disconnect(); clearTimeout(timer); }
    });
    io.observe(document.documentElement, { childList: true, subtree: true });

    const timer = setTimeout(() => {
      io.disconnect();
      // 超时了——有 body 就用 body，否则 documentElement
      resolve(document.body || document.documentElement);
    }, timeoutMs);
  });
}

/** MutationObserver 回调：对变更节点重新收集并排队 */
function onMutations(nodes) {
  // 只有"当前页面处于译文状态"才继续翻译新内容。
  // 用户手动恢复原文后，MutationObserver 不应该再把译文加回来。
  if (!state.translated) return;
  log.debug(`observer saw ${nodes.length} changed nodes`);
  // 重新走一遍 collectParagraphs
  const container = document.body || document.documentElement;
  const fresh = collectParagraphs(container, state.config.rule);
  let enqueued = 0;
  for (const [id, para] of fresh) {
    const old = state.paragraphs.get(id);
    // 段落 id 稳定绑定 DOM 元素；只有文本真的变了才重新翻译
    if (!old || old.text !== para.text) {
      // 文本变了：旧译文层已失效，先移除，避免重复堆叠
      old?.targetWrapper?.remove();
      para.gen = state.gen;
      state.paragraphs.set(id, para);
      state.pipeline.enqueue(para);
      enqueued++;
    }
  }
  if (enqueued > 0) {
    state.progress.total += enqueued;
    state.progress.translating = true;
  }
  state.pipeline.flush();
}

/**
 * 捕获页面运行时错误，写入调试日志环形缓冲。
 * 调试面板通过 GET_LOGS 就能看到页面脚本的报错，无需打开 devtools。
 * 只记录、不拦截：不调用 preventDefault，不影响页面自身错误处理。
 */
function installErrorCapture() {
  window.addEventListener('error', (e) => {
    const where = e.filename ? `${e.filename}:${e.lineno || 0}:${e.colno || 0}` : '';
    log.error('[page error]', e.message || String(e.error || '未知错误'), where);
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    log.error('[page unhandledrejection]', r?.message || String(r));
  });
}

/**
 * 模式切换气泡：屏幕上方居中短暂显示当前模式名称。
 * 快捷键切换时用户看不到 popup，需要即时反馈"现在是什么模式"。
 * 复用单个节点，重复切换只更新时间与文字，不会叠加多个气泡。
 */
function showModeToast(mode) {
  const label = t(`popup.page.mode.${mode}`);
  if (!label || label === `popup.page.mode.${mode}`) return;

  let el = document.querySelector('.tmt-mode-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'tmt-mode-toast';
    el.setAttribute('translate', 'no');
    el.setAttribute('role', 'status');
    el.style.cssText = [
      'position:fixed',
      'top:72px',
      'left:50%',
      'z-index:2147483647',
      'max-width:min(80vw,420px)',
      'padding:9px 18px',
      'border-radius:999px',
      'background:rgba(17,24,39,0.9)',
      'color:#fff',
      'font:500 14px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,0.28)',
      'pointer-events:none',
      'white-space:nowrap',
      'overflow:hidden',
      'text-overflow:ellipsis',
      'opacity:0',
      'transform:translate(-50%,-8px)',
      'transition:opacity .16s ease,transform .16s ease',
    ].join(';');
    (document.body || document.documentElement).appendChild(el);
  }

  el.textContent = label;
  // 重复触发时先归位，让过渡每次都能完整播放
  el.style.transition = 'none';
  el.style.opacity = '0';
  el.style.transform = 'translate(-50%,-8px)';
  void el.offsetWidth;
  el.style.transition = 'opacity .16s ease,transform .16s ease';
  el.style.opacity = '1';
  el.style.transform = 'translate(-50%,0)';

  clearTimeout(showModeToast._timer);
  showModeToast._timer = setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translate(-50%,-8px)';
  }, 1400);
}

/**
 * 快捷键：Alt+Shift+T 轮转显示模式。
 * 写入配置并广播，popup 与其它标签页会同步。
 */
function installShortcut() {
  document.addEventListener('keydown', (e) => {
    if (!(e.altKey && e.shiftKey) || (e.key || '').toLowerCase() !== 't') return;
    const target = e.target;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ''))) return;
    e.preventDefault();

    const idx = MODE_CYCLE.indexOf(state.mode);
    const next = MODE_CYCLE[(idx + 1) % MODE_CYCLE.length];
    log.info(`快捷键切换显示模式：${state.mode} → ${next}`);
    showModeToast(next);

    chrome.runtime.sendMessage({
      method: MSG.UPDATE_CONFIG,
      data: { translationMode: next },
    }).catch(() => { /* 忽略 */ });
  });
}

/** 段落文本归一化后取哈希：忽略/恢复两侧用同一口径，避免空白差异导致对不上 */
function paragraphKey(text) {
  return hashKey(String(text || '').replace(/\s+/g, ' ').trim());
}

/** 从点击目标找段落元素：优先带 [data-tmt-p] 的祖先，否则向上找第一个块级元素 */
function findParagraphElement(target) {
  const marked = target.closest?.(`[${MARK.PARAGRAPH}]`);
  if (marked) return marked;
  let el = target;
  for (let i = 0; i < 8 && el && el !== document.body; i += 1, el = el.parentElement) {
    const display = getComputedStyle(el).display;
    if (display && display !== 'inline' && display !== 'contents') return el;
  }
  return null;
}

/**
 * Alt+点击 段落：加入/取消"按段落忽略"（由 ignoreEnabled 开关控制）。
 * 忽略按文本哈希记在当前域名下，刷新后依然生效；再次 Alt+点击同一段即可恢复。
 */
function installParagraphIgnore() {
  document.addEventListener('click', (e) => {
    if (!e.altKey) return;
    if (state.config?.ignoreEnabled === false) return;
    if (e.target.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    const paragraphEl = findParagraphElement(e.target);
    if (!paragraphEl) return;
    e.preventDefault();
    e.stopPropagation();
    toggleIgnoreParagraph(paragraphEl);
  }, true);
}

/**
 * 切换某段落的"忽略翻译"状态。
 * 已忽略的段落译文壳和 [data-tmt-p] 都已移除，只能靠 DOM 文本反查，
 * 再 Alt+点击同一段即可恢复（与忽略走同一条路径）。
 */
function toggleIgnoreParagraph(paragraphEl) {
  const para = [...state.paragraphs.values()].find(p => p.blockEl === paragraphEl);
  const host = location.hostname;

  // 已忽略段落不在 paragraphs 里，直接取 DOM 文本
  const text = para?.text || paragraphEl.innerText || '';
  if (!text.trim()) return;

  const key = paragraphKey(text);
  const rawKey = hashKey(text);
  const list = new Set(state.config.ignoreParagraphs?.[host] || []);
  const wasIgnored = state.ignored.has(key) || state.ignored.has(rawKey);
  const nowIgnored = !wasIgnored;

  if (nowIgnored) {
    state.ignored.add(key);
    list.add(key);
  } else {
    state.ignored.delete(key);
    state.ignored.delete(rawKey);
    list.delete(key);
    list.delete(rawKey);
  }
  state.config.ignoreParagraphs = { ...(state.config.ignoreParagraphs || {}), [host]: [...list] };

  if (nowIgnored) {
    if (para) {
      para.targetWrapper?.remove();
      para.targetWrapper = null;
      state.paragraphs.delete(para.id);
    }
    // 移除段落锚点：避免被忽略的段落保持"已翻译"标记
    paragraphEl.removeAttribute(MARK.PARAGRAPH);
  } else if (state.translated) {
    // 恢复翻译：该段已被移出待翻译集合，重排一次让它重新进入收集（译文走缓存）
    rerenderAll();
  } else if (para) {
    state.pipeline.enqueue(para);
  }

  log.info(`按段落忽略：${nowIgnored ? '已忽略' : '已恢复'} ${text.slice(0, 30)}`);
  // 只提交增量：引擎里的 config 可能比 storage 旧，整份回写会覆盖 popup 刚改的项
  chrome.runtime.sendMessage({
    method: MSG.UPDATE_CONFIG,
    data: { ignoreParagraphs: state.config.ignoreParagraphs },
  }).catch(() => { /* 忽略 */ });
}

/** 接消息 */
function installMessageHandlers() {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    (async () => {
      // 所有业务处理都等引擎初始化完成，避免读到空的 config/pipeline
      await readyPromise;

      switch (msg?.method) {
        case MSG.TRANSLATE_PAGE:
          // 不 await：翻译是异步长任务，立刻回包让 popup 能显示进度。
          // （若 await，SPA 页面等正文可能要 5s，用户会以为"点了没反应"）
          startTranslation().catch(err => log.error('startTranslation 失败', err));
          sendResponse({ ok: true, translated: true, translating: true, ...progressSnapshot() });
          break;

        case MSG.TOGGLE_PAGE:
          // 兼容旧入口（快捷键/右键菜单）：没译文就翻译，有译文就还原
          if (state.translated) {
            restorePage();
            sendResponse({ ok: true, translated: false, ...progressSnapshot() });
          } else {
            startTranslation().catch(err => log.error('startTranslation 失败', err));
            sendResponse({ ok: true, translated: true, translating: true, ...progressSnapshot() });
          }
          break;

        case MSG.GET_PROGRESS:
          sendResponse({ ok: true, translated: state.translated, ...progressSnapshot() });
          break;

        case MSG.GET_LOGS:
          // 调试面板：把引擎侧缓冲日志吐给 popup
          sendResponse({ ok: true, logs: log.dump() });
          break;

        case MSG.CLEAR_LOGS:
          log.clear();
          sendResponse({ ok: true });
          break;

        case MSG.SET_THEME:
          if (state.config) {
            state.config.theme = msg.data?.theme || state.config.theme;
            if (msg.data?.themeColor) state.config.themeColor = msg.data.themeColor;
            applyThemeToExisting(state.config.theme, state.config.themes, state.config.themeColor);
          }
          sendResponse({ ok: true });
          break;

        case MSG.SET_POSITION:
          // 译文位置热更新：只重排已有译文壳，不重新翻译
          if (state.config && msg.data?.position) {
            state.config.translationPosition = msg.data.position;
            applyPositionToExisting(state);
          }
          sendResponse({ ok: true });
          break;

        case MSG.SET_LANGUAGE:
          // 语言对变更：必须同步进 state.config，否则点"翻译"仍用旧语言。
          // 只有语言真的变了才重翻（每次保存配置都会广播，避免白跑一遍）。
          if (state.config && msg.data) {
            const nextFrom = msg.data.sourceLanguage || state.config.sourceLanguage;
            const nextTo = msg.data.targetLanguage || state.config.targetLanguage;
            const changed = nextFrom !== state.config.sourceLanguage || nextTo !== state.config.targetLanguage;
            state.config.sourceLanguage = nextFrom;
            state.config.targetLanguage = nextTo;
            if (changed) {
              log.info(`语言对更新：${nextFrom} → ${nextTo}`);
              // 已排队的旧语言任务作废；在途结果由收集代次过滤
              state.pipeline?.reset();
              // 页面已有译文时按新语言重翻（缓存键带语言，不会命中旧译文）
              if (state.translated) rerenderAll();
            }
          }
          sendResponse({ ok: true });
          break;

        case MSG.SET_SERVICE:
          if (state.config && msg.data?.service) state.config.service = msg.data.service;
          sendResponse({ ok: true });
          break;

        case MSG.SET_TRANSLATION_MODE: {
          // 已下线的旧模式值回退到双语对照
          const next = msg.data?.mode || state.mode;
          state.mode = ['translation', 'translationHover', 'original'].includes(next) ? 'dual' : next;
          document.documentElement.setAttribute('data-tmt-mode', state.mode);
          rerenderAll();
          sendResponse({ ok: true });
          break;
        }

        case MSG.SET_SELECTION:
          // 划词翻译配置热更新：更新 state.config 并重新安装（installSelection 内部会去重绑事件）
          if (state.config && msg.data?.selection) {
            state.config.selection = msg.data.selection;
            installSelection({
              enabled: state.config.selection.enabled,
              showMode: state.config.selection.showMode,
              dict: state.config.dict,
              theme: state.config.popupTheme,
            });
          }
          sendResponse({ ok: true });
          break;

        case MSG.SET_DICT:
          // 单词音标/朗读开关热更新（下次渲染自然生效）
          if (state.config && msg.data?.dict) {
            state.config.dict = msg.data.dict;
            installSelection({ dict: state.config.dict, theme: state.config.popupTheme });
          }
          sendResponse({ ok: true });
          break;

        case MSG.SET_POPUP_THEME:
          // 界面主题热更新：划词浮层跟随换肤（已打开的面板会关闭，下次划词用新配色）
          if (state.config) {
            state.config.popupTheme = msg.data?.popupTheme || state.config.popupTheme;
            if (msg.data?.popupThemeImage !== undefined) {
              state.config.popupThemeImage = msg.data.popupThemeImage;
            }
            if (msg.data?.popupThemeOpacity !== undefined) {
              state.config.popupThemeOpacity = msg.data.popupThemeOpacity;
            }
            if (msg.data?.popupThemeImageOpacity !== undefined) {
              state.config.popupThemeImageOpacity = msg.data.popupThemeImageOpacity;
            }
            if (msg.data?.popupThemeTextColor) {
              state.config.popupThemeTextColor = msg.data.popupThemeTextColor;
            }
            installSelection({
              theme: state.config.popupTheme,
              themeImage: state.config.popupThemeImage || '',
              themeAlpha: state.config.popupThemeOpacity,
              themeImageAlpha: state.config.popupThemeImageOpacity,
              themeTextColor: state.config.popupThemeTextColor,
            });
          }
          sendResponse({ ok: true });
          break;

        case MSG.SET_TEXT_STYLE:
          // 译文字号/颜色热更新：直接改已有译文元素的样式，不重新翻译
          if (state.config) {
            state.config.translationFontScale = msg.data?.fontScale ?? state.config.translationFontScale;
            state.config.translationColor = msg.data?.color || state.config.translationColor;
            if (msg.data?.custom) state.config.translationColorCustom = msg.data.custom;
            applyTranslationStyleToExisting(
              state.config.translationFontScale,
              state.config.translationColor,
              state.config.translationColorCustom,
            );
          }
          sendResponse({ ok: true });
          break;

        case MSG.SET_UI_LANG:
          // 界面语言热更新：划词浮层（含已打开面板）与后续渲染立即生效
          if (state.config && msg.data?.uiLanguage) {
            state.config.uiLanguage = msg.data.uiLanguage;
            setUiLang(resolveUiLang(state.config.uiLanguage));
            relocalizeOverlay();
          }
          sendResponse({ ok: true });
          break;

        case MSG.RESTORE_PAGE:
          restorePage();
          sendResponse({ ok: true, translated: false, ...progressSnapshot() });
          break;

        default:
          sendResponse({ ok: false, error: `unknown method: ${msg?.method}` });
      }
    })().catch(err => {
      log.error('消息处理失败', err);
      try { sendResponse({ ok: false, error: err.message }); } catch { /* channel closed */ }
    });
    return true;
  });
}

/**
 * 恢复原文：删除所有译文包装层，并把段落状态清空。
 * 注意：必须按 class 删（.tmt-target-wrapper），
 * 不能按 data-tmt-state="translation" 删——默认模式是 dual，那样一条都删不掉。
 */
/**
 * 原处替换模式（replace）：把改写过的文本节点恢复为原文并去掉标记。
 * 在 rerenderAll / restorePage 里最先调用——后续的收集和渲染依赖原始文本。
 */
function restoreReplacedText() {
  if (!state.replaceActive) return;
  for (const para of state.paragraphs.values()) {
    for (const n of para.nodes || []) {
      if (n.__tmtReplaced) {
        if (n.__tmtOriginal !== undefined) n.textContent = n.__tmtOriginal;
        delete n.__tmtOriginal;
        delete n.__tmtReplaced;
      }
    }
    // 导航/固定宽度容器的溢出约束还原（renderReplaceInPlace 加的 nowrap/ellipsis/hidden）
    const el = para.blockEl;
    if (el?.__tmtNavStyle) {
      el.style.overflow = el.__tmtNavStyle.overflow;
      el.style.whiteSpace = el.__tmtNavStyle.whiteSpace;
      el.style.textOverflow = el.__tmtNavStyle.textOverflow;
      delete el.__tmtNavStyle;
    }
    para.targetWrapper = null;
  }
  state.replaceActive = false;
}

function restorePage() {
  // 原处替换模式改写过文本节点：先恢复原文（并去标记），否则 walker 会
  // 跳过已替换节点导致收集不到段落，新模式渲染不出任何内容
  restoreReplacedText();
  document.querySelectorAll(`.${MARK.TARGET_WRAPPER}`).forEach(el => el.remove());
  // 左右对照模式给原文元素加过 inline-block 宽度，需要还原原始样式
  clearSideBySide();
  // 清掉段落锚点属性，避免下次渲染残留
  document.querySelectorAll(`[${MARK.PARAGRAPH}]`).forEach(el => el.removeAttribute(MARK.PARAGRAPH));
  for (const para of state.paragraphs.values()) {
    para.targetWrapper = null;
    para.state = 'pending';
  }
  state.translated = false;
  state.progress = { total: 0, done: 0, translating: false, empty: false };
  log.info('已恢复原文');
}

/** 主动触发一次页面翻译（重复点击/重复入队会被忽略） */
async function startTranslation() {
  if (state.progress.translating) {
    log.info('已在翻译中，忽略重复触发');
    return;
  }
  // 立刻置为"进行中"，避免等待正文那几秒里按钮又变回"翻译"
  state.progress.translating = true;
  state.progress.empty = false;
  const container = document.body || document.documentElement;
  await kickOffTranslation(container);
}

/** 给 popup 的进度快照 */
function progressSnapshot() {
  const { total, done, translating, empty } = state.progress;
  return { translating, total, done, empty };
}

function rerenderAll() {
  // 清理现有译文层，重新排一遍
  document.querySelectorAll(`.${MARK.TARGET_WRAPPER}`).forEach(el => el.remove());
  // 左右对照模式给原文元素加过 inline-block 宽度，切模式时必须还原
  clearSideBySide();
  // 原处替换模式改写过文本节点：先恢复原文（并去标记），否则 walker 会
  // 跳过已替换节点导致收集不到段落，新模式渲染不出任何内容
  restoreReplacedText();
  // 同步清掉段落锚点（与 restorePage 对齐），否则重收集期间：
  //  1) 原文仍被 CSS 藏成 display:none → innerText 判空 → 干等 5s 超时
  //     （表现为切换显示模式后页面空白数秒）
  //  2) isBlockElement 对 display:none 一律返回 false，块级段落全部被误判为
  //     行内 → 插入分支错乱（卡片按钮的译文落进 grid 网格层）
  document.querySelectorAll(`[${MARK.PARAGRAPH}]`).forEach(el => el.removeAttribute(MARK.PARAGRAPH));
  if (state.translated) {
    const c = document.body || document.documentElement;
    kickOffTranslation(c).catch(log.warn);
  }
}
