/**
 * ============================================================================
 * content/guard.js —— 守门脚本（唯一注册在 manifest 的 content script）
 * ============================================================================
 * 跳过 Cloudflare 探针，用一个简单的可见性检查（IntersectionObserver 在父帧判定 iframe 是否真的显示在视口内）。
 * ============================================================================
 */

(function () {
  // 幂等保护：popup 可能通过 chrome.scripting 手动注入本脚本，
  // 若已经注入过就不再重复执行（否则会 import 两次引擎）。
  if (window.__tmtGuardLoaded) return;
  window.__tmtGuardLoaded = true;

  // ---- 调试面包屑 ----------------------------------------------------------
  // 为什么写到 storage 而不是只打 console？
  // 如果引擎 import 失败，content 里根本没有消息监听器，popup 拿不到任何数据；
  // 把每一步落到 storage，popup 的调试面板即使在"完全没反应"时也能读到原因。
  const DEBUG_KEY = '__tmt_debug';
  let manifestVersion = '?';
  try { manifestVersion = chrome.runtime.getManifest().version; } catch { /* ignore */ }

  // 生产构建不输出日志；源码直载（未经过构建）时按开发模式处理
  const IS_DEV = (typeof __TMT_BUILD_MODE__ !== 'undefined' ? __TMT_BUILD_MODE__ : 'dev') !== 'prod';
  const dbg = (...args) => { if (IS_DEV) console.debug('[TTranslate guard]', ...args); };

  function trace(step, extra) {
    try {
      chrome.storage.local.get(DEBUG_KEY, (obj) => {
        const list = Array.isArray(obj?.[DEBUG_KEY]) ? obj[DEBUG_KEY] : [];
        list.push({
          t: new Date().toTimeString().slice(0, 8),
          step,
          extra: extra === undefined ? null : String(extra).slice(0, 300),
          url: location.href.slice(0, 200),
          top: !inIframe,
          v: manifestVersion,
        });
        chrome.storage.local.set({ [DEBUG_KEY]: list.slice(-60) });
      });
    } catch { /* 调试代码不能影响主流程 */ }
  }

  // 先取上下文信息，再打面包屑（trace 里会用到 inIframe）
  const href = location.href;
  const host = location.hostname.toLowerCase();
  const inIframe = self !== top;

  trace('guard_start');

  // 广告域名黑名单
  const BLOCKED_HOSTS = new Set([
    'doubleclick.net', 'googlesyndication.com', 'pubmatic.com',
    'openx.net', 'rubiconproject.com', 'criteo.com',
    'taboola.com', 'outbrain.com', 'imasdk.googleapis.com',
  ]);

  // Cloudflare 挑战页判定（URL 路径含 challenge-platform）
  const CF_CHALLENGE_PATH = '/cdn-cgi/challenge-platform/';

  /** 判断该 host 是否被屏蔽 */
  function isBlockedHost(h) {
    for (const b of BLOCKED_HOSTS) {
      if (h === b || h.endsWith('.' + b)) return true;
    }
    return false;
  }

  // 正则缓存：pattern 字符串 → RegExp 对象，避免每次调用都 new RegExp
  const patternRegexCache = new Map();

  /** 简单的 URL glob 匹配 */
  function matchesPattern(url, patterns) {
    if (!patterns?.length) return false;
    try {
      return patterns.some(p => {
        let re = patternRegexCache.get(p);
        if (!re) {
          re = new RegExp('^' + p
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*') + '$');
          patternRegexCache.set(p, re);
        }
        return re.test(url);
      });
    } catch { return false; }
  }

  // ---- 快速排除 ------------------------------------------------------------
  if (isBlockedHost(host)) {
    dbg('广告域名，跳过加载:', host);
    trace('skip_blocked_host', host);
    return;
  }
  if (href.includes(CF_CHALLENGE_PATH)) {
    dbg('CF 挑战页，跳过加载');
    trace('skip_cloudflare_challenge');
    return;
  }

  /**
   * 用户屏蔽 URL 是从存储里读的，需要异步。如果 250ms 内没返回（超时兜底），就继续加载引擎
   */
  async function getUserBlockUrls() {
    try {
      const { fullLocalUserConfig } = await chrome.storage.local.get('fullLocalUserConfig');
      return fullLocalUserConfig?.blockUrls || fullLocalUserConfig?.userBlockUrls || [];
    } catch { return []; }
  }

  /**
   * 真正的启动流程。
   * - 顶层 frame：直接加载引擎
   * - iframe：先向父帧请求可见性判定，2s 超时兜底继续加载
   */
  async function boot() {
    trace('boot_start', `iframe=${inIframe}`);
    // 1. 先看用户有没有明确屏蔽这个 URL
    const timer = setTimeout(() => /* 超时就放行 */ null, 250);
    const userPatterns = await getUserBlockUrls();
    clearTimeout(timer);
    if (matchesPattern(href, userPatterns)) {
      dbg('用户屏蔽的 URL，跳过');
      trace('skip_user_block_url');
      return;
    }

    if (!inIframe) {
      // 顶层 frame，直接加载
      importEngine();
      return;
    }

    // iframe：向父帧请求可见性判定（简化版）
    const checkId = Math.random().toString(36).slice(2);
    let settled = false;

    const onReply = (ev) => {
      if (ev.source !== parent) return;
      if (ev.data?.type === 'tmt-tell-iframe-visibility' && ev.data.checkId === checkId) {
        ev.stopImmediatePropagation?.();
        settled = true;
        trace('iframe_visibility_reply', ev.data.visible ? 'visible' : 'invisible');
        if (ev.data.visible) importEngine();
        else dbg('iframe 不可见，跳过');
        window.removeEventListener('message', onReply, true);
      }
    };
    window.addEventListener('message', onReply, true);

    try {
      parent.postMessage({ type: 'tmt-ask-iframe-visibility', checkId, href }, '*');
    } catch { /* cross-origin 可能抛 */ }

    // 2 秒兜底
    setTimeout(() => {
      if (!settled) {
        window.removeEventListener('message', onReply, true);
        importEngine(); // 看不到父帧就乐观加载
      }
    }, 2000);
  }

  /**
   * 顶层 frame 的 iframe reporter：挂一个 message listener，当收到子帧的可见性请求时，用 IntersectionObserver 检查 iframe 元素，回复 visible/invisible。
   */
  function installIframeReporter() {
    if (inIframe) return; // 只有顶层才做 reporter

    window.addEventListener('message', (ev) => {
      if (ev.data?.type !== 'tmt-ask-iframe-visibility') return;
      // 找到发消息的 iframe 元素
      const iframe = [...document.querySelectorAll('iframe')]
        .find(f => f.contentWindow === ev.source);
      if (!iframe) {
        // 找不到的话乐观认为可见（某些跨域场景）
        ev.source.postMessage(
          { type: 'tmt-tell-iframe-visibility', checkId: ev.data.checkId, visible: true }, '*',
        );
        return;
      }
      const io = new IntersectionObserver((entries) => {
        io.disconnect();
        const visible = entries[0].isIntersecting &&
          entries[0].intersectionRatio > 0.01;
        ev.source.postMessage(
          { type: 'tmt-tell-iframe-visibility', checkId: ev.data.checkId, visible }, '*',
        );
      }, { threshold: [0, 0.01] });
      io.observe(iframe);
    }, true);
  }

  // ---- 启动 ---------------------------------------------------------------
  installIframeReporter();
  boot();

  /**
   * 动态 import 主引擎（注意：content 脚本在 MV3 里默认是 world ISOLATED，
   * 所以 import() 加载的模块不能访问页面 JS，只能操作 DOM，这正符合我们的需求。
   * runtime.getURL 返回 chrome-extension:// 前缀的绝对 URL）
   *
   * 失败处理：重试一次；仍失败则在页面上显示红色提示，
   * 避免用户只看到"点击没反应"却不知道原因。
   */
  function importEngine(attempt = 1) {
    const url = chrome.runtime.getURL('content/engine.mjs');
    dbg('loading engine:', url);
    trace('import_start', `attempt=${attempt}`);
    import(url).then(mod => {
      if (typeof mod.runEngine !== 'function') {
        throw new Error('engine.mjs 未导出 runEngine');
      }
      trace('import_ok');
      return mod.runEngine();
    }).then(() => {
      trace('engine_running');
    }).catch(err => {
      dbg('engine load failed:', err);
      trace('import_error', err?.message || String(err));
      if (attempt < 2) {
        setTimeout(() => importEngine(attempt + 1), 800);
        return;
      }
      showLoadError(err);
    });
  }

  /** 在页面角落显示一条红色错误条 */
  function showLoadError(err) {
    const show = () => {
      const el = document.createElement('div');
      el.setAttribute('data-tmt-error', '1');
      el.style.cssText = [
        'position:fixed', 'z-index:2147483647', 'left:12px', 'bottom:12px',
        'max-width:420px', 'padding:8px 12px', 'background:#c62828', 'color:#fff',
        'font:12px/1.5 system-ui,sans-serif', 'border-radius:6px',
        'box-shadow:0 4px 16px rgba(0,0,0,.3)', 'white-space:pre-wrap',
        'pointer-events:none',
      ].join(';');
      el.textContent = '[TTranslate] 翻译引擎加载失败：' + (err?.message || String(err));
      (document.body || document.documentElement).appendChild(el);
      setTimeout(() => el.remove(), 20000);
    };
    if (document.body) show();
    else document.addEventListener('DOMContentLoaded', show, { once: true });
  }
})();
