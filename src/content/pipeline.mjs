/**
 * ============================================================================
 * content/pipeline.mjs —— 批合并 + 并发 + 缓存 + 重试
 * ============================================================================
 * 完整管线：
 *   enqueue(para)    → 进队列，启动 interval 定时器
 *   interval 到期    → 按 maxBatchSize 清空队列
 *   fetchBatch()     → 并发请求（worker pool 模型）
 *   结果回来         → 写缓存 + 调 onBatchComplete 渲染
 *   失败             → 指数退避重试，最多 3 次
 * 缓存 key = hash(source+from+to)，用 background 统一存
 * ============================================================================
 */

import { hashKey, log } from '../shared/utils.mjs';

export class Pipeline {
  constructor(opts) {
    this.fetchBatch = opts.fetchBatch;
    this.readCache = opts.readCache;
    this.writeCache = opts.writeCache;
    this.intervalMs = opts.intervalMs ?? 300;
    this.concurrency = opts.concurrency ?? 5;
    this.maxBatchSize = opts.maxBatchSize ?? 20;
    this.retryTimes = opts.retryTimes ?? 3;
    this.minRetryMs = 1000;
    this.maxRetryMs = 30000;

    // 缓存键生成器。engine 会传入一个包含"服务 + 源语言 + 目标语言"的版本，
    // 避免切换目标语言后仍然命中旧语言的译文。
    this.cacheKey = opts.cacheKey || (text => hashKey(text));

    // 队列里存 para 对象；定时器到期时一次性取出 maxBatchSize 个
    this.queue = [];
    this.timer = null;

    // 正在请求中的批次数。用于判断管线是否真的空闲（进度是否该结束）
    this.inFlight = 0;

    // 已入队但还没被取走的段落 id。★ 必须按 id 去重，
    // 不能按文本去重：两段文字相同但仍是两个段落，若按文本丢弃，
    // 它们永远不会产生结果，进度就会卡在 N-1/N。
    this.inQueue = new Set();

    // 缓存命中结果暂存，避免同段重复请求
    this.cacheHit = new Map();     // textHash → translation

    // 结果回调——engine 设置的
    this.onBatchComplete = null;

    // drain() 里等待 inFlight 空位的 Promise waiter 队列
    this._drainWaiters = [];
  }

  /** 管线是否完全空闲（队列空 + 没有在途请求） */
  isIdle() {
    return this.queue.length === 0 && this.inFlight === 0;
  }

  /**
   * 丢弃排队中的任务（语言切换等场景：旧语言的任务和结果都不再需要）。
   * 在途请求无法中断，其返回值由 engine 按"收集代次"过滤掉。
   * 这里额外把 inFlight 重置为 0——虽然在途请求还会回来调 onBatchComplete，
   * 但 engine 的 gen 代次过滤会把旧结果丢弃；同时 inFlight 归零后 drain
   * 不会再被"等空位"阻塞，后续新语言的 drain 能立即跑起来。
   */
  reset() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.queue = [];
    this.inQueue.clear();
    this.cacheHit.clear();
    // 关键：归零 inFlight，让 drain 的 Promise waiters 能立即收到
    const stillFlying = this.inFlight;
    this.inFlight = 0;
    // 唤醒所有正在等 inFlight < maxInFlight 的 drain 循环
    if (stillFlying > 0) {
      this._drainWaiters?.forEach(r => r());
      this._drainWaiters = [];
    }
  }

  /** 入队一个段落。队列非空时会自动启动定时器 */
  enqueue(para) {
    // 缓存键用「文本 hash」而不是段落 id：
    // 段落 id 是稳定绑定到 DOM 元素的，元素文本变化时 id 不变，
    // 用 id 做键会把旧译文错误地套到新文本上。
    const key = this.cacheKey(para.text);
    if (this.cacheHit.has(key)) {
      // 已经翻译过了，直接走渲染
      this.onBatchComplete?.([
        { para, ok: true, translation: this.cacheHit.get(key) },
      ]);
      return;
    }
    // 同一个段落不要重复入队（MutationObserver 会重复扫描）。
    // ★ 只按 id 去重，不按文本：文本相同的两个段落是两段，都必须有结果。
    if (this.inQueue.has(para.id)) return;

    this.inQueue.add(para.id);
    this.queue.push(para);
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
    }
  }

  /** 清空当前队列，立即发起一次请求。immediate=true 时不重排定时器（排空模式用） */
  flush(immediate = false) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const batch = this.queue.splice(0, this.maxBatchSize);
    batch.forEach(p => this.inQueue.delete(p.id));
    if (batch.length === 0) return;

    // ★ 队列里还有剩余（超过 maxBatchSize）时，必须重新排定时器，
    // 否则后面的段落永远不会被处理。排空模式下由 drain() 自己循环取批。
    if (!immediate && this.queue.length > 0) {
      this.timer = setTimeout(() => this.flush(), this.intervalMs);
    }

    this._run(batch).catch(err => log.warn('pipeline batch failed', err));
  }

  /**
   * 连续排空队列（整页翻译大批入队完成后调用）。
   * 原实现里剩余批次每批都要等 intervalMs，整页翻译白等 N×300ms；
   * 这里批间不等待，但限制同时在途的批次数，避免瞬时把服务打满。
   * 并发空位用 Promise waiter 队列唤醒——drain 不做 25ms 短轮询。
   * 零星入队（MutationObserver 动态内容）仍走 enqueue 里的 interval 定时器。
   */
  async drain({ maxInFlight = 3 } = {}) {
    while (this.queue.length > 0) {
      if (this.inFlight >= maxInFlight) {
        // 用 Promise waiter 等待 _run 结束时唤醒，避免 busy-wait
        await new Promise(resolve => this._drainWaiters.push(resolve));
        continue;
      }
      this.flush(true);
    }
  }

  async _run(batch) {
    this.inFlight++;
    let results = [];
    try {
      // 1) 先查缓存，命中的直接拿出来
      const uncached = [];
      const cacheKeys = batch.map(p => this.cacheKey(p.text));
      const cache = await this.readCache(cacheKeys);

      for (const p of batch) {
        const key = this.cacheKey(p.text);
        const hit = cache.get(key);
        if (hit) {
          results.push({ para: p, ok: true, translation: hit });
          this.cacheHit.set(key, hit);
        } else {
          uncached.push(p);
        }
      }

      // 2) 同批文本去重：同一批里重复出现的文本只请求一次。
      //    （导航菜单、重复标题在页面上很常见，去重能直接省掉服务调用）
      if (uncached.length > 0) {
        const byText = new Map();            // text → para[]
        for (const p of uncached) {
          if (!byText.has(p.text)) byText.set(p.text, []);
          byText.get(p.text).push(p);
        }
        const texts = [...byText.keys()];
        const fetched = await this._fetchWithRetry(texts, texts.map(t => byText.get(t)[0]));

        // 3) 结果按文本回填到每个同文本段落，并写入缓存
        const newCache = new Map();
        fetched.forEach((r, i) => {
          const text = texts[i];
          const paras = byText.get(text);
          const key = this.cacheKey(text);
          if (r.ok) {
            newCache.set(key, r.translation);
            this.cacheHit.set(key, r.translation);
            paras.forEach(para => results.push({ para, ok: true, translation: r.translation }));
          } else {
            paras.forEach(para => results.push({ para, ok: false, error: r.error }));
          }
        });

        if (newCache.size > 0) {
          try { await this.writeCache(newCache); } catch (e) { log.debug('cache write failed', e); }
        }
      }
    } catch (err) {
      // 兜底：任何异常都要给出"每段失败"的结果，
      // 否则这些段落既不完成也不报错，进度会永远停在 N-1/N。
      log.warn('pipeline _run error', err);
      results = batch.map(p => ({ para: p, ok: false, error: err.message }));
    }

    this.inFlight--;
    // 3) 如果 drain 有在等空位的 waiter，唤醒最早的那个
    const waiter = this._drainWaiters?.shift();
    if (waiter) waiter();
    // 4) 回给 engine 渲染（此时在途计数已减，engine 才能正确判断是否全部结束）
    this.onBatchComplete?.(results);
  }

  /** 给 fetchBatch 包一层重试 */
  async _fetchWithRetry(texts, paras, attempt = 1) {
    try {
      return await this.fetchBatch(paras.map(p => p.id), texts);
    } catch (err) {
      if (attempt > this.retryTimes) {
        // 整批重试穷尽后：批里往往只有个别段触发服务端限制，
        // 按段单独重发一次（不带退避），失败的段单独报错，不牵连整批。
        if (texts.length > 1) return this._retryPerSegment(texts, paras, err.message);
        // 用占位结果，让引擎知道这几段全部失败
        return paras.map(p => ({ ok: false, error: err.message }));
      }
      const delay = Math.min(this.minRetryMs * Math.pow(2, attempt - 1), this.maxRetryMs);
      log.info(`retry attempt ${attempt}/${this.retryTimes} in ${delay}ms`);
      await new Promise(r => setTimeout(r, delay));
      return this._fetchWithRetry(texts, paras, attempt + 1);
    }
  }

  /** 整批失败后的按段兜底重试。失败是小概率事件，串行足够，不值得引入并发池 */
  async _retryPerSegment(texts, paras, batchError) {
    const out = [];
    for (let i = 0; i < texts.length; i++) {
      try {
        const r = await this.fetchBatch([paras[i].id], [texts[i]]);
        out.push(r?.[0] ?? { ok: false, error: batchError });
      } catch (e) {
        out.push({ ok: false, error: e?.message || batchError });
      }
    }
    return out;
  }
}
