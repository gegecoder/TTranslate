/**
 * ============================================================================
 * background/api-proxy.js —— 翻译 API 代理
 * ============================================================================
 * 内置引擎实现：
 *   - Bing 免费翻译（https://edge.microsoft.com/translate/translatetext）—— 默认
 *     一次返回同样数量的结果（自带语言检测）。实测国内可用、无需 key。
 *   - MyMemory（https://api.mymemory.translated.net/get）
 *     免费、无需 key；限制：单次 query ≤ 500 字符、匿名每日约 5000 字符
 *   - Lingva Translate（https://lingva.ml/api/v1/{from}/{to}/{query}）
 *     免费、无需 key；注意公共实例经常 403/503，作为备用
 *   - LibreTranslate（http://localhost:5000/translate）
 *     本地服务需要用户自己部署并配置 baseUrl + apiKey
 * ============================================================================
 */

import { log } from '../shared/constants.mjs';
import { withTimeout } from '../shared/utils.mjs';

/**
 * 有上限的并发 map（保序）：results[i] 对应 items[i]。
 * Bing 子批 / MyMemory 切块原来都是串行 await，N 个子批 = N 次 RTT；
 * 并发后总耗时 ≈ ceil(N / limit) 次 RTT。
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const conc = Math.max(1, Math.min(limit, items.length));
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));
  return results;
}

const isBingFree = (cfg) =>
  cfg?.name?.includes('Bing') || cfg?.baseUrl?.includes('edge.microsoft.com/translate/translatetext');

/** 翻译一个字符串。返回 { ok, translation, error, from, to } */
export async function translateOne(serviceCfg, from, to, text) {
  if (!text || !text.trim()) {
    return { ok: true, translation: text, from, to };
  }
  try {
    let result;
    if (isBingFree(serviceCfg)) {
      // Bing 是批量接口，单段时包成单元素数组
      const [r] = await viaBingBatch(serviceCfg, from, to, [text]);
      return r;
    } else if (serviceCfg.name === 'LibreTranslate' || serviceCfg.baseUrl.includes('libretranslate')) {
      result = await viaLibre(serviceCfg, from, to, text);
    } else if (serviceCfg.name === 'MyMemory' || serviceCfg.baseUrl.includes('mymemory')) {
      result = await viaMyMemory(serviceCfg, from, to, text);
    } else if (serviceCfg.name?.includes('Google') || serviceCfg.baseUrl.includes('translate.googleapis.com')) {
      result = await viaGoogleFree(serviceCfg, from, to, text);
    } else {
      result = await viaLingva(serviceCfg, from, to, text);
    }
    return { ok: true, translation: result, from, to };
  } catch (err) {
    log.warn('[api-proxy] 翻译失败', err.message);
    return { ok: false, translation: null, error: err.message, from, to };
  }
}

/**
 * 批量翻译。输入一个字符串数组，输出相同长度的结果数组。
 * 先把多段合并成大请求再拆回来；
 * Bing 走批量接口，其余服务逐段请求但用并发控制。
 */
export async function translateBatch(serviceCfg, from, to, texts, { concurrency = 5, timeoutMs = 15000 } = {}) {
  if (isBingFree(serviceCfg)) {
    return viaBingBatch(serviceCfg, from, to, texts, { timeoutMs });
  }

  const results = new Array(texts.length).fill(null);
  let next = 0;
  const conc = Math.max(1, Math.min(concurrency, texts.length));

  // 简单的 worker pool：每个 worker 从队列取任务直到拿完
  async function worker() {
    while (true) {
      const idx = next++;
      if (idx >= texts.length) return;
      const r = await withTimeout(translateOne(serviceCfg, from, to, texts[idx]), timeoutMs, `translate#${idx}`);
      results[idx] = r;
    }
  }
  await Promise.all(Array.from({ length: conc }, () => worker()));
  return results;
}

// ---- Bing 免费翻译 ----------------------------------------------------------
// 接口：POST https://edge.microsoft.com/translate/translatetext?to=zh-Hans&isEnterpriseClient=false
// 请求体：["text1","text2", ...]        ← 纯 JSON 字符串数组
// 响应：[{ detectedLanguage:{language}, translations:[{ text }] }, ...]
// 说明：一次请求翻多段，比逐段请求省时很多。
async function viaBingBatch(cfg, from, to, texts, { timeoutMs = 15000 } = {}) {
  const results = new Array(texts.length).fill(null);

  // 空白文本直接通过，不浪费请求
  const pending = [];
  texts.forEach((t, i) => {
    if (!t || !t.trim()) results[i] = { ok: true, translation: t, from, to };
    else pending.push({ index: i, text: t });
  });
  if (pending.length === 0) return results;

  const maxItems = cfg.maxBatchSize || 10;
  const maxChars = cfg.maxTextLength || 5000;

  // 超长单段兜底：单段超过 maxTextLength 时按句切块、逐块翻译后拼回。
  // 不切的话该段会独占一个超限批次，请求直接被服务端拒绝。
  const pieces = [];   // { index, text, part, total }，part=null 表示整段
  for (const item of pending) {
    if (item.text.length <= maxChars) {
      pieces.push({ index: item.index, text: item.text, part: null, total: 1 });
      continue;
    }
    const chunks = splitByLength(item.text, maxChars);
    chunks.forEach((c, k) => pieces.push({ index: item.index, text: c, part: k, total: chunks.length }));
  }

  // 按 maxBatchSize / maxTextLength 拆子批，避免单请求过大被拒
  const batches = [];
  let cur = [];
  let curLen = 0;
  for (const item of pieces) {
    if (cur.length >= maxItems || (cur.length > 0 && curLen + item.text.length > maxChars)) {
      batches.push(cur); cur = []; curLen = 0;
    }
    cur.push(item);
    curLen += item.text.length;
  }
  if (cur.length) batches.push(cur);

  // 分段结果归集：index → { parts, received, error }
  const slots = new Map();
  const finishItem = (item, r) => {
    if (item.part === null) { results[item.index] = r; return; }
    let slot = slots.get(item.index);
    if (!slot) {
      slot = { parts: new Array(item.total).fill(null), received: 0, error: null };
      slots.set(item.index, slot);
    }
    if (r.ok) slot.parts[item.part] = r.translation;
    else slot.error = slot.error || r.error;
    slot.received++;
    if (slot.received === item.total) {
      // 按原文字符集选拼接符：CJK 硬切不留空格，西文按句切需要空格
      const joiner = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(texts[item.index]) ? '' : ' ';
      const joined = slot.parts.every(p => typeof p === 'string');
      results[item.index] = joined
        ? { ok: true, translation: slot.parts.join(joiner), from, to }
        : { ok: false, translation: null, error: slot.error || '分段翻译失败', from, to };
    }
  };

  // 子批并发（上限 3）：原实现逐批串行，N 个子批 = N 次 RTT
  await mapLimit(batches, 3, async (batch) => {
    try {
      const out = await withTimeout(
        requestBing(cfg, from, to, batch.map(b => b.text)), timeoutMs, 'bing-batch',
      );
      batch.forEach((item, k) => {
        const translated = out[k]?.translations?.[0]?.text;
        finishItem(item, translated
          ? { ok: true, translation: translated, from, to }
          : { ok: false, translation: null, error: 'Bing 返回结果为空', from, to });
      });
    } catch (err) {
      log.warn('[api-proxy] Bing 批量请求失败', err.message);
      batch.forEach(item => {
        finishItem(item, { ok: false, translation: null, error: err.message, from, to });
      });
    }
  });
  return results;
}

async function requestBing(cfg, from, to, payload) {
  const url = new URL(cfg.baseUrl);
  if (from && from !== 'auto') url.searchParams.set('from', mapBingLang(from));
  url.searchParams.set('to', mapBingLang(to));
  url.searchParams.set('isEnterpriseClient', 'false');

  const resp = await fetch(url.toString(), {
    method: 'POST',
    headers: { accept: '*/*', 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    credentials: 'omit',
  });
  if (!resp.ok) throw new Error(`Bing HTTP ${resp.status}`);

  const data = await resp.json();
  if (!Array.isArray(data) || data.length !== payload.length) {
    throw new Error(
      `Bing 返回数量不匹配（${Array.isArray(data) ? data.length : 'non-array'} ≠ ${payload.length}）`,
    );
  }
  return data;
}

/** 语言码映射：Bing 用 zh-Hans / zh-Hant */
function mapBingLang(code) {
  const map = { 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', zh: 'zh-Hans' };
  return map[code] || code;
}

// ---- Lingva Translate -------------------------------------------------------
// 接口：GET  /api/v1/{from}/{to}/{query}
// 响应：{ translation: "..." }
async function viaLingva(cfg, from, to, text) {
  const safeFrom = from === 'auto' ? 'auto' : from;
  // 修复：Lingva 用 Google 风格连字符语言码（zh-CN / zh-TW），
  // 原先把连字符转成下划线（zh_CN）会被服务端拒绝
  const safeTo = to;
  const url = `${cfg.baseUrl}/${safeFrom}/${safeTo}/${encodeURIComponent(text)}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
  });
  if (!resp.ok) throw new Error(`Lingva HTTP ${resp.status}`);
  const body = await resp.json();
  return body.translation || '';
}

// ---- Google 免费翻译 --------------------------------------------------------
// 接口：POST https://translate.googleapis.com/translate_a/t?client=gtx&dt=t&sl=en&tl=zh-CN
// 请求体：application/x-www-form-urlencoded  q={text}
// 响应：[["译文","原文"], ...]（多句时是分片数组）
// 说明：国内网络直连通常会超时，属于"能用则用"的备选。
async function viaGoogleFree(cfg, from, to, text) {
  const params = new URLSearchParams({
    client: 'gtx',
    dt: 't',
    sl: from || 'auto',
    tl: to,
  });
  const url = `${cfg.baseUrl}?${params.toString()}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: new URLSearchParams({ q: text }),
  });
  if (!resp.ok) throw new Error(`Google HTTP ${resp.status}`);

  const data = await resp.json();
  // 单句：[["译文","原文"]]；多句：[[...],[...]]；偶尔直接返回字符串数组
  const chunks = Array.isArray(data) ? data : [data];
  const translated = chunks
    .map(c => (Array.isArray(c) ? c[0] : c))
    .filter(s => typeof s === 'string' && s.length > 0)
    .join('');

  if (!translated) throw new Error('Google 返回为空');
  return translated;
}

// ---- MyMemory ---------------------------------------------------------------
// 接口：GET /get?q={text}&langpair={from}|{to}[&de={email}]
// 响应：{ responseData: { translatedText }, responseStatus: 200 }
//
// 三个必须处理的限制（实测）：
//   1. q 超过 500 字符会返回 responseStatus: 403 + "QUERY LENGTH LIMIT EXCEEDED"
//      → 这里按句子边界切块，逐块翻译再拼回去
//   2. 不支持 from=auto（会原样返回原文）
//      → 用文本字符集粗判源语言
//   3. 匿名额度有限，超额时 translatedText 里会出现 "MYMEMORY WARNING"
//      → 视为失败，交给上层展示错误
async function viaMyMemory(cfg, from, to, text) {
  const source = from === 'auto' ? guessSource(text) : from;
  const maxChars = cfg.maxChars || 450;
  const chunks = splitByLength(text, maxChars);

  // 切块并发翻译（上限 2：匿名接口有速率与每日额度限制，并发太高容易触发）
  const parts = await mapLimit(chunks, 2, async (chunk) => {
    let url = `${cfg.baseUrl}?q=${encodeURIComponent(chunk)}` +
      `&langpair=${encodeURIComponent(`${source}|${to}`)}`;
    if (cfg.email) url += `&de=${encodeURIComponent(cfg.email)}`;

    const resp = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`MyMemory HTTP ${resp.status}`);

    const data = await resp.json();
    const translated = data?.responseData?.translatedText;
    const status = Number(data?.responseStatus);

    if (!translated) throw new Error(`MyMemory 空响应（${data?.responseDetails || 'unknown'}）`);
    if (status !== 200 || /MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(translated)) {
      throw new Error(`MyMemory 失败：${translated}`);
    }
    return translated;
  });

  return parts.join(' ');
}

/** 极简源语言猜测（MyMemory 不支持 auto，只能自己判一下） */
function guessSource(text) {
  if (/[\u4e00-\u9fff]/.test(text)) return 'zh-CN';
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  // 拉丁语系粗判：先匹配各语言特有字符，再退回通用重音符
  if (/[ßäöü]/i.test(text)) return 'de';
  if (/[ñ¿¡]/.test(text)) return 'es';
  if (/[ãõ]/.test(text)) return 'pt';
  if (/[àâæçéèêëîïôùûüœ]/i.test(text)) return 'fr';
  return 'en';
}

/** 按长度切块，尽量切在句号/空格处，避免把句子劈断 */
function splitByLength(text, max) {
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;

  while (rest.length > max) {
    let cut = rest.lastIndexOf('. ', max);
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut < max * 0.2) cut = max;             // 找不到合适的切点就硬切
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

// ---- LibreTranslate --------------------------------------------------------
// 接口：POST /translate   body: { q, source, target, format, api_key }
async function viaLibre(cfg, from, to, text) {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/translate`;
  const body = {
    q: text,
    source: from === 'auto' ? 'auto' : from,
    target: to,
    format: 'text',
  };
  if (cfg.apiKey) body.api_key = cfg.apiKey;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`LibreTranslate HTTP ${resp.status}`);
  const data = await resp.json();
  return data.translatedText || '';
}
