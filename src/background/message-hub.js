/**
 * ============================================================================
 * background/message-hub.js —— 消息分发中心（注册表模式）
 * ============================================================================
 * 统一的消息体：{ method, data }。返回 Promise。
 * ============================================================================
 */

import { MSG, log } from '../shared/constants.mjs';

const handlers = new Map();

/** 注册一个消息 handler */
export function register(method, handler) {
  if (handlers.has(method)) {
    log.warn(`[hub] method "${method}" 已注册，覆盖`);
  }
  handlers.set(method, handler);
}

/** 处理一条消息（同步返回 Promise 给 chrome.runtime.sendMessage） */
export function handle(message, sender) {
  const { method, data } = message || {};
  if (!method) {
    log.warn('[hub] 收到无 method 的消息', message);
    return undefined;
  }
  const h = handlers.get(method);
  if (!h) {
    log.warn(`[hub] 未注册的 method "${method}"`);
    return { ok: false, error: `unknown method: ${method}` };
  }
  try {
    return h(data, sender);
  } catch (err) {
    log.error(`[hub] handler "${method}" 抛错`, err);
    return { ok: false, error: err.message };
  }
}

/**
 * 方便的"向某个 tab 的 content 发消息"——后台常用。
 * 注意 frameId: 0 —— manifest 里 content script 是 all_frames，
 * 不指定 frameId 会广播到所有 iframe，容易拿到子帧的响应。
 */
export async function sendToContent(tabId, method, data = {}) {
  try {
    return await chrome.tabs.sendMessage(tabId, { method, data }, { frameId: 0 });
  } catch (err) {
    // tab 可能已关闭或未注入 content script，静默返回 null
    log.debug('[hub] sendToContent 失败', tabId, method, err.message);
    return null;
  }
}

/**
 * 向所有已打开的 tab 广播消息（循环跳过 sendMessage 失败的 tab）
 */
export async function broadcastToContent(method, data = {}) {
  const tabs = await chrome.tabs.query({ url: ['<all_urls>', 'file:///*'] });
  return Promise.allSettled(
    tabs.map(t => chrome.tabs.sendMessage(t.id, { method, data }, { frameId: 0 })),
  );
}

export { MSG };
