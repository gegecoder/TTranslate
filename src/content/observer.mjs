/**
 * ============================================================================
 * content/observer.mjs —— MutationObserver 监听动态内容
 * ============================================================================
 * SPA 应用（Twitter/YouTube/GitHub）不刷新页面只改 DOM，需要重新翻译新出现的节点。
 *   - 主 observer：subtree + childList + characterData
 *   - 回调过滤：注释/fragment、自身更新（翻译 wrapper 自己改不算）
 *   - URL 变化检测（SPA 路由切换）：location.href 变化 → 延迟重新扫
 * ============================================================================
 */

import { MARK, log } from '../shared/constants.mjs';
import { debounce } from '../shared/utils.mjs';

/**
 * 安装主 MutationObserver。所有回调合并成一次批量 onMutations 调用。
 * 返回一个卸载函数（但我们不卸载——页面生命周期只有一次引擎）。
 */
export function installObserver(container, onMutations) {
  const callback = debounce((mutations) => {
    // 过滤掉不重要的变更
    const relevant = [];
    for (const m of mutations) {
      // characterData 来自文本节点变化——一般是原文本，我们感兴趣
      if (m.type === 'characterData') {
        relevant.push(m.target);
        continue;
      }
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue; // 只要元素节点
        // 跳过我们自己注入的 wrapper
        if (node.classList?.contains(MARK.TARGET_WRAPPER)) continue;
        // 跳过 data-tmt-* 属性相关的变更（formatHtml 等自更新）
        if (node.getAttribute?.(MARK.WALKED)) continue;
        relevant.push(node);
      }
    }
    if (relevant.length > 0) {
      onMutations(relevant);
    }
  }, 300);

  const observer = new MutationObserver(callback);
  observer.observe(container, {
    childList: true,
    subtree: true,
    characterData: true,
  });

  // SPA 路由变化监听：history API hook
  hookHistory(debounce(() => {
    log.info('SPA 路由变化，重新扫描');
    onMutations([container]);
  }, 500));

  return observer;
}

/**
 * 给 history.pushState / replaceState 挂监听——这是 SPA 路由变化的常见触发。
 * 另外监听 hashchange（#/path 风格的路由）作为兜底。
 */
function hookHistory(onChange) {
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = (...args) => { origPush(...args); onChange(); };
  history.replaceState = (...args) => { origReplace(...args); onChange(); };
  window.addEventListener('popstate', onChange);
  window.addEventListener('hashchange', onChange);
}
