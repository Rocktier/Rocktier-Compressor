#!/usr/bin/env node
/**
 * Rocktier family:check — 家族契约闸门
 *
 * 规范来源：
 *   - docs/rocktier/family.json      (机器可读契约 + ciChecks 12 条)
 *   - docs/ROCKTIER-UI规范-v2.md §11.2 (闸门必须包含的 8 项)
 *   - docs/rocktier/DECISIONS.md §5.3 (每条检查「挡住什么」)
 *
 * 用法：
 *   node docs/rocktier/tools/family-check.mjs            # 扫描默认家族目录
 *   node family-check.mjs --product pdf                  # 只查一款
 *   node family-check.mjs --root /path/to/family
 *
 * 退出码：0 = 全部通过；1 = 有 FAIL（CI 据此拦住合并）
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT_CANDIDATES = [
  resolve(HERE, "..", "docs", "rocktier"), // 产品内分发副本（CI 用）
  resolve(HERE, ".."),                     // 共享仓内 docs/rocktier
  resolve(HERE, "..", "..", "..", "docs", "rocktier"),
];
const CONTRACT_DIR = CONTRACT_CANDIDATES.find((d) => existsSync(join(d, "family.json"))) || CONTRACT_CANDIDATES[0];
const CANONICAL_TOKENS = join(CONTRACT_DIR, "tokens.css");
const CONTRACT = JSON.parse(readFileSync(join(CONTRACT_DIR, "family.json"), "utf8"));

const args = process.argv.slice(2);
const only = (args.includes("--product") ? args[args.indexOf("--product") + 1] : null) || null;
const selfMode = args.includes("--self");
const familyRoot = args.includes("--root")
  ? args[args.indexOf("--root") + 1]
  : selfMode
    ? resolve(HERE, "..")                  // 产品根目录
    : resolve(HERE, "..", "..", "..");      // docs/rocktier/tools -> 家族根

/* ---------- 产品目录映射（本地检出名 ≠ 仓库名，见 ciChecks #12） ---------- */
const LOCAL_DIRS = {
  pdf: "Rocktier PDF",
  markdown: "Rocktier MD",
  write: "Rocktier Write",
  pic2webp: "Rocktier Pic2Webp/pic2webp-main",
  "cad-viewer": "Rocktier CAD Viewer",
  ocr: "Rocktier OCR",
  journal: "Rocktier-Journal",
  sign: "Rocktier Sign",
  compressor: "Rocktier-Compressor",
};

/* ---------- 小工具 ---------- */
const walk = (dir, exts, out = [], depth = 0) => {
  if (!existsSync(dir) || depth > 7) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "target") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, exts, out, depth + 1);
    else if (exts.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
};
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 取某选择器块内的 CSS 自定义属性名 */
/**
 * 取某选择器声明的全部令牌。同一选择器在文件里可能出现多次（例如主 light 块 +
 * 组件级补充块），主题的令牌集应为**并集**——只取第一处会漏判。
 * 返回 null 表示该选择器一块都没有。
 */
const tokenKeys = (css, selector) => {
  const keys = new Set();
  let found = false;
  let i = css.indexOf(selector);
  while (i >= 0) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    let d = 0, j = open;
    for (; j < css.length; j++) {
      if (css[j] === "{") d++;
      else if (css[j] === "}") { d--; if (d === 0) break; }
    }
    for (const m of css.slice(open + 1, j).matchAll(/(--[\w-]+)\s*:/g)) keys.add(m[1]);
    found = true;
    i = css.indexOf(selector, j);
  }
  return found ? keys : null;
};

const results = [];
const add = (product, check, status, detail) =>
  results.push({ product, check, status, detail: String(detail || "").slice(0, 220) });

/* ---------- 12 条 ciChecks ---------- */
function runChecks(id, product, dir) {
  if (!existsSync(dir)) { add(id, "repo-present", "FAIL", `目录不存在: ${dir}`); return; }

  // 前端目录：多数是 src/，OCR 是 ui/ —— 两边都要扫
  const feDirs = ["src", "ui"].map((d) => join(dir, d)).filter(existsSync);
  const walkFe = (exts) => feDirs.flatMap((d) => walk(d, exts));

  /* 1. tokens-snapshot-diff：产品 tokens.css 必须与 L0 母版逐字一致（容差 0） */
  const tokenCandidates = ["src/styles/tokens.css", "ui/styles/tokens.css", "src/tokens.css", "src/css/tokens.css"];
  const prodTokens = tokenCandidates.map((c) => join(dir, c)).find(existsSync);
  if (!prodTokens) {
    add(id, "tokens-snapshot-diff", "FAIL", "未接 L0 tokens.css（产品内无 src/styles/tokens.css）");
  } else {
    const a = stripComments(read(prodTokens)).replace(/\s+/g, " ").trim();
    const b = stripComments(read(CANONICAL_TOKENS)).replace(/\s+/g, " ").trim();
    if (a === b) add(id, "tokens-snapshot-diff", "PASS", "与 L0 母版一致");
    else {
      const ka = new Set([...a.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
      const kb = new Set([...b.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
      const missing = [...kb].filter((k) => !ka.has(k));
      const extra = [...ka].filter((k) => !kb.has(k));
      add(id, "tokens-snapshot-diff", "FAIL",
        `漂移：缺 ${missing.length} 个${missing.length ? " (" + missing.slice(0, 6).join(",") + ")" : ""}，多 ${extra.length} 个${extra.length ? " (" + extra.slice(0, 6).join(",") + ")" : ""}`);
    }
  }

  /* 2. light-theme-token-parity：[data-theme="light"] 令牌集必须与 :root 完全一致 */
  if (prodTokens) {
    const css = stripComments(read(prodTokens));
    const root = tokenKeys(css, ":root");
    const light = tokenKeys(css, '[data-theme="light"]');
    if (!light) add(id, "light-theme-token-parity", "FAIL", "tokens.css 无 [data-theme=\"light\"] 块");
    else {
      const miss = [...root].filter((k) => !light.has(k));
      add(id, "light-theme-token-parity", miss.length ? "FAIL" : "PASS",
        miss.length ? `浅色档缺 ${miss.length} 个令牌（白底白字/白滚动条风险）: ${miss.slice(0, 6).join(",")}` : "浅色档令牌齐平");
    }
  }

  /* 3. i18n-key-reconciliation：en ↔ zh 键双向对账
     注意：各产品字典形态不一——有的一个文件内 {en:{},zh:{}}，有的拆成 en.ts / zh.ts
     两个文件各导出一个对象。两种都要认。 */
  const isI18nFile = (f) => /i18n|lang|locale|translation/i.test(f);
  const i18nFiles = walkFe([".ts", ".tsx", ".js", ".jsx", ".svelte"]).filter(isI18nFile);
  const keysByLang = { en: new Set(), zh: new Set() };

  const collectBlockKeys = (src, startIdx) => {
    let d = 0, i = startIdx;
    for (; i < src.length; i++) {
      if (src[i] === "{") d++;
      else if (src[i] === "}") { d--; if (!d) break; }
    }
    // 键可能带引号（"a.b": '...'）也可能不带（appName: '...'）——两种都要认
    return new Set([
      ...src.slice(startIdx, i).matchAll(/["'`]?([\w.$-]{2,})["'`]?\s*:\s*(?:["'`]|\[|\{|true|false|-?\d)/g),
    ].map((x) => x[1]));
  };

  for (const f of i18nFiles) {
    const src = read(f);
    // (a) 文件内语言块："en": { ... } / en = { ... } —— 大小写不敏感（Journal 写的是 var ZH = {...}）
    for (const lang of ["en", "zh"]) {
      const re = new RegExp(`["']?${lang}["']?\\s*[:=]\\s*{`, "gi");
      let m;
      while ((m = re.exec(src))) {
        for (const k of collectBlockKeys(src, m.index + m[0].length - 1)) keysByLang[lang].add(k);
      }
      // 变量式：const EN = { ... } / var ZH = { ... }
      const reVar = new RegExp(`(?:const|let|var)\\s+${lang}\\s*(?::[^=]+)?=\\s*{`, "gi");
      while ((m = reVar.exec(src))) {
        for (const k of collectBlockKeys(src, m.index + m[0].length - 1)) keysByLang[lang].add(k);
      }
    }
    // (b) 语言专属文件：en.ts / zh.ts 全文件即该语言字典。
    //     不能用 indexOf("{")——那会撞到 import { X } 的花括号。直接全文件提键，
    //     en/zh 两边用同一规则，对账依然对称有效。
    const fname = basename(f).toLowerCase();
    for (const lang of ["en", "zh"]) {
      if (fname.startsWith(`${lang}.`) || fname.includes(`-${lang}.`) || fname.includes(`.${lang}.`)) {
        for (const k of src.matchAll(/["'`]?([\w.$-]{2,})["'`]?\s*:\s*(?:["'`]|\[|\{)/g)) {
          keysByLang[lang].add(k[1]);
        }
      }
    }
  }
  const E = keysByLang.en, Z = keysByLang.zh;
  if (E.size && Z.size) {
    const onlyEn = [...E].filter((k) => !Z.has(k));
    const onlyZh = [...Z].filter((k) => !E.has(k));
    const bad = onlyEn.length + onlyZh.length;
    add(id, "i18n-key-reconciliation", bad ? "FAIL" : "PASS",
      bad ? `漏译/多余 ${bad} 处（仅en ${onlyEn.length} / 仅zh ${onlyZh.length}）e.g. ${[...onlyEn, ...onlyZh].slice(0, 5).join(",")}`
          : `en/zh 键齐平 (${E.size})`);
  } else {
    add(id, "i18n-key-reconciliation", "WARN", `未定位到 en/zh 双语字典（en=${E.size} zh=${Z.size}，可能单语或结构特殊）`);
  }

  /* 4. no-literal-user-strings：界面文案不得硬编码（启发式：中文裸串）
     排除项：i18n/语言字典文件本身（中文就该在那里）、注释行、data-i18n 行、
     以及形如  "key": "值"  的字典条目行。 */
  const codeFiles = walkFe([".ts", ".tsx", ".js", ".svelte", ".jsx"]);
  let literals = 0, sample = "";
  for (const f of codeFiles) {
    if (isI18nFile(f)) continue; // 字典文件天然含中文
    if (/\.(test|spec)\./.test(f)) return;   // 测试夹具里的中文不是 UI 文案
    const src = read(f).split("\n");
    let inBlock = false; // /* ... */ 跨行块注释：整段都不算 UI 文案
    src.forEach((line, i) => {
      const t = line.trim();
      if (inBlock) { if (t.includes("*/")) inBlock = false; return; }
      if (t.startsWith("//")) return;
      if (t.startsWith("/*")) { if (!t.includes("*/", 2)) inBlock = true; return; }
      if (t.startsWith("*")) return;
      if (/^\{\s*\/\*/.test(t)) return;                    // JSX 注释
      if (/data-i18n|console\.|^\s*\/\//.test(line)) return;
      if (/^["'`]?[\w.$-]+["'`]?\s*:\s*["'`]/.test(t)) return; // 字典条目
      // 内联双语结构：{ zh: [...], en: [...] } / label_zh / label_en
      if (/\b(zh|en)\s*:\s*[\[{]|label_(zh|en)\s*:|_zh\s*:|_en\s*:/.test(line)) return;
      // 已自带英文兜底的双语串
      const strs = [...line.matchAll(/["'`]([^"'`]*)["'`]/g)].map((m) => m[1]);
      if (strs.length && strs.every((v) => !/[一-鿿]{2,}/.test(v) || /[A-Za-z]{3,}/.test(v))) return;
      // 行内已自带另一种语言（t("中文","English") 或 lang==="zh" ? "中文" : "English"）
      // ——不算漏译：两种语言都在，用户不会看到没翻译的界面。
      const hasCJK = strs.some((v) => /[一-鿿]{2,}/.test(v));
      const hasLatin = strs.some((v) => /[A-Za-z]{2,}/.test(v));
      if (hasCJK && hasLatin) return;
      if (strs.length && strs.every((v) => /^(zh|en|zh-CN|en-US)$/.test(v))) return;
      if (/["'`][^"'`]*[一-鿿]{2,}/.test(line)) { literals++; if (!sample) sample = `${basename(f)}:${i + 1}`; }
    });
  }
  add(id, "no-literal-user-strings", literals ? "FAIL" : "PASS",
    literals ? `${literals} 处疑似硬编码中文文案 e.g. ${sample}` : "无裸中文文案");

  /* 5. storage-key-namespace：存储键必须 rocktier. 开头 */
  const badKeys = [];
  for (const f of codeFiles) {
    const src = read(f);
    for (const m of src.matchAll(/(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem|removeItem)\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
      if (!m[1].startsWith("rocktier.")) badKeys.push(m[1]);
    }
    for (const m of src.matchAll(/["'`]([\w.-]*(?:theme|lang|locale)[\w.-]*)["'`]\s*\)?\s*[,)]/g)) {
      /* 仅对明确的 theme/lang 键做命名空间检查 */
      if (/^(theme|lang|locale|rj-theme|rk-lang)$/.test(m[1])) badKeys.push(m[1]);
    }
  }
  add(id, "storage-key-namespace", badKeys.length ? "FAIL" : "PASS",
    badKeys.length ? `非 rocktier. 前缀键 ${badKeys.length} 个: ${[...new Set(badKeys)].slice(0, 6).join(",")}` : "存储键均在 rocktier. 命名空间");

  /* 6. html-lang-sync：必须随语言同步 document.documentElement.lang */
  const htmlSrc = [join(dir, "index.html"), ...feDirs.map((d) => join(d, "index.html"))].map(read).join("\n");
  const mainSrc = feDirs.flatMap((d) => ["main.tsx", "main.ts", "main.js", "app.js"].map((f) => read(join(d, f)))).join("\n");
  const setsLang =
    codeFiles.some((f) => /documentElement\s*\.\s*lang\s*=/.test(read(f))) ||
    /documentElement\.lang\s*=/.test(htmlSrc) ||
    /documentElement\.lang\s*=/.test(mainSrc);
  add(id, "html-lang-sync", setsLang ? "PASS" : "FAIL",
    setsLang ? "存在 documentElement.lang 同步" : "未同步 html lang（无障碍缺陷）");

  /* 7. font / theme / focus-visible / tabular-nums 存在性 */
  const fontsDir = feDirs.flatMap((d) => [join(d, "fonts"), join(d, "assets/fonts")]).find(existsSync);
  let fonts = [], hasOFL = false;
  if (fontsDir) { fonts = readdirSync(fontsDir); hasOFL = fonts.some((f) => /OFL/i.test(f)); }
  const cssAll = walkFe([".css"]).map(read).join("\n");
  const hasFocus = /:focus-visible/.test(cssAll);
  const hasTabular = /font-variant-numeric\s*:\s*tabular-nums/.test(cssAll);
  const hasThemeAttr = codeFiles.some((f) => /data-theme/.test(read(f))) || /data-theme/.test(read(join(dir, "index.html")));
  const miss7 = [];
  if (!fonts.length) miss7.push("字体缺失");
  if (fonts.length && !hasOFL) miss7.push("缺 OFL.txt（SIL OFL 合规）");
  if (!hasFocus) miss7.push("缺 :focus-visible");
  if (!hasTabular) miss7.push("缺 tabular-nums");
  add(id, "font-theme-focus-tabularnums-present", miss7.length ? "FAIL" : "PASS",
    miss7.length ? miss7.join(" / ") : `字体${fonts.length}份+OFL / theme / focus-visible / tabular-nums 齐全`);

  /* 8. license-statement-consistency：LICENSE 与 i18n 许可证文案一致 */
  const lic = read(join(dir, "LICENSE")) || read(join(dir, "LICENSE.md"));
  const licType = /MIT/.test(lic) ? "MIT" : lic ? "其他" : null;
  const licI18n = i18nFiles.map(read).join(" ").match(/MIT|Apache|GPL/);
  if (!licType) add(id, "license-statement-consistency", "FAIL", "无 LICENSE 文件");
  else if (licI18n && licI18n[0] !== licType) add(id, "license-statement-consistency", "FAIL", `LICENSE=${licType} 但界面称 ${licI18n[0]}`);
  else add(id, "license-statement-consistency", "PASS", `LICENSE=${licType}`);

  /* 10. reduced-motion-block-present */
  add(id, "reduced-motion-block-present",
    /prefers-reduced-motion/.test(cssAll) ? "PASS" : "FAIL",
    /prefers-reduced-motion/.test(cssAll) ? "存在降级动画块" : "缺 @media (prefers-reduced-motion)");

  /* 11. identifier-naming-convention：Rocktier.Rocktier<Product>（Write 例外见 DECISIONS §8）
     必须取 tauri.conf.json 顶层 identifier——正则会误抓 fileAssociations 里的 UTI（如 com.adobe.pdf）。 */
  let topIdentifier = null;
  try {
    topIdentifier = JSON.parse(read(join(dir, "src-tauri/tauri.conf.json")))?.identifier ?? null;
  } catch { /* 解析失败按 null 处理 */ }
  const idm = topIdentifier ? [null, topIdentifier] : null;
  const expect = product?.identifier;
  if (!idm) add(id, "identifier-naming-convention", "WARN", "未找到 tauri.conf.json identifier");
  else if (expect && idm[1] === expect)
    // 契约已登记即以契约为准——Write 的 com.rocktier.write 属 DECISIONS §8.3 明确保留的例外
    // （已上架，改名代价大于收益），不得再拿通用正则误判。
    add(id, "identifier-naming-convention", "PASS", `${idm[1]}（契约登记值，例外见 DECISIONS §8.3）`);
  else if (expect && idm[1] !== expect)
    add(id, "identifier-naming-convention", "FAIL", `identifier=${idm[1]}，契约要求 ${expect}`);
  else if (!/^Rocktier\.Rocktier/.test(idm[1]))
    add(id, "identifier-naming-convention", "FAIL", `identifier=${idm[1]} 不符合 Rocktier.Rocktier<Product>`);
  else add(id, "identifier-naming-convention", "PASS", idm[1]);

  /* 12. directory-name-matches-contract：本地目录名 vs 契约仓库名 */
  const repoName = (product?.repo || "").split("/").pop();
  const localBase = basename(dir);
  const norm = (s) => s.toLowerCase().replace(/[\s_-]/g, "");
  const ok12 = !repoName || norm(localBase) === norm(repoName) || norm(dir).includes(norm(repoName));
  add(id, "directory-name-matches-contract", ok12 ? "PASS" : "FAIL",
    ok12 ? `目录 ${localBase} ↔ 仓库 ${repoName}` : `目录 ${localBase} ≠ 仓库 ${repoName}`);

  /* 9. rail-item-count：静态不可靠，标 NA */
  add(id, "rail-item-count", "NA", "需运行时/组件树分析，静态跳过 (shell=" + (product?.shell || "?") + ")");
}

/* ---------- 主流程 ---------- */
const products = CONTRACT.products || [];
if (selfMode) {
  // 单产品模式：直接查当前产品目录（CI 内使用）
  const p = products.find((x) => x.id === only) || null;
  runChecks(only || basename(familyRoot), p, familyRoot);
} else {
  for (const p of products) {
    if (only && p.id !== only) continue;
    runChecks(p.id, p, join(familyRoot, LOCAL_DIRS[p.id] || p.id));
  }
}
// 第 9 款 Compressor：契约若已收录则由上面的循环覆盖，仅在契约未列时补扫，避免重复计两遍
const knownIds = new Set(products.map((p) => p.id));
if (!knownIds.has("compressor") && LOCAL_DIRS.compressor && (!only || only === "compressor")) {
  runChecks("compressor", null, join(familyRoot, LOCAL_DIRS.compressor));
}

/* ---------- 输出 ---------- */
const pad = (s, n) => String(s).padEnd(n);
let fails = 0, passes = 0, warns = 0, nas = 0;
const byProduct = {};
for (const r of results) {
  (byProduct[r.product] ||= []).push(r);
  if (r.status === "FAIL") fails++; else if (r.status === "PASS") passes++; else if (r.status === "WARN") warns++; else nas++;
}
console.log("\n══════ Rocktier family:check ══════");
console.log(`契约 ${CONTRACT.specVersion} / ${CONTRACT.contractVersion}   母版 tokens: ${CANONICAL_TOKENS}\n`);
for (const [p, rs] of Object.entries(byProduct)) {
  const f = rs.filter((r) => r.status === "FAIL").length;
  console.log(`${pad(p, 12)} ${f ? "✗" : "✓"}  FAIL ${pad(f, 2)} / ${rs.length}   家族目录: ${LOCAL_DIRS[p] || p}`);
  for (const r of rs) if (r.status !== "PASS" && r.status !== "NA") console.log(`   ${r.status === "FAIL" ? "✗" : "!"} ${pad(r.check, 34)} ${r.detail}`);
}
console.log(`\n合计 PASS ${passes} / FAIL ${fails} / WARN ${warns} / NA ${nas}`);
process.exit(fails ? 1 : 0);
