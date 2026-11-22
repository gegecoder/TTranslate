/**
 * ============================================================================
 * constants.mjs —— 全扩展共享常量
 * ============================================================================
 * 所有标记名、消息类型、存储 key、CSS class 集中在此，
 * 避免魔法字符串散落各处。修改此文件不会影响其他模块的调用方式。
 * 注意：`log` 也定义在这里而不是 utils.mjs，避免 ESM re-export 链脆弱性
 * （MV3 service worker 的模块解析很严格，re-export 环节任何异常都会让下游看到"模块没导出 XXX"的 generic 报错）。
 * ============================================================================
 */

// ---- 日志 ------------------------------------------------------------------
// 除了打印到控制台，还保留一份内存环形缓冲：
// popup 里的"调试信息"按钮会把它取出来，方便用户直接复制发给我们。
const LOG_BUFFER = [];
// 调试区容量：最近 5000 行 / 10 万字符，超出后从最早的一条开始丢弃
const MAX_LOGS = 5000;
const MAX_LOG_CHARS = 100000;
// 单条日志最多保留的字符数，避免一条超长输出挤掉整段历史
const MAX_LOG_MSG_CHARS = 4000;
let LOG_CHARS = 0;

/**
 * 抹掉日志里的 base64 图片等超长内容。
 * 划词浮层的主题配置里带背景图 dataURL，直接打印会让调试区卡死。
 */
export function redactDataUrls(str) {
  return String(str ?? '')
    // data:image/jpeg;base64,xxxx…
    .replace(/data:([\w.+-]+\/[\w.+-]+);base64,[A-Za-z0-9+/=]{64,}/g, (m, mime) => `data:${mime};base64,<omitted>`)
    // 裸 base64 长串（通常是 dataURL 漏出来的或截图 base64）
    .replace(/[A-Za-z0-9+/]{500,}={0,2}/g, '<base64 omitted>');
}

/** 写一条日志。会自动脱敏 + 截断单条长度 + 环形丢弃旧记录。 */
function pushLog(level, args) {
  try {
    const msg = redactDataUrls(
      args.map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        try { return JSON.stringify(a); } catch { return String(a); }
      }).join(' ')
    ).slice(0, MAX_LOG_MSG_CHARS);

    LOG_BUFFER.push({ t: new Date().toTimeString().slice(0, 8), level, msg });
    LOG_CHARS += msg.length;
    // 环形丢弃：超量就从头丢
    while (LOG_BUFFER.length > MAX_LOGS || LOG_CHARS > MAX_LOG_CHARS) {
      const old = LOG_BUFFER.shift();
      if (!old) break;
      LOG_CHARS -= old.msg.length;
    }
  } catch { /* 日志自身出错就静默 */ }
}

// 构建模式：build.mjs 编译期用 esbuild define 把 __TMT_BUILD_MODE__ 替换成
// 'dev' 或 'prod'。fallback 默认 'prod'——如果构建 define 遗漏，
// 生产环境绝不会意外跑成 dev 模式（关掉所有 console.debug/warn 和日志缓冲写入）。
export const BUILD_MODE = typeof __TMT_BUILD_MODE__ !== 'undefined' ? __TMT_BUILD_MODE__ : 'prod';
const IS_DEV = BUILD_MODE !== 'prod';

// 日志工具：生产模式完全关闭（空函数），开发模式同时打印 + 写缓冲
export const log = IS_DEV
  ? {
      enabled: true,
      debug: (...args) => { pushLog('debug', args); console.debug('[TTranslate]', ...args); },
      info:  (...args) => { pushLog('info',  args); console.info('[TTranslate]', ...args); },
      warn:  (...args) => { pushLog('warn',  args); console.warn('[TTranslate]', ...args); },
      error: (...args) => { pushLog('error', args); console.error('[TTranslate]', ...args); },
      dump:  () => LOG_BUFFER.map(e => `[${e.t}] ${e.level.toUpperCase()} ${e.msg}`),
      clear: () => { LOG_BUFFER.length = 0; LOG_CHARS = 0; },
    }
  : {
      enabled: false,
      debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
      dump: () => [], clear: () => {},
    };

// ---- 标记名 / 属性名 --------------------------------------------------------
export const MARK = {
  PARAGRAPH:          'data-tmt-p',          // 段落标记
  WALKED:             'data-tmt-walked',     // 已遍历节点标记
  WALKED_PROP:        '__tmt_walked',        // 已遍历节点 symbol
  ATOMIC_BLOCK:       'data-tmt-atomic',     // 原子块（code/pre 等不拆的块）
  TARGET_WRAPPER:     'tmt-target-wrapper',  // 译文块的直接 wrapper class
  TRANSLATION_BLOCK_WRAPPER: 'tmt-block-wrapper',
  INLINE_WRAPPER:     'tmt-inline-wrapper',
  PRE_WHITESPACE:     'tmt-pre-whitespace',
  STATE:              'data-tmt-state',       // 当前显示模式（none/dual/replace…）
  LOADING_ID:         'data-tmt-loading',
  ERROR_ID:           'data-tmt-error',
  ROOT_PROP:          '__tmt_root',
  PARAGRAPH_PROP:     '__tmt_paragraph',
};

/**
 * 统一的内联 SVG 图标库（stroke 用 currentColor，跟随按钮文字颜色）。
 * popup 与划词浮层共用，避免一处用 emoji、一处用字符导致风格不一致。
 */
export const ICONS = {
  speaker: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.6 8.4a5 5 0 0 1 0 7.2"/><path d="M18.4 5.6a9 9 0 0 1 0 12.8"/></svg>',
  copy: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>',
  close: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

// ---- 消息类型 --------------------------------------------------------------
export const MSG = {
  GET_CONFIG:       'getConfig',
  GET_PROGRESS:     'getProgress',
  GET_LOGS:         'getLogs',
  CLEAR_LOGS:       'clearLogs',
  TRANSLATE_BATCH:  'translateBatch',
  GET_WORD_INFO:    'getWordInfo',
  REPORT:           'report',
  SET_PAGE_STATUS:  'setPageStatus',
  TOGGLE_PAGE:      'togglePage',
  TRANSLATE_PAGE:   'translatePage',
  RESTORE_PAGE:     'restorePage',
  UPDATE_CONFIG:    'updateConfig',
  GET_BADGE_STATE:  'getBadgeState',
  SET_THEME:        'setTheme',
  SET_TRANSLATION_MODE: 'setTranslationMode',
  SET_POSITION:     'setPosition',
  SET_LANGUAGE:     'setLanguage',
  SET_SERVICE:      'setService',
  SET_SELECTION:    'setSelection',
  SET_DICT:         'setDict',
  SET_UI_LANG:      'setUiLang',
  SET_POPUP_THEME:  'setPopupTheme',
  SET_TEXT_STYLE:   'setTextStyle',
};

// ---- 存储 key --------------------------------------------------------------
export const STORAGE_KEY = {
  CONFIG:           'fullLocalUserConfig',
  PARA_CACHE:       'tmt-paragraph-cache',
  LARGE_CACHE:      'tmt-large-cache',
  PAGE_STATUS_PREFIX: 'tmt-page-status-',
};

// ---- 默认配置 --------------------------------------------------------------
export const DEFAULT_CONFIG = {
  // 功能总开关
  enabled: false,

  // 显示模式 & 位置 & 装饰
  translationMode: 'dual',         // dual | replaceHover | replace | hoverTip | hover | click | sentence | sideBySide
  translationPosition: 'after',    // after | before
  theme: 'none',                   // none | dashed | underline | wavy | blockquote | card | glass | marker
  themeColor: '#ffec9c',           // 装饰主题的统一颜色（marker 底色 / dashed 虚线 / underline 实线 / wavy 波浪 / blockquote 竖条 / card 投影 / glass 半透明色）
  translationFontScale: 1,         // 译文字号：0.85 / 1 / 1.1
  translationColor: 'dark',       // 译文颜色：light/dark/red/orange/yellow/green/blue/purple/pink/custom
  translationColorCustom: '#000000',

  // 专有名词保护
  protectTerms: true,
  protectTermsList: '',           // 保护关键词（以 | 分隔）；为空时用内置「计算机通用」模板

  // 段落忽略
  ignoreEnabled: true,            // 是否允许 Alt+点击 忽略段落
  ignoreParagraphs: {},           // 按段落忽略：{ 'example.com': [文本hash, ...] }

  // 语言
  sourceLanguage: 'auto',
  targetLanguage: 'zh-CN',
  textSourceLanguage: 'auto',
  textTargetLanguage: 'zh-CN',

  // 翻译服务
  service: 'bingfree',

  // 界面
  uiLanguage: 'auto',

  // 界面主题（popup）
  popupTheme: 'light',
  popupThemeImage: '',
  popupThemeOpacity: 0.86,
  popupThemeImageOpacity: 1,
  popupThemeTextColor: '#1f2328',

  // 服务定义
  services: {
    bingfree: {
      name: 'Bing (免费)', nameEn: 'Bing (Free)',
      baseUrl: 'https://edge.microsoft.com/translate/translatetext',
      apiKey: '', maxBatchSize: 10, maxTextLength: 5000,
      intervalMs: 300, concurrency: 3, timeoutMs: 15000,
    },
    googlefree: {
      name: 'Google (免费)', nameEn: 'Google (Free)',
      baseUrl: 'https://translate.googleapis.com/translate_a/t',
      apiKey: '', maxBatchSize: 10, maxTextLength: 5000,
      intervalMs: 300, concurrency: 3, timeoutMs: 12000,
    },
    mymemory: {
      name: 'MyMemory',
      baseUrl: 'https://api.mymemory.translated.net/get',
      apiKey: '', email: '', maxChars: 450, maxBatchSize: 10, maxTextLength: 5000,
      intervalMs: 400, concurrency: 2, timeoutMs: 15000,
    },
    lingva: {
      name: 'Lingva Translate',
      baseUrl: 'https://lingva.ml/api/v1',
      apiKey: '', maxBatchSize: 20, maxTextLength: 5000,
      intervalMs: 300, concurrency: 5, timeoutMs: 15000,
    },
    libretranslate: {
      name: 'LibreTranslate',
      baseUrl: 'http://localhost:5000',
      apiKey: '', maxBatchSize: 20, maxTextLength: 5000,
      intervalMs: 300, concurrency: 5, timeoutMs: 15000,
    },
  },

  // DOM 遍历规则
  rule: {
    selectors: [],
    excludeSelectors: ['script', 'style', 'noscript', 'code', 'pre', 'textarea', '[contenteditable="true"]', '[translate="no"]', '.notranslate'],
    stayOriginalSelectors: ['code', 'pre', 'kbd'],
    paragraphMinTextCount: 5,
    paragraphMinWordCount: 2,
    blockMinTextCount: 3,
    blockMinWordCount: 1,
    inlineTags: ['a', 'strong', 'em', 'span', 'b', 'i', 'u', 'code', 'kbd'],
    atomicBlockTags: ['pre', 'code', 'textarea', 'svg'],
    urlChangeDelay: 500,
    mutationChangeDelay: 300,
    observeUrlChange: true,
    enableDynamicIgnore: true,
  },

  // 显示主题（CSS 变量，渲染时会根据 themeColor 动态派生 marker/dashed/underline/wavy/blockquote/card/glass 的装饰色）
  themes: {
    none:       { backgroundColor: 'transparent', borderBottom: 'none', borderLeft: 'none', padding: '0', boxShadow: 'none', textIndent: '0', textDecoration: 'none', backdropFilter: 'none' },
    dashed:     { backgroundColor: 'transparent', borderBottom: '2px dashed #888', borderLeft: 'none', padding: '1px 0', borderRadius: '0', boxShadow: 'none', textIndent: '0', textDecoration: 'none', backdropFilter: 'none' },
    underline:  { backgroundColor: 'transparent', borderBottom: '2px solid #4c8bf5', borderLeft: 'none', padding: '1px 0', borderRadius: '0', boxShadow: 'none', textIndent: '0', textDecoration: 'none', backdropFilter: 'none' },
    blockquote: { backgroundColor: 'rgba(0,0,0,0.04)', borderBottom: 'none', borderLeft: '4px solid #ccc', padding: '4px 10px', borderRadius: '0 4px 4px 0', boxShadow: 'none', textIndent: '0', textDecoration: 'none', backdropFilter: 'none' },
    marker:     { backgroundColor: 'rgba(255,236,156,0.6)', borderBottom: 'none', borderLeft: 'none', padding: '0 2px', borderRadius: '2px', boxShadow: 'none', textIndent: '0', textDecoration: 'none', backdropFilter: 'none' },
    card:       { backgroundColor: '#ffffff', borderBottom: 'none', borderLeft: 'none', padding: '8px 12px', borderRadius: '6px', boxShadow: '0 1px 4px rgba(0,0,0,0.14)', textIndent: '0', textDecoration: 'none', backdropFilter: 'none' },
    wavy:       { backgroundColor: 'transparent', borderBottom: 'none', borderLeft: 'none', padding: '1px 0', borderRadius: '0', boxShadow: 'none', textIndent: '0', textDecoration: 'underline wavy #4c8bf5 1.5px', backdropFilter: 'none' },
    glass:      { backgroundColor: 'rgba(255,255,255,0.55)', borderBottom: 'none', borderLeft: '1px solid rgba(0,0,0,0.08)', padding: '6px 10px', borderRadius: '8px', boxShadow: '0 1px 6px rgba(0,0,0,0.08)', textIndent: '0', textDecoration: 'none', backdropFilter: 'blur(6px)' },
  },

  // 划词浮层
  selection: {
    enabled: true,
    showMode: 'icon',             // direct | icon
  },

  // 单词音标 / 朗读
  dict: {
    provider: 'auto',             // auto | youdao | dictionaryapi
    phonetic: true,               // 单词显示音标
    speak: true,                  // 单词显示朗读按钮
  },

  // 普通翻译浮层
  input: {
    enabled: true,
    triggerKey: '/',
  },
};

// ---- 语言列表 --------------------------------------------------------------
export const LANGUAGES = [
  { code: 'auto',   label: '自动检测', labelEn: 'Auto' },
  { code: 'en',     label: '英语',     labelEn: 'English' },
  { code: 'zh-CN',  label: '简体中文', labelEn: 'Chinese (Simplified)' },
  { code: 'zh-TW',  label: '繁体中文', labelEn: 'Chinese (Traditional)' },
  { code: 'ja',     label: '日语',     labelEn: 'Japanese' },
  { code: 'ko',     label: '韩语',     labelEn: 'Korean' },
  { code: 'fr',     label: '法语',     labelEn: 'French' },
  { code: 'de',     label: '德语',     labelEn: 'German' },
  { code: 'es',     label: '西班牙语', labelEn: 'Spanish' },
  { code: 'ru',     label: '俄语',     labelEn: 'Russian' },
];

// ---- iframe 通信 ------------------------------------------------------------
export const FRAME_MSG = {
  ASK_VISIBILITY: 'tmt-ask-iframe-visibility',
  TELL_VISIBILITY: 'tmt-tell-iframe-visibility',
};

// ---- 显示模式轮转 ----------------------------------------------------------
export const MODE_CYCLE = ['dual', 'replaceHover', 'replace', 'hoverTip', 'hover', 'click'];

// ============================================================================
// 专有名词保护
// ============================================================================

/**
 * 计算机通用专有名词 —— 默认保护词库。
 * 匹配时 protectTermsIn 会自动按长度降序，保证 "Spring Boot" 先于 "Spring" 命中。
 * 这里按字母顺序排序只是为了可读 / 方便用户在设置里快速浏览。
 */
export const PROTECT_TERMS = [
  'ActiveMQ', 'AI', 'AI Act', 'A/B Testing', 'Android', 'Android Studio', 'Ansible', 'Apache License',
  'API', 'Apple', 'Arc', 'AWS', 'Azure', 'Babel', 'Bazel', 'Bun', 'C', 'C#', 'C++', 'Cassandra',
  'CentOS', 'Chrome', 'CI/CD', 'ClickHouse', 'Clojure', 'Cloudflare', 'CLion', 'CMake', 'Copilot',
  'CPM', 'CPC', 'Cypress', 'Dart', 'Deno', 'Deploy', 'Django', 'Docker', 'Docker Compose', 'DynamoDB',
  'Eclipse', 'Edge', 'Elasticsearch', 'Elixir', 'ESBuild', 'ESLint', 'ESP32', 'Express', 'FastAPI',
  'Figma', 'Firebase', 'Firefox', 'Flask', 'Flutter', 'FTP', 'GCP', 'GDPR', 'Git', 'GitHub',
  'GitHub Actions', 'GitLab', 'GitLab CI', 'Grafana', 'gRPC', 'Gradle', 'GraphQL', 'GPL', 'GPT',
  'Haskell', 'Helm', 'Hugging Face', 'HTTP', 'HTTPS', 'Hibernate', 'IntelliJ', 'iOS', 'JAR',
  'Java', 'JavaScript', 'Jenkins', 'Jest', 'JWT', 'JUnit', 'Kafka', 'Kibana', 'Kotlin', 'Kubernetes',
  'Laravel', 'Liquibase', 'Linux', 'LLM', 'Llama', 'Logstash', 'Lua', 'Make', 'MariaDB', 'Maven',
  'microservice', 'MIT License', 'Mistral', 'Mockito', 'MongoDB', 'Nginx', 'Node.js', 'NoSQL',
  'npm', 'Nuxt', 'OAuth', 'OIDC', 'OpenAI', 'OpenSearch', 'Opera', 'Oracle', 'p5.js', 'Packer',
  'Perl', 'PHP', 'Playwright', 'pnpm', 'PostgreSQL', 'Prettier', 'Prometheus', 'PyCharm', 'Pytest',
  'Python', 'PyTorch', 'R', 'RabbitMQ', 'React', 'React Native', 'Redis', 'Redux', 'REST', 'RocketMQ',
  'Ruby', 'Rust', 'Safari', 'SAML', 'SAS', 'Scala', 'Selenium', 'Sentry', 'Sass', 'Sbt', 'SQL',
  'SQL Server', 'SQLite', 'Spring', 'Spring Boot', 'Spring Cloud', 'SSO', 'Stable Diffusion',
  'Storybook', 'Svelte', 'Swift', 'SwiftUI', 'TCP', 'Terraform', 'TiDB', 'TypeScript', 'Ubuntu',
  'UDP', 'V8', 'Vercel', 'Vite', 'Vitest', 'VS Code', 'Webpack', 'WebSocket', 'WebStorm', 'Windows',
  'Xcode', 'YAML', 'yarn', 'Zig', 'Zustand',
].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

/**
 * 内置专有名词模板：按领域内置 10 套（计算机 5 + 非计算机 5），
 * 另加「自定义」——选中后不改动关键词，由用户自行编辑。
 * nameKey 是 i18n 词条键，界面语言切换时模板名跟着变。
 * 所有模板内的 terms 按字母顺序排序（匹配时 protectTermsIn 会再按长度降序）。
 */
function sortTerms(arr) {
  return [...arr].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
}

export const TERM_TEMPLATES = {
  general: { nameKey: 'popup.terms.tpl.general', terms: PROTECT_TERMS },
  frontend: {
    nameKey: 'popup.terms.tpl.frontend',
    terms: sortTerms([
      'Angular', 'Animate.css', 'Babel', 'Bootstrap', 'Bulma', 'CSS', 'Deno', 'ESBuild', 'ESLint',
      'HTML', 'JavaScript', 'jQuery', 'Less', 'Materialize', 'MUI', 'Next.js', 'Nuxt', 'Pinia',
      'pnpm', 'Prettier', 'React', 'Redux', 'Remix', 'Rollup', 'Sass', 'Storybook', 'Svelte',
      'Tailwind', 'TypeScript', 'Vite', 'Vitest', 'Vue', 'Webpack', 'yarn', 'Zustand',
    ]),
  },
  backend: {
    nameKey: 'popup.terms.tpl.backend',
    terms: sortTerms([
      'ActiveMQ', 'Ansible', 'Apache', 'Bazel', 'CentOS', 'CI/CD', 'ClickHouse', 'Django',
      'Docker', 'Docker Compose', 'Elasticsearch', 'Express', 'FastAPI', 'Flask', 'Flyway',
      'Gin', 'Go', 'Grafana', 'Gradle', 'gRPC', 'Hibernate', 'HTTP', 'HTTPS', 'Jenkins', 'JWT',
      'JUnit', 'Kafka', 'Kubernetes', 'Laravel', 'Liquibase', 'Logstash', 'MariaDB', 'Maven',
      'Mockito', 'MongoDB', 'MySQL', 'Nginx', 'Node.js', 'OpenResty', 'PostgreSQL', 'Prometheus',
      'RabbitMQ', 'Redis', 'REST', 'RocketMQ', 'Sentry', 'Spring', 'Spring Boot', 'Spring Cloud',
      'SQL', 'SQLite', 'Terraform', 'Ubuntu', 'WebSocket',
    ]),
  },
  mobile: {
    nameKey: 'popup.terms.tpl.mobile',
    terms: sortTerms([
      'Android', 'Android Studio', 'CocoaPods', 'Compose', 'Flutter', 'Firebase', 'Gradle',
      'iOS', 'Jetpack Compose', 'Kotlin', 'Ktor', 'Objective-C', 'React Native', 'Swift',
      'SwiftUI', 'TestFlight', 'Unity', 'Xcode',
    ]),
  },
  ai: {
    nameKey: 'popup.terms.tpl.ai',
    terms: sortTerms([
      'AI', 'AI Act', 'Anthropic', 'BERT', 'CAR-T', 'ChatGPT', 'Claude', 'Diffusion',
      'Gemini', 'Generative AI', 'GPT', 'Hugging Face', 'Keras', 'LangChain', 'LLM', 'Llama',
      'Machine Learning', 'Midjourney', 'Mistral', 'OpenAI', 'Prompt', 'PyTorch', 'RAG',
      'Stable Diffusion', 'TensorFlow', 'Transformer', 'Whisper',
    ]),
  },
  medical: {
    nameKey: 'popup.terms.tpl.medical',
    terms: sortTerms([
      'CAR-T', 'CDC', 'Clinical Trial', 'COVID-19', 'CRISPR', 'CT', 'DNA', 'ECG', 'FDA',
      'GLP-1', 'HIPAA', 'HPV', 'ICD-10', 'ICU', 'mRNA', 'MRI', 'NIH', 'PCR', 'PET-CT',
      'PubMed', 'RNA', 'WHO',
    ]),
  },
  finance: {
    nameKey: 'popup.terms.tpl.finance',
    terms: sortTerms([
      'AML', 'Bloomberg', 'CPI', 'EBITDA', 'ETF', 'FOMC', 'GDP', 'IPO', 'KYC', 'M&A',
      'NASDAQ', 'NYSE', 'PPI', 'REIT', 'ROE', 'ROI', 'SEC', 'Sharpe Ratio', 'SWIFT', 'VC',
      'Wall Street',
    ]),
  },
  legal: {
    nameKey: 'popup.terms.tpl.legal',
    terms: sortTerms([
      'Apache License', 'BSD', 'CCPA', 'DMCA', 'EU AI Act', 'EULA', 'GDPR', 'GPL', 'LLC',
      'LLP', 'MIT License', 'NDA', 'SLA', 'Terms of Service', 'WIPO',
    ]),
  },
  academic: {
    nameKey: 'popup.terms.tpl.academic',
    terms: sortTerms([
      'APA', 'arXiv', 'Cell', 'DOI', 'EI', 'H-index', 'IEEE', 'LaTeX', 'MLA', 'Nature',
      'ORCID', 'PubMed', 'SCI', 'Science', 'SSCI',
    ]),
  },
  marketing: {
    nameKey: 'popup.terms.tpl.marketing',
    terms: sortTerms([
      'A/B Testing', 'B2B', 'B2C', 'CPC', 'CPM', 'CRM', 'CTR', 'GA4', 'Google Ads',
      'HubSpot', 'KPI', 'Mailchimp', 'ROI', 'Salesforce', 'SEM', 'SEO', 'Shopify', 'UTM',
    ]),
  },
  custom: { nameKey: 'popup.terms.tpl.custom', terms: [] },
};

/** 把「A|B|C」解析成去重后的关键词数组（兼容全角 ｜ 与换行） */
export function parseTerms(input) {
  if (!input) return [];
  const seen = new Set();
  const out = [];
  for (const raw of String(input).split(/[|｜\n]/)) {
    const term = raw.trim();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
  }
  return out;
}

/**
 * 把文本里的专有名词替换成 [[n]] 占位符。
 * 按长度降序匹配，保证 "Spring Boot" 先于 "Spring" 命中。
 * @returns {{ text: string, terms: string[] }}
 */
export function protectTermsIn(text, terms = PROTECT_TERMS) {
  if (!text) return { text, terms: [] };
  const used = [];
  let out = text;
  const sorted = [...terms].sort((a, b) => b.length - a.length);
  for (const term of sorted) {
    // 只替换独立出现的词：前后不能紧跟字母/数字
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, 'g');
    if (!re.test(out)) continue;
    out = out.replace(re, () => {
      const idx = used.length;
      used.push(term);
      return `[[${idx}]]`;
    });
  }
  return { text: out, terms: used };
}

/** 把译文里的 [[n]] 还原成原文的专有名词 */
export function restoreTermsIn(text, terms) {
  if (!text || !terms?.length) return text;
  return text.replace(/\[\[(\d+)\]\]/g, (m, i) => terms[Number(i)] ?? m);
}
