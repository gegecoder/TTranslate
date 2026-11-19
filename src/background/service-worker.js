/**
 * ============================================================================
 * background/service-worker.js —— 后台入口（MV3 Service Worker）
 * ============================================================================
 * 初始化消息注册表 + 生命周期监听。
 * 所有 content/popup → background 的请求都统一走 onMessage → hub.handle()。
 * ============================================================================
 */

import * as storage from './storage.js';
import * as proxy from './api-proxy.js';
import * as dictionary from './dictionary.js';
import { register, handle, broadcastToContent, sendToContent } from './message-hub.js';
import { MSG, STORAGE_KEY, log } from '../shared/constants.mjs';
import { t, setUiLang, resolveUiLang } from '../shared/i18n.mjs';

// ---- 生命周期 --------------------------------------------------------------
chrome.runtime.onInstalled.addListener(async () => {
  log.info('TTranslate installed, setting up context menu...');
  // 右键菜单标题跟随界面语言配置
  const cfg = await storage.loadConfig();
  setUiLang(resolveUiLang(cfg.uiLanguage));
  chrome.contextMenus.create({
    id: 'tmt-toggle',
    title: t('contextMenu.toggle'),
    contexts: ['page', 'action'],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'tmt-toggle' && tab?.id) {
    sendToContent(tab.id, MSG.TOGGLE_PAGE);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggleTranslatePage') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) sendToContent(tab.id, MSG.TOGGLE_PAGE);
  }
});

// ---- 消息注册 --------------------------------------------------------------
// 所有 handler 都是 async，消息体经 chrome 序列化后 data 字段就是直接透传的参数。

register(MSG.GET_CONFIG, async () => {
  return { ok: true, config: await storage.loadConfig() };
});

register(MSG.UPDATE_CONFIG, async (patch) => {
  const merged = await storage.saveConfig(patch);
  // 配置变化时广播给所有 content 脚本热更新
  broadcastToContent(MSG.SET_THEME, { theme: merged.theme, themeColor: merged.themeColor });
  broadcastToContent(MSG.SET_SERVICE, { service: merged.service });
  broadcastToContent(MSG.SET_TRANSLATION_MODE, { mode: merged.translationMode });
  broadcastToContent(MSG.SET_POSITION, { position: merged.translationPosition });
  broadcastToContent(MSG.SET_SELECTION, { selection: merged.selection });
  broadcastToContent(MSG.SET_DICT, { dict: merged.dict });
  broadcastToContent(MSG.SET_UI_LANG, { uiLanguage: merged.uiLanguage });
  broadcastToContent(MSG.SET_POPUP_THEME, {
    popupTheme: merged.popupTheme,
    popupThemeImage: merged.popupThemeImage || '',
    popupThemeOpacity: merged.popupThemeOpacity,
    popupThemeImageOpacity: merged.popupThemeImageOpacity,
    popupThemeTextColor: merged.popupThemeTextColor,
  });
  broadcastToContent(MSG.SET_TEXT_STYLE, {
    fontScale: merged.translationFontScale,
    color: merged.translationColor,
    custom: merged.translationColorCustom,
  });
  // 右键菜单标题跟随界面语言
  setUiLang(resolveUiLang(merged.uiLanguage));
  chrome.contextMenus.update('tmt-toggle', { title: t('contextMenu.toggle') });
  return { ok: true, config: merged };
});

// 主服务整批失败（网络抖动 / 服务宕机）时按此顺序自动降级，
// 避免整页全是"翻译失败：Failed to fetch"
const FAILOVER_ORDER = ['bingfree', 'googlefree', 'mymemory', 'lingva'];

register(MSG.TRANSLATE_BATCH, async ({ service, from, to, texts }) => {
  const cfg = await storage.loadConfig();
  const order = [service, ...FAILOVER_ORDER.filter((k) => k !== service)]
    .filter((k) => cfg.services[k]);
  let results = null;
  for (let i = 0; i < order.length; i++) {
    const svc = cfg.services[order[i]];
    const conc = Math.min(svc.concurrency, svc.maxBatchSize);
    results = await proxy.translateBatch(svc, from, to, texts, { concurrency: conc, timeoutMs: svc.timeoutMs });
    const okCount = results.filter((r) => r?.ok).length;
    if (okCount > 0) {
      if (i > 0) log.warn(`[translate] 主服务失败，已降级到 ${svc.name}（${okCount}/${results.length} 成功）`);
      break;
    }
    log.warn(`[translate] ${svc.name} 整批失败（${results.length} 段），尝试降级`);
  }
  return { ok: true, results };
});

register(MSG.GET_WORD_INFO, async ({ text, provider }) => {
  return dictionary.lookupWord(text, provider);
});

register(MSG.REPORT, async (payload) => {
  log.info('[telemetry]', payload);
  return { ok: true };
});

register(MSG.TOGGLE_PAGE, async (_, sender) => {
  if (sender.tab?.id) {
    sendToContent(sender.tab.id, MSG.TOGGLE_PAGE);
    return { ok: true };
  }
  return { ok: false, error: 'no tab' };
});

register(MSG.GET_BADGE_STATE, async (_, sender) => {
  const cfg = await storage.loadConfig();
  return { ok: true, enabled: cfg.enabled };
});

// ---- 接收入口 --------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // hub.handle 可能返回同步值也可能返回 Promise，一并处理
  const result = handle(message, sender);
  if (result && typeof result.then === 'function') {
    result.then(r => sendResponse(r)).catch(e => sendResponse({ ok: false, error: e.message }));
    return true; // 告诉 Chrome 我们会异步响应
  }
  sendResponse(result);
});

log.info('TTranslate service worker booted');
