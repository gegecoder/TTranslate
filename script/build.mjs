#!/usr/bin/env node
/**
 * ============================================================================
 * TTranslate 构建脚本
 * ============================================================================
 * 原则：
 *  - 构建产物输出到 dist/，根目录 app.config.json 的 version 会写进 src/manifest.json（保留原格式）用 --no-sync 可跳过。
 *  - 版本号唯一来源是根目录 app.config.json，manifest 里的版本由它决定。
 *  - 不改任何文件名与目录结构。原因：
 *      · manifest 写死了 background/service-worker.js、content/guard.js、popup/popup.html、icons/*.png 等路径；
 *      · guard.js 用 chrome.runtime.getURL('content/engine.mjs') 动态加载引擎；
 *      · popup.js 用 chrome.scripting.executeScript files:['content/guard.js']；
 *      · 各 .mjs 之间用相对路径 import（../shared/constants.mjs 等）。
 *    因此这里「逐文件原地转换」，不做打包/bundle，ESM import 说明符原样保留。
 *
 * 用法（在 script/ 目录下）：
 *    node build.mjs                    # 默认：开发模式（--build-dev）+ 压缩 + 混淆
 *    node build.mjs --build-dev        # 显式指定开发模式（等同默认）
 *    node build.mjs --build-prod       # 生产模式：关闭调试信息收集入口、静默 info/debug 日志
 *    node build.mjs --no-minify        # 关闭压缩（保留格式与注释），仍混淆
 *    node build.mjs --no-obfuscate     # 关闭混淆（不改名），仍压缩
 *    node build.mjs --no-minify --no-obfuscate   # 等价于纯拷贝（便于调试）
 *    node build.mjs --out=..\dist2     # 自定义输出目录
 *    node build.mjs --src=..\src       # 自定义源码目录
 *    node build.mjs --no-sync          # 不同步 manifest 版本
 *
 * 构建模式（--build-dev / --build-prod）通过 esbuild define 注入源码里的__TMT_BUILD_MODE__，
 * 扩展内用 constants.mjs 导出的 BUILD_MODE / IS_DEV 判断。
 * 首次运行前请先：cd script && npm install
 * ============================================================================
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// esbuild 是 script/ 的 devDependency；没装的话给出明确提示而不是报一堆错。
let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  console.error('\n[build] 缺少依赖 esbuild。请先在 script/ 目录运行：npm install\n');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- 命令行参数 ------------------------------------------------------------
function parseArgs(argv) {
  const opt = {
    minify: true,                                   // 压缩（空白/语法 + CSS/HTML/JSON）
    obfuscate: true,                                // 混淆（局部标识符改名，保留导出名）
    src: path.resolve(__dirname, '../src'),
    out: path.resolve(__dirname, '../dist'),
    sync: true,                                     // 同步 app.config.json / manifest 版本
    buildMode: 'dev',                               // 构建模式：dev | prod（默认开发模式）
  };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--(no-)?([\w-]+)(?:=(.+))?$/);
    if (!m) continue;
    const [, no, key, val] = m;
    const bool = no ? false : (val === undefined ? true : val !== 'false' && val !== '0');
    if (key === 'minify') opt.minify = bool;
    else if (key === 'obfuscate') opt.obfuscate = bool;
    else if (key === 'src') opt.src = path.resolve(__dirname, val);
    else if (key === 'out') opt.out = path.resolve(__dirname, val);
    else if (key === 'sync') opt.sync = bool;
    else if (key === 'build-dev') opt.buildMode = 'dev';
    else if (key === 'build-prod') opt.buildMode = 'prod';
  }
  return opt;
}

// ---- JS：压缩 + 混淆（esbuild transform，不打包，保留 import/export） --------
async function buildJs(code, opt) {
  const result = await esbuild.transform(code, {
    loader: 'js',
    format: 'esm',                 // 保留模块结构/导入导出，绝不打包
    target: 'esnext',
    define: {                      // 编译期注入构建模式，供 constants.mjs 的 BUILD_MODE 使用
      __TMT_BUILD_MODE__: JSON.stringify(opt.buildMode),
    },
    minifyWhitespace: opt.minify,  // 压缩：去空白、换行、注释
    minifySyntax: opt.minify,      // 压缩：语法简化（if→三元、合并语句等）
    minifyIdentifiers: opt.obfuscate, // 混淆：局部变量/函数改名；导出名保留
    legalComments: 'none',         // 连 /*! 版权注释一起去掉
    charset: 'utf8',               // 保留中文（i18n 词条），不转义成 \uXXXX
    logLevel: 'silent',
  });
  return result.code;
}

// ---- CSS：去注释 + 折叠空白（保守，避免破坏字符串/URL） -----------------------
function minifyCss(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')     // 块注释
    .replace(/\s+/g, ' ')                  // 折叠空白为单空格
    .replace(/\s*([{}:;,>])\s*/g, '$1')    // 结构符两侧去空白
    .replace(/;}/g, '}')                   // 去掉声明块最后一个分号
    .trim();
}

// ---- HTML：去注释 + 折叠多余空白（保留标签间单空格，不动属性值/文本语义） -----
function minifyHtml(code) {
  return code
    .replace(/<!--(?!\[if)[\s\S]*?-->/g, '')  // 注释（保留条件注释）
    .replace(/\s{2,}/g, ' ')                   // 多空格/换行折叠为单空格
    .trim();
}

// ---- JSON：解析后重新序列化（去掉缩进与注释） --------------------------------
function minifyJson(code) {
  return JSON.stringify(JSON.parse(code));
}

// ---- 版本 / 配置同步 --------------------------------------------------------
/**
 * 以根目录 app.config.json 为唯一版本来源：
 *  1. 把其中的 version 写进 src/manifest.json——只替换 version 字面量，
 *     保留文件原有排版，避免整份重排带来的无关 diff；
 *  2. 后续遍历 src → dist 时，dist 里的 manifest 自然带上了新版本。
 */
async function syncConfig(opt) {
  const configPath = path.resolve(__dirname, '../app.config.json');

  const rawFile = await fs.readFile(configPath, 'utf8').catch(() => null);
  if (rawFile === null) {
    console.warn(`[build] 警告：未找到 ${configPath}，跳过版本同步`);
    return;
  }
  // Windows 下手工编辑保存可能带 UTF-8 BOM：JSON.parse 会因此抛错，
  // 且带 BOM 的产物被 fetch+JSON.parse 读取时同样会失败，这里统一剥掉
  const raw = rawFile.replace(/^\uFEFF/, '');

  let version;
  try {
    version = JSON.parse(raw).version;
  } catch (err) {
    console.warn(`[build] 警告：app.config.json 解析失败（${err.message}），跳过版本同步`);
    return;
  }

  // 1) src/manifest.json 只同步 version
  if (!version) {
    console.warn('[build] 警告：app.config.json 中没有 version，跳过 manifest 版本同步');
    return;
  }
  const manifestPath = path.join(opt.src, 'manifest.json');
  const manifestRaw = await fs.readFile(manifestPath, 'utf8').catch(() => null);
  if (manifestRaw === null) {
    console.warn(`[build] 警告：未找到 ${manifestPath}，跳过 manifest 版本同步`);
    return;
  }
  const next = manifestRaw.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  if (next === manifestRaw) {
    console.log(`[build] manifest 版本已是 ${version}`);
  } else {
    await fs.writeFile(manifestPath, next);
    console.log(`[build] 已更新 manifest 版本 -> ${version}`);
  }
}

// ---- 目录遍历 ---------------------------------------------------------------
async function* walk(dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

const fmt = (n) => (n / 1024).toFixed(1) + 'KB';

// ---- 主流程 -----------------------------------------------------------------
async function main() {
  const opt = parseArgs(process.argv);
  const t0 = Date.now();

  console.log('[build] src =', opt.src);
  console.log('[build] out =', opt.out);
  console.log(`[build] minify=${opt.minify ? 'on' : 'off'}  obfuscate=${opt.obfuscate ? 'on' : 'off'}  mode=${opt.buildMode}`);

  if (!(await fs.stat(opt.src).catch(() => null))) {
    console.error('[build] 源码目录不存在：', opt.src);
    process.exit(1);
  }

  // 版本同步要在遍历 src 之前完成，这样 dist 里的 manifest 拿到的就是新版本
  if (opt.sync) await syncConfig(opt);

  // 清空输出目录，保证产物干净（无条件执行，避免旧文件残留）
  await fs.rm(opt.out, { recursive: true, force: true });
  console.log('[build] 已清理输出目录:', opt.out);
  await fs.mkdir(opt.out, { recursive: true });

  let totalIn = 0, totalOut = 0, jsCount = 0;
  const report = [];

  for await (const file of walk(opt.src)) {
    const rel = path.relative(opt.src, file);
    const dest = path.join(opt.out, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });

    const ext = path.extname(file).toLowerCase();
    const buf = await fs.readFile(file);
    totalIn += buf.length;
    let out;

    try {
      if (ext === '.js' || ext === '.mjs') {
        out = Buffer.from(await buildJs(buf.toString('utf8'), opt), 'utf8');
        jsCount++;
      } else if (ext === '.css' && opt.minify) {
        out = Buffer.from(minifyCss(buf.toString('utf8')), 'utf8');
      } else if (ext === '.html' && opt.minify) {
        out = Buffer.from(minifyHtml(buf.toString('utf8')), 'utf8');
      } else if (ext === '.json' && opt.minify) {
        out = Buffer.from(minifyJson(buf.toString('utf8')), 'utf8');
      } else {
        out = buf; // png / 其它资源：原样拷贝
      }
    } catch (err) {
      // 单个文件失败不应中断整个构建：拷贝原文件并提示
      console.warn(`[build] 警告：${rel} 处理失败，已原样拷贝。${err.message}`);
      out = buf;
    }

    await fs.writeFile(dest, out);
    totalOut += out.length;
    if (ext === '.js' || ext === '.mjs') {
      report.push({ rel, in: buf.length, out: out.length });
    }
  }

  console.log('\n[build] JS/MJS 处理明细：');
  for (const r of report) {
    const pct = r.in ? ((1 - r.out / r.in) * 100).toFixed(1) : '0.0';
    console.log(`  ${r.rel.padEnd(38)} ${fmt(r.in)} -> ${fmt(r.out)}  (-${pct}%)`);
  }
  const totalPct = totalIn ? ((1 - totalOut / totalIn) * 100).toFixed(1) : '0.0';
  console.log(`\n[build] 完成：${jsCount} 个 JS/MJS，总体积 ${fmt(totalIn)} -> ${fmt(totalOut)} (-${totalPct}%)，耗时 ${Date.now() - t0}ms`);

  // 把根目录 app.config.json 拷到 dist/public/，供 popup「关于」页读取
  // 版本号、作者信息与更新接口地址（src/public/ 下的资源已随 walk 原样拷到 dist/public/）
  await copyPublicConfig(opt);

  console.log('[build] 产物目录（浏览器“加载已解压的扩展程序”选它）：', opt.out);
}

/** 拷贝根目录 app.config.json -> dist/public/app.config.json（保持原样，不压缩） */
async function copyPublicConfig(opt) {
  const configPath = path.resolve(__dirname, '../app.config.json');
  const dest = path.join(opt.out, 'public', 'app.config.json');
  const raw = await fs.readFile(configPath, 'utf8').catch(() => null);
  if (raw === null) {
    console.warn('[build] 警告：未找到根目录 app.config.json，跳过 dist/public 拷贝');
    return;
  }
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.writeFile(dest, raw.replace(/^\uFEFF/, ''));
  console.log('[build] 已复制配置 -> dist/public/app.config.json');
}

main().catch((err) => {
  console.error('[build] 构建失败：', err);
  process.exit(1);
});
