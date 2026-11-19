/**
 * ============================================================================
 * shared/speech.mjs —— 单词朗读（content script 与 popup 共用）
 * ============================================================================
 * 两套播放方式，按优先级：
 *   1. 词典真人音频（dictionaryapi.dev / 有道 dictvoice 给的 mp3）
 *      —— 音质最好，但受页面 CSP 的 media-src 约束，可能被拦。
 *   2. 浏览器自带 speechSynthesis
 *      —— 不联网、不受页面 CSP 影响，是最终的兜底方案。
 *
 * 只用于单个英文单词的朗读；句子朗读也走 speak()。
 * ============================================================================
 */

let currentAudio = null;

/** 用系统语音朗读（零网络，兜底方案） */
export function speak(text, lang = 'en-US') {
  try {
    if (!('speechSynthesis' in window)) return false;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang;
    u.rate = 0.95;
    window.speechSynthesis.speak(u);
    return true;
  } catch {
    return false;
  }
}

/**
 * 播放单词发音：优先真人音频，失败自动退回系统语音。
 * audioUrl 为空时直接用系统语音。
 */
export function playWord(word, audioUrl, lang = 'en-US') {
  if (audioUrl) {
    try {
      if (currentAudio) {
        currentAudio.pause();
        currentAudio = null;
      }
      const audio = new Audio(audioUrl);
      currentAudio = audio;
      // 页面 CSP 拦截 / 网络失败时 play() 会 reject，这里兜底到系统语音
      audio.play().catch(() => speak(word, lang));
      return;
    } catch {
      // 构造 Audio 就失败（极少见），继续走 speak
    }
  }
  speak(word, lang);
}
