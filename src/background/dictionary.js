/**
 * ============================================================================
 * background/dictionary.js —— 单词音标查询
 * ============================================================================
 * 只服务"单个英文单词"，句子直接跳过（skipped: true）。
 * 两个免费、无需 key 的数据源（优先有道，音标口径更准）：
 *   1. 有道词典 jsonapi —— 中英词典口径，同时给英/美音标，但**没有 CORS 头**，
 *      所以必须经后台 fetch（正好符合本项目"后台统一出网"的架构）。
 *      simple.word[0] = { ukphone, usphone, ukspeech, usspeech }
 *   2. dictionaryapi.dev —— 正规免费接口，带 CORS，返回音标 + 真人音频地址。
 *      实测：GET /api/v2/entries/en/hello → phonetics[].text / .audio
 *
 * 音频地址：
 *   dictionaryapi.dev 直接给 mp3；
 *   有道用 https://dict.youdao.com/dictvoice?audio=<word>&type=1(英)/2(美)
 *
 * 缓存：进程内 Map（24h）+ chrome.storage（跨 service worker 重启）。
 * ============================================================================
 */

import { log } from '../shared/constants.mjs';
import * as storage from './storage.js';

const TTL = 24 * 60 * 60 * 1000;   // 词条缓存 24 小时
const MEMO = new Map();             // word(lowercase) -> { at, value }

/** 单个英文单词：允许连字符和撇号（don't / well-known） */
const WORD_RE = /^[A-Za-z][A-Za-z'’-]{0,29}$/;

/** 判断是否是"值得查音标的单个单词" */
export function isSingleWord(text) {
  return WORD_RE.test((text || '').trim());
}

/**
 * 查询单词音标。
 * 返回 { ok, word, phonetics: [{ region, text, audio }], source }
 * 失败返回 { ok:false, error }，调用方静默降级即可。
 */
export async function lookupWord(raw, provider = 'auto') {
  const word = (raw || '').trim();
  if (!isSingleWord(word)) return { ok: true, skipped: true };

  // provider 由用户在设置里选择；auto = 有道优先、失败自动切换
  const source = ['auto', 'youdao', 'dictionaryapi'].includes(provider) ? provider : 'auto';
  const key = `dict|${source}|${word.toLowerCase()}`;

  // 1) 进程内缓存
  const hit = MEMO.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  // 2) storage 缓存（SW 被回收后仍然生效）
  try {
    const cached = await storage.getCache(key);
    if (cached?.entry) {
      const value = { ok: true, ...cached.entry };
      MEMO.set(key, { at: Number(cached.at) || Date.now(), value });
      return value;
    }
  } catch { /* 缓存失败不影响查询 */ }

  // 3) 联网查询：按用户选择的服务执行；auto 时先有道、失败再切 dictionaryapi
  const candidates = source === 'youdao'
    ? [['youdao', fromYoudao]]
    : source === 'dictionaryapi'
      ? [['dictionaryapi', fromDictionaryApi]]
      : [['youdao', fromYoudao], ['dictionaryapi', fromDictionaryApi]];

  let entry = null;
  for (const [name, fn] of candidates) {
    try {
      entry = await fn(word);
    } catch (err) {
      log.warn(`[dict] ${name} 失败`, err.message);
    }
    if (entry) break;
  }

  if (!entry) return { ok: false, error: '未找到该单词的音标' };

  const value = { ok: true, ...entry };
  MEMO.set(key, { at: Date.now(), value });
  // 异步写回 storage，不阻塞返回
  storage.putCache({ [key]: { at: Date.now(), entry } }).catch(() => {});
  return value;
}

// ---- 数据源 2：dictionaryapi.dev（兜底）------------------------------------

async function fromDictionaryApi(word) {
  const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
  const resp = await fetch(url, { credentials: 'omit' });
  if (!resp.ok) return null;

  const data = await resp.json();
  const entry = Array.isArray(data) ? data[0] : null;
  if (!entry) return null;

  const list = Array.isArray(entry.phonetics) ? entry.phonetics : [];
  const pick = (tag) => list.find(p => p.audio && p.audio.toLowerCase().includes(tag));

  const uk = pick('-uk');
  const us = pick('-us');

  const phonetics = [];
  if (uk?.text) phonetics.push({ region: '英', text: uk.text, audio: uk.audio || '' });
  if (us?.text) phonetics.push({ region: '美', text: us.text, audio: us.audio || '' });

  // 只找到一种口音时，把另一个音标补上（不带口音标签，不瞎猜）
  if (phonetics.length === 1) {
    const rest = list.find(p => p.text && p.text !== uk?.text && p.text !== us?.text);
    if (rest) phonetics.push({ region: '', text: rest.text, audio: rest.audio || '' });
  }

  // 没有区分英/美口音时，用顶层 phonetic 兜底
  if (!phonetics.length) {
    const text = entry.phonetic || list.find(p => p.text)?.text;
    if (text) {
      phonetics.push({ region: '', text, audio: list.find(p => p.audio)?.audio || '' });
    }
  }
  if (!phonetics.length) return null;

  return { word: entry.word || word, phonetics, source: 'dictionaryapi.dev' };
}

// ---- 数据源 1：有道词典（优先）---------------------------------------------

async function fromYoudao(word) {
  const url = `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(word)}`;
  const resp = await fetch(url, { credentials: 'omit', headers: { accept: 'application/json' } });
  if (!resp.ok) return null;

  const data = await resp.json();
  const w = data?.simple?.word?.[0];
  if (!w) return null;

  const wrap = (p) => (p.startsWith('/') ? p : `/${p}/`);
  const voice = (type) =>
    `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=${type}`;

  const phonetics = [];
  if (w.ukphone) phonetics.push({ region: '英', text: wrap(w.ukphone), audio: voice(1) });
  if (w.usphone) phonetics.push({ region: '美', text: wrap(w.usphone), audio: voice(2) });

  if (!phonetics.length) {
    // 少数词条音标在 ec 分支里
    const ec = data?.ec?.word?.[0];
    const p = ec?.ukphone || ec?.usphone;
    if (p) phonetics.push({ region: '', text: wrap(p), audio: voice(2) });
  }
  if (!phonetics.length) return null;

  return { word, phonetics, source: 'youdao' };
}
