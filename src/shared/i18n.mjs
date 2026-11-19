/**
 * ============================================================================
 * shared/i18n.mjs —— 扩展界面多语言
 * ============================================================================
 * 词条内嵌在本模块中（key → { zh, en }），key 统一使用英文语义键。
 * - 动态文案：直接调 t(key, vars)。
 * - 静态 HTML（popup）：与官网一致，以中文为原文，
 *   applyStaticI18n() 收集文本节点后按「中文原文 → key」反查，
 *   因此不必给每个节点挂 data-i18n。切回中文时恢复原文。
 * 界面语言存于 config.uiLanguage（auto | zh | en），各上下文通过
 * setUiLang() 设置本模块内的当前语言。
 * ============================================================================
 */

// ---- 词条表 ----------------------------------------------------------------
const MESSAGES = {
  // —— popup 静态文本 ——
  'popup.tab.page':            { zh: '网页翻译', en: 'Web Page' },
  'popup.tab.text':            { zh: '普通翻译', en: 'Text' },
  'popup.tab.settings':        { zh: '设置', en: 'Settings' },
  'popup.tab.about':           { zh: '关于', en: 'About' },
  'popup.about.curVersion':    { zh: '当前版本', en: 'Current version' },
  'popup.about.authorLabel':   { zh: '作者', en: 'Author' },
  'popup.about.authorBlog':    { zh: '作者博客', en: 'Author blog' },
  'popup.about.open':          { zh: '打开', en: 'Open' },
  'popup.about.checkUpdate':   { zh: '检测更新', en: 'Check for updates' },
  'popup.about.checking':      { zh: '正在检测更新…', en: 'Checking for updates…' },
  'popup.about.upToDate':      { zh: '已是最新版本', en: 'You are on the latest version' },
  'popup.about.newVersion':    { zh: '发现新版本 v{ver}，请前往发布页下载', en: 'New version v{ver} available — see the release page' },
  'popup.about.checkFail':     { zh: '检测失败：{err}', en: 'Check failed: {err}' },
  'popup.about.noApi':         { zh: '未配置更新接口地址', en: 'Update API URL is not configured' },
  'popup.about.releasePage':   { zh: '前往下载', en: 'Download' },
  'popup.about.donateTitle':   { zh: '打赏支持', en: 'Donate' },
  'popup.about.donateTip':     { zh: '如果这个扩展对你有帮助，欢迎请作者喝杯咖啡。', en: 'If this extension helps you, consider buying the author a coffee.' },
  'popup.about.donateMissing': { zh: '未找到打赏图片（public/donate.png）', en: 'Donate image not found (public/donate.png)' },
  'popup.pin.title':           { zh: '固定显示（独立窗口）', en: 'Pin (separate window)' },
  'popup.pin.aria':            { zh: '固定显示', en: 'Pin panel' },
  'popup.page.auto':           { zh: '自动翻译网页', en: 'Auto-translate pages' },
  'popup.page.autoHint':       { zh: '开启后，每打开一个网页都会自动翻译', en: 'When on, every page you open is translated automatically' },
  'popup.page.translate':      { zh: '翻译', en: 'Translate' },
  'popup.page.langSource':     { zh: '源语言', en: 'Source' },
  'popup.page.langTarget':     { zh: '目标语言', en: 'Target' },
  'popup.page.langHint':       { zh: '只作用于网页翻译，与普通翻译独立', en: 'Applies to page translation only; independent from text translation' },
  'popup.page.mode':           { zh: '显示模式', en: 'Display mode' },
  'popup.page.mode.dual':      { zh: '双语对照', en: 'Bilingual' },
  'popup.page.mode.hover':     { zh: '悬停展开', en: 'Expand on hover' },
  'popup.page.mode.hoverTip':  { zh: '悬停浮层', en: 'Hover popup' },
  'popup.page.mode.click':     { zh: '点击展开', en: 'Click to reveal' },
  'popup.page.mode.replaceHover': { zh: '原处替换 + 悬停看原文', en: 'In-place, hover for source' },
  'popup.page.mode.sideBySide': { zh: '左右对照', en: 'Side by side' },
  'popup.page.mode.sentence':  { zh: '句级交错', en: 'Sentence interleave' },
  'popup.page.mode.replace':   { zh: '原处替换', en: 'In-place' },
  'popup.page.modeHint':       { zh: '快捷键 Alt+Shift+T 可在常用模式间轮转', en: 'Alt+Shift+T cycles through the common modes' },
  'popup.page.theme':          { zh: '显示主题', en: 'Display theme' },
  'popup.page.theme.none':     { zh: '纯文本', en: 'plain text' },
  'popup.page.theme.dashed':   { zh: '虚线下划线', en: 'Dashed underline' },
  'popup.page.theme.underline': { zh: '实线强调', en: 'Solid underline' },
  'popup.page.theme.wavy':     { zh: '波浪下划线', en: 'Wavy underline' },
  'popup.page.theme.blockquote': { zh: '引用块样式', en: 'Blockquote style' },
  'popup.page.theme.card':     { zh: '卡片投影', en: 'Card with shadow' },
  'popup.page.theme.glass':    { zh: '半透明毛玻璃', en: 'Frosted glass' },
  'popup.page.theme.marker':   { zh: '荧光笔', en: 'Highlighter' },
  'popup.page.themeColor':     { zh: '颜色配置', en: 'Decoration color' },
  'popup.page.themeColor.red':    { zh: '红色', en: 'Red' },
  'popup.page.themeColor.orange': { zh: '橙色', en: 'Orange' },
  'popup.page.themeColor.yellow': { zh: '黄色', en: 'Yellow' },
  'popup.page.themeColor.green':  { zh: '绿色', en: 'Green' },
  'popup.page.themeColor.blue':    { zh: '浅蓝', en: 'Light blue' },
  'popup.page.themeColor.defaultBlue': { zh: '蓝色', en: 'Blue' },
  'popup.page.themeColor.purple': { zh: '紫色', en: 'Purple' },
  'popup.page.themeColor.pink':   { zh: '粉色', en: 'Pink' },
  'popup.page.themeColor.custom': { zh: '自定义', en: 'Custom' },
  'popup.page.fontScale':      { zh: '译文字号', en: 'Translation font size' },
  'popup.page.fontScale.small': { zh: '小', en: 'Small' },
  'popup.page.fontScale.medium': { zh: '中', en: 'Medium' },
  'popup.page.fontScale.match': { zh: '与原文一致', en: 'Same as original' },
  'popup.page.fontScale.large': { zh: '大', en: 'Large' },
  'popup.page.textColor':      { zh: '译文颜色', en: 'Translation color' },
  'popup.page.textColor.light': { zh: '亮色', en: 'Light' },
  'popup.page.textColor.dark': { zh: '暗色', en: 'Dark' },
  'popup.page.textColor.red':  { zh: '红色', en: 'Red' },
  'popup.page.textColor.orange': { zh: '橙色', en: 'Orange' },
  'popup.page.textColor.yellow': { zh: '黄色', en: 'Yellow' },
  'popup.page.textColor.green': { zh: '绿色', en: 'Green' },
  'popup.page.textColor.blue': { zh: '蓝色', en: 'Blue' },
  'popup.page.textColor.purple': { zh: '紫色', en: 'Purple' },
  'popup.page.textColor.pink': { zh: '粉色', en: 'Pink' },
  'popup.page.textColor.custom': { zh: '自定义', en: 'Custom' },
  'popup.page.ignoreTitle':    { zh: '翻译忽略', en: 'Skip translation' },
  'popup.page.ignoreEnabled':  { zh: '启用 Alt + 点击忽略', en: 'Enable Alt+click to skip' },
  'popup.page.ignoreHint':     { zh: 'Alt + 点击页面段落可忽略该段翻译，再次 Alt + 点击同一段即可恢复', en: 'Alt+click a paragraph to skip it; Alt+click it again to restore' },
  'popup.page.position':       { zh: '译文位置', en: 'Translation position' },
  'popup.page.position.after': { zh: '原文之后', en: 'After original' },
  'popup.page.position.before': { zh: '原文之前', en: 'Before original' },
  'popup.page.footer':         { zh: '通用设置，请到「设置」中配置', en: 'General settings are under "Settings".' },
  'popup.text.input':          { zh: '要翻译的文本', en: 'Text to translate' },
  'popup.text.placeholder':    { zh: '在这里输入或粘贴文本，Ctrl+Enter 翻译', en: 'Type or paste text here; Ctrl+Enter to translate' },
  'popup.text.translate':      { zh: '翻译文本', en: 'Translate' },
  'popup.text.footer':         { zh: '普通翻译与网页翻译使用各自独立的语言设置。', en: 'Text translation and page translation use independent language settings.' },
  'popup.settings.service':    { zh: '翻译服务', en: 'Translation service' },
  'popup.settings.test':       { zh: '测试当前服务', en: 'Test current service' },
  'popup.settings.uiLang':     { zh: '界面语言', en: 'Interface language' },
  'popup.settings.uiLang.auto': { zh: '跟随浏览器', en: 'Follow browser' },
  'popup.settings.uiTheme':    { zh: '界面主题', en: 'Appearance theme' },
  'popup.settings.theme.light': { zh: '亮色', en: 'Light' },
  'popup.settings.theme.dark': { zh: '暗色', en: 'Dark' },
  'popup.settings.theme.red':  { zh: '红色', en: 'Red' },
  'popup.settings.theme.orange': { zh: '橙色', en: 'Orange' },
  'popup.settings.theme.yellow': { zh: '黄色', en: 'Yellow' },
  'popup.settings.theme.green': { zh: '绿色', en: 'Green' },
  'popup.settings.theme.blue': { zh: '蓝色', en: 'Blue' },
  'popup.settings.theme.purple': { zh: '紫色', en: 'Purple' },
  'popup.settings.theme.pink': { zh: '粉色', en: 'Pink' },
  'popup.settings.theme.custom': { zh: '自定义', en: 'Custom' },
  'popup.settings.themeAlpha': { zh: '组件透明度', en: 'Component opacity' },
  'popup.settings.themeImageAlpha': { zh: '背景图透明度', en: 'Background image opacity' },
  'popup.settings.themeTextColor': { zh: '文字颜色', en: 'Text color' },
  'popup.settings.themeImage': { zh: '自定义背景图片', en: 'Custom background image' },
  'popup.settings.themeImageClear': { zh: '清除图片', en: 'Clear image' },
  'popup.settings.themeImageHint': { zh: '选择本地图片作为弹窗背景，会自动压缩后保存在本机。', en: 'Pick a local image as the popup background. It is compressed and stored locally.' },
  'popup.settings.selection':  { zh: '划词翻译', en: 'Selection translation' },
  'popup.settings.selectionHint': { zh: '选中网页上的文本后触发翻译，默认关闭', en: 'Translate selected text on pages' },
  'popup.settings.selectionMode': { zh: '展示方式', en: 'Show as' },
  'popup.settings.selectionMode.direct': { zh: '直接显示译文浮层', en: 'Show translation panel directly' },
  'popup.settings.selectionMode.icon': { zh: '显示图标，点击后翻译', en: 'Show icon; click to translate' },
  'popup.settings.dictProvider': { zh: '音标与发音服务', en: 'Phonetic / speech service' },
  'popup.settings.protectTerms': { zh: '专有名词保护', en: 'Protect proper nouns' },
  'popup.terms.enabled':       { zh: '启用专有名词保护', en: 'Enable term protection' },
  'popup.terms.template':      { zh: '内置模板', en: 'Built-in template' },
  'popup.terms.tpl.general':   { zh: '计算机通用', en: 'General computing' },
  'popup.terms.tpl.frontend':  { zh: '前端开发', en: 'Frontend' },
  'popup.terms.tpl.backend':   { zh: '后端与运维', en: 'Backend & ops' },
  'popup.terms.tpl.mobile':    { zh: '移动端开发', en: 'Mobile' },
  'popup.terms.tpl.ai':        { zh: '人工智能', en: 'AI' },
  'popup.terms.tpl.medical':   { zh: '医疗健康', en: 'Healthcare' },
  'popup.terms.tpl.finance':   { zh: '金融财经', en: 'Finance' },
  'popup.terms.tpl.legal':     { zh: '法律合规', en: 'Legal & compliance' },
  'popup.terms.tpl.academic':  { zh: '学术科研', en: 'Academia' },
  'popup.terms.tpl.marketing': { zh: '市场营销', en: 'Marketing' },
  'popup.terms.tpl.custom':    { zh: '自定义', en: 'Custom' },
  'popup.terms.list':          { zh: '关键词（以 | 分隔）', en: 'Keywords (separated by |)' },
  'popup.terms.placeholder':   { zh: '例如：Spring|Chrome|Kubernetes', en: 'e.g. Spring|Chrome|Kubernetes' },
  'popup.terms.apply':         { zh: '应用', en: 'Apply' },
  'popup.terms.hint':          { zh: '切换模板会自动写入下方关键词；选「自定义」则保留当前词表自行编辑；「还原」恢复计算机通用模板。品牌与技术名词不送翻译，避免直译。', en: 'Switching templates fills the keywords below automatically. Choose Custom to keep your current list and edit it freely. Restore resets to the general computing template. Brand and tech terms stay untranslated.' },
  'popup.settings.dictProvider.auto': { zh: '自动适配（默认）', en: 'Auto (default)' },
  'popup.settings.dictProvider.youdao': { zh: '有道词典', en: 'Youdao Dictionary' },
  'popup.settings.dictPhonetic': { zh: '显示音标', en: 'Show phonetics' },
  'popup.settings.dictSpeak':  { zh: '显示朗读按钮', en: 'Show speak button' },
  'popup.settings.dictHint':   { zh: '只对单个英文单词生效，句子不显示；划词翻译与普通翻译共用。「自动适配」会优先有道、失败时自动切换 Free Dictionary API。', en: 'Only for single English words, not sentences; shared by selection and text translation. "Auto" tries Youdao first, then falls back to Free Dictionary API.' },
  'popup.settings.debugTitle': { zh: '调试信息', en: 'Debug info' },
  'popup.settings.debugCopied': { zh: '调试信息已复制到剪贴板', en: 'Debug info copied to clipboard' },
  'popup.settings.debugManual': { zh: '复制失败，请手动选中复制', en: 'Copy failed — select and copy manually' },
  'popup.settings.debugEmpty':  { zh: '暂无内容可复制', en: 'Nothing to copy yet' },
  'popup.settings.footer':     { zh: '配置自动保存，页面内会实时生效。', en: 'Settings save automatically and apply to pages instantly.' },

  // —— popup 动态文案 ——
  'popup.page.restore':        { zh: '还原', en: 'Restore' },
  'popup.page.translating':    { zh: '翻译中…', en: 'Translating…' },
  'popup.page.translatingProgress': { zh: '翻译中 {done}/{total}', en: 'Translating {done}/{total}' },
  'popup.page.connecting':     { zh: '正在连接页面…', en: 'Connecting to page…' },
  'popup.page.noTab':          { zh: '找不到当前标签页', en: 'Cannot find the active tab' },
  'popup.page.cannotEnable':   { zh: '无法在该页面启用翻译：{msg}', en: 'Cannot enable translation on this page: {msg}' },
  'popup.page.noResponse':     { zh: '页面无响应：{msg}', en: 'Page not responding: {msg}' },
  'popup.page.refreshRetry':   { zh: '请刷新页面后重试', en: 'refresh the page and retry' },
  'popup.page.done':           { zh: '翻译完成：共 {n} 段', en: 'Done: {n} segments translated' },
  'popup.page.empty':          { zh: '未找到可翻译的内容（页面结构特殊或已跳过该站点）', en: 'Nothing translatable found (unusual page structure or site skipped)' },
  'popup.pin.unpinTitle':      { zh: '取消固定（关闭窗口）', en: 'Unpin (close window)' },
  'popup.text.empty':          { zh: '请先输入要翻译的文本', en: 'Please enter text to translate first' },
  'popup.settings.testing':    { zh: '测试中…', en: 'Testing…' },
  'popup.settings.testOk':     { zh: '接口正常：{text}', en: 'OK: {text}' },
  'popup.settings.testFail':   { zh: '接口失败：{err}', en: 'Failed: {err}' },

  // —— 通用（popup 与划词浮层共用） ——
  'common.noTranslation':      { zh: '(无译文)', en: '(No translation)' },
  'common.offline':            { zh: '网络未连接，请检查网络后重试', en: 'Offline. Check your connection and retry.' },
  'common.translateFailed':    { zh: '翻译失败：{err}', en: 'Translation failed: {err}' },
  'common.requestError':       { zh: '请求异常：{err}', en: 'Request error: {err}' },
  'common.unknownError':       { zh: '未知错误', en: 'Unknown error' },
  'common.phoneticLoading':    { zh: '音标查询中…', en: 'Looking up phonetics…' },
  'common.copySource':         { zh: '复制原文', en: 'Copy source' },
  'common.copyTranslation':    { zh: '复制译文', en: 'Copy translation' },
  'common.copy':               { zh: '复制', en: 'Copy' },
  'common.clear':              { zh: '清空', en: 'Clear' },
  'common.copied':             { zh: '已复制', en: 'Copied' },
  'common.pressCtrlC':         { zh: '请按 Ctrl+C', en: 'Press Ctrl+C' },
  'common.speakTip':           { zh: '朗读{region}发音', en: 'Play {region} pronunciation' },
  'common.speakTipNoRegion':   { zh: '朗读发音', en: 'Play pronunciation' },

  // —— 划词翻译浮层 ——
  'overlay.iconTip':           { zh: '翻译选中的文本（TTranslate）', en: 'Translate selected text (TTranslate)' },
  'overlay.pinTip':            { zh: '固定面板（开启后不会被外部点击/滚动关闭）', en: 'Pin panel (won\'t close on outside click or scroll)' },
  'overlay.close':             { zh: '关闭', en: 'Close' },
  'overlay.placeholder':       { zh: '输入或粘贴要翻译的文本…', en: 'Type or paste text to translate…' },
  'overlay.noResult':          { zh: '翻译服务没有返回结果', en: 'The translation service returned nothing' },

  // —— 右键菜单 ——
  'contextMenu.toggle':        { zh: '翻译此页面（Alt+T）', en: 'Translate this page (Alt+T)' },
};

// ---- 当前语言状态（每个 JS 上下文各持一份） ----------------------------------
let currentLang = 'zh';

/** 把配置值（auto|zh|en）解析成实际语言 */
export function resolveUiLang(setting) {
  if (setting === 'zh' || setting === 'en') return setting;
  const nav = String(typeof navigator !== 'undefined' ? navigator.language : 'zh').toLowerCase();
  return nav.indexOf('zh') === 0 ? 'zh' : 'en';
}

/** 设置当前界面的语言（lang 为已解析的 'zh' | 'en'） */
export function setUiLang(lang) {
  currentLang = lang === 'en' ? 'en' : 'zh';
}

export function getUiLang() {
  return currentLang;
}

/**
 * 取词条，例如 t('popup.page.translate')；缺失时回退中文，再退化为 key 本身。
 * vars 形如 { n: 3 }，替换文案里的 {n} 占位。
 */
export function t(key, vars) {
  const item = MESSAGES[key];
  let text = item ? (item[currentLang] ?? item.zh) : key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      text = text.replaceAll(`{${k}}`, String(v));
    }
  }
  return text;
}

/** 音标区域标签本地化：'英'/'美' → 'UK'/'US'（英文界面） */
export function regionLabel(region) {
  if (!region) return '';
  if (currentLang === 'en') return region === '英' ? 'UK' : region === '美' ? 'US' : region;
  return region;
}

/** 语言名本地化（翻译语言下拉的选项文案） */
export function langLabel(l) {
  return currentLang === 'en' ? (l.labelEn || l.label) : l.label;
}

/** 服务名本地化 */
export function serviceName(svc) {
  return currentLang === 'en' ? (svc.nameEn || svc.name) : svc.name;
}

// ---- 静态 DOM 应用（根目录 index.html 同款「中文原文 → key」反查） --------------
const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEXTAREA)$/;
const ZH_TO_KEY = {};   // 归一化中文原文 → key
let textNodes = [];     // { node, lead, tail, raw, key }
let attrNodes = [];     // { el, attr, raw, key }
let collected = false;

for (const [key, item] of Object.entries(MESSAGES)) {
  if (item.zh && !ZH_TO_KEY[normalize(item.zh)]) ZH_TO_KEY[normalize(item.zh)] = key;
}

function normalize(raw) {
  return raw.replace(/\s+/g, ' ').trim();
}

/** 收集 root 下所有命中词条的文本节点与 title/placeholder/aria-label 属性（只做一次） */
export function collectStaticI18n(root = document.body) {
  if (collected) return;
  collected = true;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (!node.parentNode || SKIP.test(node.parentNode.nodeName)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    const raw = node.nodeValue;
    const m = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const key = ZH_TO_KEY[normalize(m[2])];
    if (!key) continue;
    textNodes.push({ node, lead: m[1], tail: m[3], raw, key });
  }

  root.querySelectorAll('[title], [placeholder], [aria-label]').forEach((el) => {
    for (const attr of ['title', 'placeholder', 'aria-label']) {
      const raw = el.getAttribute(attr);
      if (!raw) continue;
      const key = ZH_TO_KEY[normalize(raw)];
      if (key) attrNodes.push({ el, attr, raw, key });
    }
  });
}

/** 应用界面语言到已收集的静态节点（并更新 <html lang>） */
export function applyStaticI18n() {
  const isEn = currentLang === 'en';
  for (const item of textNodes) {
    const value = isEn ? t(item.key) : null;
    node_setValue(item, value);
  }
  for (const item of attrNodes) {
    item.el.setAttribute(item.attr, isEn ? t(item.key) : item.raw);
  }
  document.documentElement.lang = isEn ? 'en' : 'zh-CN';
}

function node_setValue(item, value) {
  item.node.nodeValue = value != null ? item.lead + value + item.tail : item.raw;
}
