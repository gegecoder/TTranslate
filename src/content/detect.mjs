/**
 * ============================================================================
 * content/detect.mjs —— 语言检测
 * ============================================================================
 * 使用"字符集启发 + 页面 <html lang> 兜底"的极简链，覆盖 90% 的场景，理解了这套思路再扩也容易。
 * ============================================================================
 */

/**
 * 极简启发：CJK 字符 → 中日韩；拉丁字母 → 英/法/德/西/俄（区分靠 Cyrillic）
 * 其他情况回退到页面 <html lang>。
 */
export function detectLanguage(text) {
  if (!text) return document.documentElement.lang || 'en';

  // CJK 占比先于页面声明：大量站点 lang="en" 但正文是中文，
  // 盲信 <html lang> 会把源语言判错（MyMemory 这类不支持 auto 的服务直接受害）。
  if (cjkRatioOf(text) > 0.3) {
    // 含假名/谚文优先判日/韩，否则按简繁处理
    if (/[\u3040-\u30ff]/.test(text)) return 'ja';
    if (/[\uac00-\ud7af]/.test(text)) return 'ko';
    if (/[\u3100-\u312f]/.test(text)) return 'zh-TW';
    return 'zh-CN';
  }

  // 优先信页面声明
  const htmlLang = document.documentElement.lang?.toLowerCase();
  if (htmlLang) {
    // zh-cn / zh-tw / ja / ko 这些可以直接信
    if (/^(zh|ja|ko|en|fr|de|es|ru)/.test(htmlLang)) return htmlLang;
  }

  // 汉字
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(text)) {
    // 繁体 vs 简体靠 Bopomofo / 简化字判断——简化：没有注音符号就是简体
    if (/[\u3100-\u312f]/.test(text)) return 'zh-TW';
    return 'zh-CN';
  }
  // 假名
  if (/[\u3040-\u30ff]/.test(text)) return 'ja';
  // 谚文
  if (/[\uac00-\ud7af]/.test(text)) return 'ko';
  // 西里尔
  if (/[\u0400-\u04ff]/.test(text)) return 'ru';
  // 拉丁（英语）——更精确的检测需要字典/双字母组，直接 en
  if (/[A-Za-z\u00c0-\u024f]/.test(text)) return 'en';

  return htmlLang || 'auto';
}

/** CJK 字符占"字母类字符"的比例。分母只统计字母类，避免标点/空格稀释占比 */
function cjkRatioOf(text) {
  const han = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) || []).length;
  if (!han) return 0;
  const letters = (text.match(
    /[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af\u0400-\u04ffA-Za-z\u00c0-\u024f]/g,
  ) || []).length;
  return letters ? han / letters : 0;
}
