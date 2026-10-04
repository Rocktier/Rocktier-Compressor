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
import { fileURLToPath, pathToFileURL } from "node:url";

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

/* ---------- 家族根探测 ----------
 *
 * 这份脚本有**两份分发位置**：各产品仓内的副本（`scripts/family-check.mjs`，
 * 供 CI 跑 --self）与共享仓的这份（`docs/rocktier/tools/`，供跨仓全量检查）。
 * 而**产品目录不在 rocktier-docs 里** —— 每个产品是独立仓库，是家族根的兄弟
 * 目录。所以从共享仓这份往上"数三级"会落在 rocktier-docs 自己身上，随后 9 个
 * 产品全部报 repo-present FAIL：看起来像契约全线崩了，实际只是路径算错。
 *
 * 改为**探测**而非算层数：候选祖先里第一个能看见成组产品目录的就是家族根。
 * 脚本被挪到哪、嵌套几层都不用改。--root 仍可显式覆盖。
 *
 * ⚠️ 判定必须"多数命中"，不能"命中任意一个"：rocktier-docs/docs/ 下有一份
 * launch-kit 镜像（docs/rocktier.com、docs/Rocktier-PDF …），它同样满足
 * "存在某个同名目录"，任何单点探测都会在 docs/ 提前停下，然后把 9 个仓全部
 * 报成目录不存在。产品检出目录带空格（"Rocktier PDF"）且成组出现，用它们当锚点。
 */
const PRODUCT_PROBE = ["Rocktier PDF", "Rocktier MD", "Rocktier Write", "Rocktier Pic2Webp"];

function looksLikeFamilyRoot(dir) {
  // 至少 3 个产品目录同处一个父目录，才认定这里是家族根。
  return PRODUCT_PROBE.filter((d) => existsSync(join(dir, d))).length >= 3;
}

function probeFamilyRoot() {
  // 产品内分发副本：脚本在 <product>/scripts/ 下，家族根就是它的上两级
  // （产品的父目录里没有兄弟产品，但会有 rocktier.com 等；--self 走上面那条）。
  if (selfMode) return resolve(HERE, "..");

  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    if (looksLikeFamilyRoot(dir)) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // 一个候选都不认：退回脚本所在仓库根，并给出可操作的提示而不是静默错报。
  return resolve(HERE, "..", "..");
}

const familyRoot = args.includes("--root")
  ? args[args.indexOf("--root") + 1]
  : probeFamilyRoot();

if (!selfMode && !looksLikeFamilyRoot(familyRoot)) {
  console.error(
    `family:check 找不到家族根（从 ${HERE} 往上探测 8 层都没见到产品目录）。\n` +
    `  产品目录应与 rocktier-docs 平级，例如 "Rocktier PDF" / "rocktier.com"。\n` +
    `  若你的布局不同，用 --root <家族根> 显式指定。\n`
  );
}

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

/* ---------- i18n 字典形态差异 ----------
   OCR: const STRINGS = { zh: {...}, en: {...} }（有真字典，但需显式指定文件）
   CAD / Compressor: 行内双语（三元 lang==="zh" ? … : … / t("中文","English")），
   没有独立 en/zh 字典，无法也不必做键对账 —— 如实记为 NA，避免假警。 */
const I18N_FILE_OVERRIDE = { ocr: "ui/lang.js" };
const I18N_NO_DICT = new Set(["cad-viewer", "compressor"]);

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
/* async：要 await checks-windows.mjs 的动态 import（第 13-15 条）*/
async function runChecks(id, product, dir) {
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
     各产品字典形态差异极大（分文件 / 语言块 / 条目共置 / 无字典），
     因此用**按产品显式声明的适配表**取代全局正则——避免一款的改动打到另一款。 */
  const I18N_ADAPTERS = {
    pdf:        { mode: "file-per-lang", files: ["src/i18n/en.ts", "src/i18n/zh.ts"] },
    markdown:   { mode: "blocks", files: ["src/i18n.ts"] },
    write:      { mode: "blocks", files: ["src/i18n.ts"] },
    pic2webp:   { mode: "blocks", files: ["src/i18n.js"] },
    ocr:        { mode: "blocks", files: ["ui/lang.js"] },
    journal:    { mode: "blocks", files: ["src/i18n/index.ts"],
                  langNames: { en: ["en-US"], zh: ["zh-CN"] }, leafOnly: true },
    sign:       { mode: "co-located", files: ["src/i18n.ts"] },
    "cad-viewer": { mode: "none", reason: "行内三元双语（lang===\"zh\" ? … : …），无独立 en/zh 字典" },
    compressor: { mode: "none", reason: "行内双语 t(\"中文\",\"English\")，无独立 en/zh 字典" },
  };

  // 整文件的键（分文件形态：en.ts / zh.ts 全文件即该语言字典）
  const fileKeys = (t) =>
    new Set([...t.matchAll(/["'`]?([\w.$-]{2,})["'`]?\s*:\s*(?:["'`]|\[|\{|\(|true|false|-?\d)/g)].map((m) => m[1]));
  /* 取某个对象字面量内的键名。`openBrace` 指向它的 `{`。
   *
   * 为什么必须自己扫括号：正则无法配平嵌套，而 i18n 字典里有嵌套对象
   * （Journal 的分组、MD 的 `{ [key: string]: string }` 型嵌套），
   * `\{([^}]*)\}` 这类写法会在第一个右括号处截断，把后面的键全漏掉。
   *
   * 必须跳过：字符串字面量（含转义与模板串的 ${}）、行注释、块注释 ——
   * 否则注释里一句 `// 见 { 说明` 就会让括号计数错位，后面整块键都读不到。
   *
   * ⚠️ 这个函数此前**根本不存在**：`blockKeysFor` 里调用它，但全文件没有定义。
   * 它一直没炸，纯粹是因为下面那个正则写错了（见 blockKeysFor 的注释）——
   * 循环体一次都没进过。两个 bug 互相掩护，才让这条闸门看起来「跑了但没结果」。
   */
  const collectBlockKeys = (src, openBrace) => {
    const keys = new Set();
    if (src[openBrace] !== "{") return keys;
    let depth = 0;
    for (let i = openBrace; i < src.length; i++) {
      const c = src[i], n = src[i + 1];
      if (c === "/" && n === "/") {                       // 行注释
        while (i < src.length && src[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && n === "*") {                       // 块注释
        i += 2;
        while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
        i++;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {          // 字符串 / 模板串
        const quote = c;
        i++;
        while (i < src.length) {
          if (src[i] === "\\") { i += 2; continue; }
          if (src[i] === quote) break;
          i++;
        }
        continue;
      }
      if (c === "{" || c === "[" || c === "(") { depth++; continue; }
      if (c === "}" || c === "]" || c === ")") {
        depth--;
        if (depth === 0) break;
        continue;
      }
      // 只在对象字面量的最外层（depth === 1）取键
      if (depth === 1) {
        const m = src.slice(i, i + 200).match(/^\s*(?:(["'`])([\w.$-]+)\1|([A-Za-z_$][\w$]*))\s*:/);
        if (m) {
          keys.add(m[2] || m[3]);
          i += m[0].length - 1;
        }
      }
    }
    return keys;
  };

  // 语言块内的键；leafOnly 时只取字符串值键（跳过嵌套对象名）
  const blockKeysFor = (t, names, leafOnly) => {
    const acc = new Set();
    for (const n of names) {
      /* ⚠️ 转义陷阱（2026-10-04 修）：这里**曾是**模板字面量里的单反斜杠 `\s`。
       * 模板字面量会把无法识别的转义 `\s` 解析成裸 `s`，于是真正的正则变成
       *     ["']?en(?:…)?["']?s*[:=]s*{
       * 要求字面的 `s` 字符 —— `en: {` 永远匹配不上，循环体一次都没进，
       * 于是 5 款产品的 en/zh 键集恒为空，报出一句「适配表未取到键（en=0 zh=0）」。
       * 那句话把人指向适配表，真正的问题在正则上，方向完全错。
       * 现改用字符类 [ \t] 与 \{，不依赖任何反斜杠转义，从根上消除这类坑。 */
      const re = new RegExp(`["']?${n}(?:[-_][A-Za-z]{2,4})?["']?[ \\t]*[:=][ \\t]*\\{`, "gi");
      let m;
      while ((m = re.exec(t))) {
        for (const k of collectBlockKeys(t, m.index + m[0].length - 1)) {
          // leafOnly 暂不做过滤：Journal 顶层多嵌套对象，先取全量键再据实判断差异
          acc.add(k);
        }
      }
    }
    return acc;
  };

  const AD = I18N_ADAPTERS[id];
  // 供后面的硬编码扫描 / 许可证检查复用
  const isI18nFile = (f) => /i18n|lang|locale|translation/i.test(f);
  const i18nFiles = (AD && AD.files ? AD.files : []).map((f) => join(dir, f)).filter(existsSync);
  if (!AD) {
    add(id, "i18n-key-reconciliation", "WARN", "未登记 i18n 形态适配，跳过对账");
  } else if (AD.mode === "none") {
    add(id, "i18n-key-reconciliation", "NA", AD.reason);
  } else {
    const files = (AD.files || []).map((f) => join(dir, f)).filter(existsSync);
    let E = new Set(), Z = new Set();
    if (AD.mode === "file-per-lang") {
      E = fileKeys(read(files[0] || ""));
      Z = fileKeys(read(files[1] || ""));
    } else if (AD.mode === "blocks") {
      for (const f of files) {
        const t = read(f);
        E = new Set([...E, ...blockKeysFor(t, AD.langNames?.en || ["en"], AD.leafOnly)]);
        Z = new Set([...Z, ...blockKeysFor(t, AD.langNames?.zh || ["zh"], AD.leafOnly)]);
      }
    } else if (AD.mode === "co-located") {
      const entries = [...read(files[0] || "").matchAll(
        /(?:^|\n)\s{2,}["'`]?([\w.$-]+)["'`]?\s*:\s*\{\s*en\s*:/g)].map((m) => m[1]);
      E = new Set(entries);
      Z = new Set(entries);
    }
    if (!E.size || !Z.size) {
      add(id, "i18n-key-reconciliation", "WARN", `适配表未取到键（en=${E.size} zh=${Z.size}）`);
    } else {
      const onlyEn = [...E].filter((k) => !Z.has(k));
      const onlyZh = [...Z].filter((k) => !E.has(k));
      const bad = onlyEn.length + onlyZh.length;
      add(id, "i18n-key-reconciliation", bad ? "FAIL" : "PASS",
        bad ? `漏译/多余 ${bad} 处（仅en ${onlyEn.length} / 仅zh ${onlyZh.length}）e.g. ${[...onlyEn, ...onlyZh].slice(0, 5).join(",")}`
            : `en/zh 键齐平 (${E.size})`);
    }
  }

  /* 4. no-literal-user-strings：界面文案不得硬编码（启发式：中文裸串）
     排除项：i18n/语言字典文件本身（中文就该在那里）、注释行、data-i18n 行、
     以及形如  "key": "值"  的字典条目行。 */
  const codeFiles = walkFe([".ts", ".tsx", ".js", ".svelte", ".jsx"]);
  let literals = 0, sample = "";
  for (const f of codeFiles) {
    if (isI18nFile(f)) continue; // 字典文件天然含中文
    /* 测试夹具里的中文不是 UI 文案 —— 跳过这个**文件**，不是跳过这个**产品**。
     * ⚠️ 这里原来写的是 `return`。它在 for 循环里 return 的是 runChecks() 整个函数，
     * 于是「本产品检查到此为止」—— MD 与 Write 因为 src/services/*.test.ts
     * 在遍历顺序里靠前，第 5~12 条（含存储键命名空间、i18n 对账、reduced-motion
     * 等）从来没跑过，报告里只显示 3 条。静默少跑比报错危险得多：
     * 看起来「FAIL 0 / 3」像没问题，实际是七条闸门没执行。 */
    if (/\.(test|spec)\./.test(f)) continue;
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
      /* 跨行双语表：Compressor 的 errorText 把两种语言各占一行
       *   "Failed to query profiles": [
       *     "读取预设配置失败。",          ← 这一行只有中文，上面的 hasLatin 看不到
       *     "Could not read the profiles.",
       *   ],
       * 逐行判定必然误报。⚠️ 别用「把两行挤成一行」来消除它 ——
       * 那会让每条译文的 diff 变成一整行、评审时看不出改了什么。
       * 所以向前看几行：紧邻的下一条非空行里有纯 Latin 串就算双语。 */
      if (hasCJK && !hasLatin) {
        /* 必须是「数组里紧邻的**纯**字符串字面量」这一种形状才放过：
         *     "Failed to query profiles": [
         *       "读取预设配置失败。",
         *       "Could not read the profiles.",
         *     ],
         * 判据是整行只由「可选引号 + 内容 + 可选逗号」构成 —— 不带 `const x = `
         * 这类前缀。⚠️ 这一点是刻意的：早先只判「下一行含 Latin 串」，于是
         *     const 硬编码 = "转换失败，请重试";
         *     const other = "someIdentifier";
         * 这种真·硬编码中文会被放过（实测过），而 Compressor 恰恰是全文
         * 内联中文最多的那一款 —— 放宽它等于在唯一需要严格的产品上放水。
         */
        const BARE_STRING = /^["'`][^"'`]*["'`]\s*,?$/;
        const LATIN_STRING = /^["'`][^"'`]*[A-Za-z]{3,}[^"'`]*["'`]\s*,?$/;
        for (let j = i + 1; j < Math.min(i + 4, src.length); j++) {
          const nx = src[j].trim();
          if (!nx || nx.startsWith("//") || nx.startsWith("/*")) continue;
          if (BARE_STRING.test(nx)) { if (LATIN_STRING.test(nx)) return; break; }
          break;
        }
      }
      if (strs.length && strs.every((v) => /^(zh|en|zh-CN|en-US)$/.test(v))) return;
      if (/["'`][^"'`]*[一-鿿]{2,}/.test(line)) { literals++; if (!sample) sample = `${basename(f)}:${i + 1}`; }
    });
  }
  add(id, "no-literal-user-strings", literals ? "FAIL" : "PASS",
    literals ? `${literals} 处疑似硬编码中文文案 e.g. ${sample}` : "无裸中文文案");

  /* 4b. first-frame-storage-key：index.html 内联首帧脚本的存储键必须与运行时一致。
   *
   * 为什么单独一条：键改名只改了运行时代码，`index.html` 里那段**内联**脚本
   * （必须在样式解析前定好 data-theme，否则先画一帧黑底再跳变）读的还是旧键。
   * 后果不是报错而是**视觉**：老用户看到「先按旧键画首帧、React 挂载后跳成
   * 另一种」，一闪而过，很难归因；而闸门此前对 index.html 一无所查。
   *
   * 2026-10-04 实测：6 仓（PDF / MD / Write / CAD / OCR / Compressor）在键改名
   * 之后首帧仍读旧键 —— 正是这条缺失的检查该拦的。
   *
   * 判据：首帧脚本里 getItem/setItem 的键 ⊆ 运行时用的键集合。
   * 允许出现**旧键**（回落），不允许出现运行时压根不读的键 —— 后者是纯粹的错配。
   */
  const firstFrameIssues = [];
  {
    const htmlPaths = [join(dir, "index.html"), ...feDirs.map((d) => join(d, "index.html"))]
      .filter((p) => existsSync(p));
    // 运行时真正读/写的键：收集全仓的 rocktier.* 字面量（含 legacy 回落键）
    const runtimeKeys = new Set();
    for (const f of codeFiles) {
      for (const m of read(f).matchAll(/["'`](rocktier\.[\w.-]+)["'`]/g)) runtimeKeys.add(m[1]);
    }
    for (const p of htmlPaths) {
      const html = read(p);
      // 只看 <script> 块内的内联脚本（外部 src 的不在本仓，读不到）
      for (const block of html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi) || []) {
        for (const m of block[1].matchAll(/(?:get|set|remove)Item\(\s*["'`]([^"'`]+)["'`]/g)) {
          const key = m[1];
          if (key.startsWith("rocktier.")) continue; // 已是新命名空间，无需比对
          if (key.startsWith("rocktier-")) {
            firstFrameIssues.push(`${basename(p)}: 首帧读 ${key}，运行时已改用 rocktier. 命名空间`);
          } else if (!key.startsWith("rocktier.")) {
            firstFrameIssues.push(`${basename(p)}: 首帧键 ${key} 不在 rocktier. 命名空间`);
          }
        }
      }
    }
  }
  add(id, "first-frame-storage-key", firstFrameIssues.length ? "FAIL" : "PASS",
    firstFrameIssues.length
      ? [...new Set(firstFrameIssues)].slice(0, 4).join("；")
      : `首帧内联脚本的存储键与运行时一致（扫 ${feDirs.length} 处 index.html）`);

  /* 5. storage-key-namespace：存储键必须 rocktier. 开头
   *
   * 这里有两条互补的通路，因为**同一个键有两种写法**：
   *   (a) 直接写字面量：localStorage.setItem("rocktier.theme", v)
   *   (b) 先绑常量：const THEME_KEY = "rocktier.theme"；再用 localStorage.setItem(THEME_KEY, v)
   * 只查 (a) 会漏掉一半 —— 9 个产品里恰好 6 个的主题/语言键都是 (b) 形式，
   * 于是「rocktier-md-theme」「rocktier-ocr-theme」这类破命名一直没人拦。
   *
   * ⚠️ 这里曾有一个更宽的第二循环：扫**所有**含 theme/lang/locale 的字符串字面量。
   * 它有两个毛病，且是同一个病根 —— **没有要求存储上下文**：
   *   · 漏：(b) 形式的常量声明不是 API 调用，正则压根匹配不到；
   *   · 误：i18n 字典键名也是字符串，于是 `t("theme")`、`"theme": "主题"`、
   *         Tauri invoke 载荷的 `{ "lang": getUiLang() }` 全被判成存储键，
   *         产品被迫把字典键改成 themeBtn 之类来躲（Pic2WebP 至今仍是
   *         `themeBtn` 这种为躲检查而生的名字）。
   * 所以改为两遍：先收集 `*KEY = "字面量"` 的声明，再看**同一个文件里该标识符
   * 是否真的被当作 storage API 的实参**。两遍都命中才判违规。
   * 「以 KEY 结尾」单独并不够 —— MD 的 `UNTITLED_KEY = "__untitled__"` 就是
   * 反例：它是「尚未落盘」的哨兵**路径值**，只参与字符串比较，从不进 storage，
   * 按单遍判定会误报（而且是逼着人改名的误报，正是这个坑的由来）。
   */
  const badKeys = [];
  for (const f of codeFiles) {
    const src = read(f);
    /* (a) 直接传给 storage API 的字面量。
     *
     * `||` / `??` 链上**右侧**的那个键是刻意的旧键回落，不判违规 ——
     * OCR 的 `getItem("rocktier.lang") || getItem("rocktier-ocr-lang")` 就是这个形状，
     * 而旧键回落正是「改名不丢用户偏好」这条家族规矩的实现方式。
     * 左侧那个（主键）仍会被拦。
     * ⚠️ 第一版这里没排除回落，导致把 OCR 那行判成破命名；而真正的破命名
     * （把旧键当主键）反而因为同样的原因被放过 —— 判反了。 */
    /* 把每个 storage 调用的**整个参数表达式**切出来，在表达式层面判定。
     *
     * 前一版按「引号闭合后是否紧跟 ||/??」判断回落，判反了：
     *   A || "en"          里的 "en" 紧跟 || → 被当成回落豁免
     *   A || B || "en"     里的 B 后面是 || → 也被豁免 ← 真正的旧键被放过
     * 正确口径：**一条 `||`/`??` 链上只有最左边那个键是主键**，其余全是回落候选。
     * 合法形态是新键在左、旧键在右；把旧键挪到左边（当主键）就该被拦。
     */
    /* 抓完整的 `A(...) || B(...) || C` 表达式 —— 参数里的右括号必须按**嵌套深度**
     * 配平，否则 `getItem(f(x)) || getItem(g)` 会在第一个 `)` 处截断，
     * 把后面的调用整段漏掉（实测踩过：OCR 那行 `getItem(A) || getItem(B) || "en"`
     * 被截成两个独立调用，于是 B 被当成主键，合法回落被判成违规）。
     *
     * 做法：从 `localStorage` 出发逐字符扫，跳过嵌套的 ()/[]/''/``，
     * 一直到**括号深度回到 0 之后**再吃掉 || / ?? 链上的其它调用。
     */
    const CALL = /(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem|removeItem)\s*\(/g;
    /** 从 src[i]（指向 '(' 之后）起吃掉一次调用，返回结束位置（该调用之后的位置）。 */
    const endOfCall = (src, i) => {
      let depth = 1;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") depth--;
        else if (c === '"' || c === "'" || c === "`") {
          const q = c;
          i++;
          while (i < src.length && src[i] !== q) i += src[i] === "\\" ? 2 : 1;
        }
        i++;
      }
      return i;
    };
    /* 处理**一条完整的取值表达式**：`A(...) || B(...) || "x"`。
     *
     * 从该表达式的**起点**扫到链尾，一次性收集全部键字面量 —— 而不是每个
     * `getItem` 各判一次。后者有个实测踩到的坑：`getItem(A) || getItem(B) || "en"`
     * 里的 B 是合法回落，可单点扫描时 B 会被当成独立调用的主键而误报；
     * 更糟的是把同一个表达式的两次扫描当成两次独立违规。
     * 判据：整条链上**第一个**键是主键，其余为回落候选。
     */
    for (const m of src.matchAll(CALL)) {
      // 从调用起点回退，确认它前面不是 `||`/`??`（是的话它属于上一条链，已被处理）
      const before = src.slice(Math.max(0, m.index - 16), m.index);
      if (/\|\|\s*$|\?\?\s*$/.test(before)) continue;

      let expr = "";
      let i = m.index + m[0].length - 1; // 指向这次调用的 '('
      for (let guard = 0; guard < 16; guard++) {
        const end = endOfCall(src, i + 1);
        expr += src.slice(guard === 0 ? m.index : i, end);
        i = end;
        // 后面是否还接着 `||`/`??` + 另一个 storage 调用
        const link = src.slice(i).match(/^\s*(\|\||\?\?)\s*(?=(?:localStorage|sessionStorage)\s*\.)/);
        if (!link) break;
        i += link[0].length;
        // 跳到下一个调用的 '('
        const next = src.slice(i).match(/^(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem|removeItem)\s*\(/);
        if (!next) break;
        i += next[0].length - 1;
      }
      if (!expr) continue;
      /* 取「键位置」上的字面量 —— 即紧跟在 getItem/setItem/removeItem 的
       * `(` 之后那个参数。
       *
       * ⚠️ 不能扫整条表达式里的所有字面量：`setItem(TYPEWRITER_KEY, x ? "1" : "0")`
       * 里 `"1"` 是**值**不是键。早期版本用「表达式里第一个 rocktier* 字面量，
       * 找不到就取第一个字面量」，于是 Write 的 `setItem(…, "1")` 被报成
       * 「非 rocktier. 前缀键 1」—— 值被当成键了。 */
      const keyLiterals = [];
      let scan = expr;
      while (scan.length) {
        const at = scan.search(/(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem|removeItem)\s*\(/);
        if (at < 0) break;
        const open = scan.indexOf("(", at);
        const lit = scan.slice(open + 1).match(/^\s*["'`]([^"'`]+)["'`]/);
        if (lit) keyLiterals.push(lit[1]);
        // 跳过这次调用
        const rest = scan.slice(open + 1);
        const endOfCall = (s, i) => {
          let d = 1;
          while (i < s.length && d > 0) {
            const c = s[i];
            if (c === "(" || c === "[" || c === "{") d++;
            else if (c === ")" || c === "]" || c === "}") d--;
            else if (c === '"' || c === "'" || c === "`") {
              const q = c; i++;
              while (i < s.length && s[i] !== q) i += s[i] === "\\" ? 2 : 1;
            }
            i++;
          }
          return i;
        };
        const e = endOfCall(rest, 0);
        scan = " ".repeat(open + 1) + rest.slice(e);
      }
      const primary = keyLiterals.find((k) => /^rocktier[-_]?/.test(k)) ?? keyLiterals[0];
      if (primary && !primary.startsWith("rocktier.")) badKeys.push(primary);
    }
    /* (b) 绑成键常量的字面量，且该常量确实被 storage API 消费。
     *
     * ⚠️ 变量名带 `_LEGACY` 后缀的是**有意保留的旧键回落**，不算违规。
     * 第一次写这条闸门时漏了这个后缀，结果 OCR 的
     * `LANG_KEY_LEGACY = "rocktier-ocr-lang"` 被判成破命名 ——
     * 而那正是「改名不丢用户偏好」这条家族规矩的实现本身。
     * 判据从「以 KEY 结尾」收紧为「以 KEY 结尾且**不是** _LEGACY 结尾」。 */
    const storageArgs = new Set(
      [...src.matchAll(/(?:localStorage|sessionStorage)\s*\.\s*(?:getItem|setItem|removeItem)\s*\(\s*([A-Za-z_$][\w$]*)/g)]
        .map((m) => m[1])
    );
    for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*KEY)\s*(?::\s*string\s*)?=\s*["'`]([^"'`]+)["'`]/g)) {
      if (/_LEGACY$/.test(m[1])) continue;
      if (storageArgs.has(m[1]) && !m[2].startsWith("rocktier.")) badKeys.push(m[2]);
    }
      }
  add(id, "storage-key-namespace", badKeys.length ? "FAIL" : "PASS",
    badKeys.length
      ? `非 rocktier. 前缀键 ${badKeys.length} 个: ${[...new Set(badKeys)].slice(0, 6).join(",")}（命名空间用「.」分隔，不是「-」）`
      : "存储键均在 rocktier. 命名空间");

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

  /* ---------- 13-15. Windows 平台陷阱（独立模块，见 checks-windows.mjs）----------
   *
   * ⚠️ 这三条**此前从未被执行过**：checks-windows.mjs 从 2026-10-03 提交起就只有
   * 导出函数、没有任何调用方，family.json 里却已把 ciChecks 列成 15 条。
   * 「契约里声明了」与「闸门真的会跑」是两件事 —— 这里补上后者。
   *
   * 三条的共性：macOS 完全正常，只有 Windows 暴露，且**静默失败**
   *（不报错、不崩溃、只是点了没反应），所以跨平台 CI 抓不到，只能靠契约拦。
   *
   * 用动态 import：产品仓内的分发副本可能还没同步这个文件。缺文件时明确报
   * FAIL（而不是静默跳过）—— 少跑闸门比报错危险，前面 `return` 那次已经教过。
   */
  try {
    const w = await import(pathToFileURL(join(CONTRACT_DIR, "tools", "checks-windows.mjs")).href);
    w.reset();
    w.checkAboutMetadata(dir);
    w.checkMenuActionHandlers(dir);
    w.checkErrorLocalized(dir);
    for (const r of w.collect()) add(id, r.id, r.status, r.detail);
  } catch (e) {
    add(id, "windows-checks-present", "FAIL",
      `无法加载 checks-windows.mjs（应有 ${join(CONTRACT_DIR, "tools", "checks-windows.mjs")}）：${e.message}`);
  }
}

/* ---------- 主流程 ---------- */
const products = CONTRACT.products || [];
if (selfMode) {
  // 单产品模式：直接查当前产品目录（CI 内使用）
  const p = products.find((x) => x.id === only) || null;
  await runChecks(only || basename(familyRoot), p, familyRoot);
} else {
  for (const p of products) {
    if (only && p.id !== only) continue;
    await runChecks(p.id, p, join(familyRoot, LOCAL_DIRS[p.id] || p.id));
  }
}
// 第 9 款 Compressor：契约若已收录则由上面的循环覆盖，仅在契约未列时补扫，避免重复计两遍
const knownIds = new Set(products.map((p) => p.id));
if (!knownIds.has("compressor") && LOCAL_DIRS.compressor && (!only || only === "compressor")) {
  await runChecks("compressor", null, join(familyRoot, LOCAL_DIRS.compressor));
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
