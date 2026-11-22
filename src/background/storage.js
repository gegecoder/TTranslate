/**
 * ============================================================================
 * background/storage.js —— chrome.storage.local 包装
 * ============================================================================
 * ：简单 async get/set，带默认值合并。
 * 「默认配置 ← 用户配置」两层，远程同步暂不实现。
 * ============================================================================
 */

import { DEFAULT_CONFIG, STORAGE_KEY } from '../shared/constants.mjs';

/**
 * 配置迁移版本号。
 */
const CONFIG_VERSION = 6;

// ---- 内存缓存 ---------------------------------------------------------------
// SW 每处理一批翻译都会读一次配置；storage I/O + structuredClone(DEFAULT_CONFIG)
// + deepMerge 在高频路径上是纯浪费。任意写配置都会触发 onChanged 使缓存失效。
let cachedConfig = null;
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY.CONFIG]) cachedConfig = null;
  });
} catch { /* 非扩展上下文（构建/测试）没有 chrome.storage，跳过 */ }

/** 读取用户配置，没有就回退到默认配置（带内存缓存，写配置时自动失效） */
export async function loadConfig() {
  if (cachedConfig) return cachedConfig;
  const { [STORAGE_KEY.CONFIG]: userConfig } = await chrome.storage.local.get(STORAGE_KEY.CONFIG);
  const merged = deepMerge(structuredClone(DEFAULT_CONFIG), userConfig || {});

  // 一次性迁移：只跑一次（迁移后写入 configVersion，后续不再覆盖用户选择）
  if (merged.configVersion !== CONFIG_VERSION) {
    const prev = Number(merged.configVersion || 1);
    if (prev < 2) merged.enabled = DEFAULT_CONFIG.enabled;
    if (prev < 3) merged.service = DEFAULT_CONFIG.service;
    // prev < 4 是历史遗留的复制粘贴：原本应该迁移 translationMode 或其他字段，
    // 但实际内容和 prev < 3 完全相同。留一个空注释说明迁移已在 prev < 3 时完成，
    // 避免未来有人误以为此处还有遗漏的迁移逻辑。
    // if (prev < 4) /* 已在 prev < 3 时处理 */;
    if (prev < 5) merged.selection = { ...merged.selection, enabled: DEFAULT_CONFIG.selection.enabled };
    if (prev < 6) merged.selection = { ...merged.selection, showMode: DEFAULT_CONFIG.selection.showMode };
    merged.configVersion = CONFIG_VERSION;
    await chrome.storage.local.set({ [STORAGE_KEY.CONFIG]: merged });
  }
  cachedConfig = merged;
  return merged;
}

/** 保存用户配置（会与现有配置深合并） */
export async function saveConfig(patch) {
  const current = await loadConfig();
  // deepMerge 会原地修改第一个参数；缓存对象必须克隆后再合并，防止污染缓存
  const merged = deepMerge(structuredClone(current), patch);
  await chrome.storage.local.set({ [STORAGE_KEY.CONFIG]: merged });
  cachedConfig = merged;
  return merged;
}

/** 读取翻译缓存（直接用 chrome.storage.local，不做 IndexedDB 多库） */
export async function getCache(key) {
  const bucket = await chrome.storage.local.get(STORAGE_KEY.PARA_CACHE);
  const cache = bucket[STORAGE_KEY.PARA_CACHE] || {};
  return cache[key] || null;
}

/** 批量写缓存 */
export async function putCache(entries /* Map | Object */) {
  const existing = (await chrome.storage.local.get(STORAGE_KEY.PARA_CACHE))[STORAGE_KEY.PARA_CACHE] || {};
  if (entries instanceof Map) {
    for (const [k, v] of entries) existing[k] = v;
  } else {
    Object.assign(existing, entries);
  }
  await chrome.storage.local.set({ [STORAGE_KEY.PARA_CACHE]: existing });
}

/** 清空所有缓存 */
export async function clearCache() {
  await chrome.storage.local.remove([STORAGE_KEY.PARA_CACHE, STORAGE_KEY.LARGE_CACHE]);
}

/** 简单的深合并——对象递归合并，数组后面覆盖前面 */
function deepMerge(target, source) {
  for (const key of Object.keys(source || {})) {
    const src = source[key];
    const dst = target[key];
    if (
      src && typeof src === 'object' && !Array.isArray(src) &&
      dst && typeof dst === 'object' && !Array.isArray(dst)
    ) {
      target[key] = deepMerge(dst, src);
    } else {
      target[key] = src;
    }
  }
  return target;
}
