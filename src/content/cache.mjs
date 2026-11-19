/**
 * ============================================================================
 * content/cache.mjs —— 翻译缓存（L1 内存 LRU + L2 批量持久化）
 * ============================================================================
 * 设计目标：同一段文本 + 同一目标语言，永远只请求一次翻译服务。
 *
 * 为什么不用"每段发消息问后台"？
 *   旧实现是 79 段 → 79 次 chrome.runtime.sendMessage 往返，
 *   仅查缓存就要几百毫秒，而且还阻塞首屏译文出现。
 *   现在 content script 直接读 chrome.storage.local：
 *   启动时一次性载入到内存，之后所有查询都是 Map.get()。
 *
 * 三层结构：
 *   L1  内存 Map（本次会话，命中零成本）
 *   L2  chrome.storage.local（跨页面/跨会话，整表批量载入 & 批量写回）
 *   L3  同批去重（pipeline 里做，见 pipeline.mjs 的 byText）
 *
 * 写回策略：
 *   翻译完成后不立刻落盘，而是 debounce 800ms 后整表写一次。
 *   一次翻译 79 段只会产生 1~2 次 storage 写入，而不是 79 次。
 *
 * 淘汰策略：
 *   简单的 LRU（按最后访问时间），超过 maxEntries 就丢掉最久未用的。
 *   条目里存 { v: 译文, t: 最后访问时间戳 }。
 * ============================================================================
 */

import { log } from '../shared/constants.mjs';

const CACHE_KEY = 'translationCache';   // chrome.storage.local 中的键名
const DEFAULT_MAX = 3000;               // 最多保留 3000 条（约 1~2MB）
const DEFAULT_FLUSH_DELAY = 800;        // 写回防抖

export class TranslationCache {
  constructor({ maxEntries = DEFAULT_MAX, flushDelay = DEFAULT_FLUSH_DELAY } = {}) {
    this.max = maxEntries;
    this.flushDelay = flushDelay;

    /** key → { v: 译文, t: 最后访问时间 } */
    this.map = new Map();

    /** 自上次写回以来被修改过的 key（只用于判断"要不要写"） */
    this.dirty = new Set();

    this.flushTimer = null;
    this.flushing = null;
    this._initPromise = null;

    /** 统计信息：便于在调试面板里看命中率 */
    this.stats = { hit: 0, miss: 0, flushCount: 0, persisted: 0 };
  }

  /**
   * 首次使用时把整个缓存表载入 L1。
   * 只载入一次；后续调用直接复用同一个 Promise。
   */
  init() {
    if (!this._initPromise) {
      this._initPromise = chrome.storage.local.get(CACHE_KEY)
        .then(obj => {
          const raw = obj?.[CACHE_KEY];
          if (raw && typeof raw === 'object') {
            for (const [k, v] of Object.entries(raw)) {
              if (v && typeof v.v === 'string') this.map.set(k, v);
            }
          }
          this.stats.persisted = this.map.size;
          log.info(`cache: 载入 ${this.map.size} 条历史译文`);
        })
        .catch(err => log.warn('cache: 载入失败', err));
    }
    return this._initPromise;
  }

  /** 批量查询，返回 Map(key → 译文)。未命中的 key 不在返回结果里 */
  async getMany(keys) {
    await this.init();
    const out = new Map();
    const now = Date.now();

    for (const key of keys) {
      const entry = this.map.get(key);
      if (entry) {
        out.set(key, entry.v);
        entry.t = now;          // 刷新 LRU 时间
        // Map 的插入顺序即访问顺序：命中后先删再插，把键移到末尾表示"最近使用"
        this.map.delete(key);
        this.map.set(key, entry);
        this.stats.hit++;
      } else {
        this.stats.miss++;
      }
    }
    return out;
  }

  /** 写入一条。只在内存里改，落盘由 scheduleFlush 统一安排 */
  set(key, value) {
    if (typeof value !== 'string' || !value) return;
    // 覆盖已有键时也先删再插，把键移到末尾（写入同样算"最近使用"，避免刚写的条目被先淘汰）
    this.map.delete(key);
    this.map.set(key, { v: value, t: Date.now() });
    this.dirty.add(key);

    if (this.map.size > this.max) this._evict();
    this.scheduleFlush();
  }

  /** 批量写入（一次遍历，避免重复调度） */
  setMany(entries /* Map<key, value> */) {
    for (const [k, v] of entries) this.set(k, v);
  }

  /** 防抖写回：多次 set 只触发一次 storage.set */
  scheduleFlush() {
    if (this.flushTimer || this.dirty.size === 0) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch(err => log.warn('cache: flush 失败', err));
    }, this.flushDelay);
  }

  /** 立即把整表写回 storage（并发调用会复用同一个写入过程） */
  async flush() {
    if (this.flushing) return this.flushing;
    if (this.dirty.size === 0) return;

    this.flushing = (async () => {
      this.dirty.clear();
      const payload = Object.fromEntries(this.map);
      try {
        await chrome.storage.local.set({ [CACHE_KEY]: payload });
        this.stats.flushCount++;
        this.stats.persisted = this.map.size;
        log.debug(`cache: 写回 ${Object.keys(payload).length} 条`);
      } catch (err) {
        log.warn('cache: 写回失败', err);
      }
    })().finally(() => { this.flushing = null; });

    return this.flushing;
  }

  /** 超过上限时按最久未访问淘汰（LRU）：利用 Map 插入顺序，首项即最久未使用 */
  _evict() {
    // 一次多腾一点（降到 90%），避免每写一条都要淘汰一次
    const target = Math.floor(this.max * 0.9);
    const remove = this.map.size - target;
    if (remove <= 0) return;

    for (let i = 0; i < remove; i++) {
      // O(1) 取 Map 首项（最久未使用），无需全量排序
      const key = this.map.keys().next().value;
      if (key === undefined) break;
      this.map.delete(key);
      this.dirty.add(key);  // 让下一次写回把删除同步到 storage
    }
    log.debug(`cache: LRU 淘汰 ${remove} 条`);
  }

  /** 命中率摘要，翻译结束后打印一次 */
  summary() {
    const { hit, miss } = this.stats;
    const total = hit + miss;
    const rate = total ? Math.round((hit / total) * 100) : 0;
    return `cache 命中 ${hit}/${total}（${rate}%），共 ${this.map.size} 条`;
  }
}
