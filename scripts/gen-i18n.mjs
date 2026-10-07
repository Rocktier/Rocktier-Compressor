#!/usr/bin/env node
/* Compressor 多语言改写器。
 *
 * ── 家族第四种（也是最特殊的一种）i18n 形状 ──
 *   PDF     嵌套字典，每语言一个对象
 *   CAD     扁平字典，每语言一个 Record
 *   Sign    每个键内联所有语言
 *   **Compressor 完全没有字典** —— 翻译直接写在 JSX 里：
 *
 *       const t = (zh: string, en: string) => (lang === "zh" ? zh : en);
 *       <button>{t("选择文件", "Choose files")}</button>
 *
 * 所以这里不是「生成字典」，而是**把内联的双语闭包改成查表**：
 * `t("选择文件", "Choose files")` → `t("选择文件", "Choose files", "…ja…", …)`
 *
 * ── 为什么保留调用点不改成字典 ──
 * 改成字典是更大的重构（要新增 Dict 类型、把所有 t() 调用换成 key），
 * 而 Compressor 只有 24 处 —— 内联形态在这里是合理的。
 * 只需把闭包从二元扩到八元，并让调用点带上其余 6 门。
 *
 * ── 一个必须防住的坑 ──
 * 8 个位置参数时，**把 ja 和 ko 写反也能编译通过**，运行时显示错语言。
 * 所以译文从 `scripts/i18n/<lang>.mjs` 读，键用**英文原文**，
 * 生成时按下标展开 —— 顺序由文件里的数组顺序唯一决定，不靠人手对齐。
 *
 * 用法：node scripts/gen-i18n.mjs [--lang ja]
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = process.env.ROCKTIER_ROOT || join(HERE, "..", "..", "..", "..");
const GLOSSARY = join(REPO, "docs", "rocktier", "i18n", "glossary.json");
const LANGS = ["ja", "ko", "de", "es", "pt", "ar"];
const TARGETS = ["src/App.tsx", "src/components/LicenseDialog.tsx"];

const args = process.argv.slice(2);
const only = args.includes("--lang") ? args[args.indexOf("--lang") + 1] : null;

if (!existsSync(GLOSSARY)) {
  console.error(`  ❌ 找不到家族术语表: ${GLOSSARY}\n     设 ROCKTIER_ROOT 指向家族根`);
  process.exit(2);
}
const G = JSON.parse(readFileSync(GLOSSARY, "utf8"));
const approved = new Map();
for (const [, loc] of Object.entries(G.terms)) {
  const en = loc.en?.value;
  if (!en) continue;
  const pack = {};
  for (const l of LANGS) if (loc[l]?.value) pack[l] = loc[l].value;
  if (Object.keys(pack).length) approved.set(en, pack);
}
console.error(`  术语表: ${approved.size} 条英文有家族批准译法`);

/* 扫出全部 `t("中文", "English")` 调用 —— 键用**英文**，
   因为它是跨语言稳定的标识（中文在非中文界面里毫无意义）。 */
const CALL = /\bt\(\s*"([^"]*)"\s*,\s*"([^"]*)"\s*\)/g;
const calls = new Map(); // en -> zh
for (const rel of TARGETS) {
  const p = join(HERE, "..", rel);
  if (!existsSync(p)) continue;
  const s = readFileSync(p, "utf8");
  for (const m of s.matchAll(CALL)) calls.set(m[2], m[1]);
}
console.error(`  t(zh, en) 调用: ${calls.size} 条`);

let missingTotal = 0;
const table = {};
for (const lang of only ? [only] : LANGS) {
  let ctx = {};
  try {
    ctx = (await import(`./i18n/${lang}.mjs`)).default || {};
  } catch (e) {
    if (e && e.code === "ERR_MODULE_NOT_FOUND") {
      console.error(`     (scripts/i18n/${lang}.mjs 尚未创建)`);
    } else {
      /* 不要静默吞：文件存在但坏了，必须报出来 */
      console.error(`  ❌ scripts/i18n/${lang}.mjs 无法导入: ${String(e.message).split("\n")[0]}`);
      missingTotal++;
      continue;
    }
  }
  const out = {};
  const missing = [];
  for (const [en] of calls) {
    const term = approved.get(en)?.[lang];
    const v = term ?? (typeof ctx[en] === "string" ? ctx[en] : null);
    if (v === null) { missing.push(en.slice(0, 54)); continue; }
    const want = [...en.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(",");
    const got = [...v.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join(",");
    if (want !== got) { missing.push(`${en.slice(0, 40)} — 占位符不符（源 {${want}} / 译文 {${got}}）`); continue; }
    out[en] = v;
  }
  if (missing.length) {
    missingTotal += missing.length;
    console.error(`\n  ⚠️ ${lang}: 缺 ${missing.length} 条`);
    missing.forEach((m) => console.error(`      ${m}`));
    continue;
  }
  table[lang] = out;
  console.error(`  ✅ ${lang}: ${Object.keys(out).length} 条齐全`);
}

if (missingTotal) {
  console.error(`\n  ❌ 共 ${missingTotal} 条缺译文。补齐后重跑。\n`);
  process.exit(1);
}

const q = (s) => JSON.stringify(s);

/* ① 生成查表模块：STRINGS[lang][en] */
const tbl = ["/* 由 scripts/gen-i18n.mjs 生成 —— 勿手改。",
  " * Compressor 的翻译原本内联在 JSX 里（t(\"中文\", \"English\")），",
  " * 这里抽成按语言索引的查表，键用**英文原文** ——",
  " * 英文是跨语言稳定的标识，中文在非中文界面里没有意义。",
  " *",
  " * 术语部分取自 docs/rocktier/i18n/glossary.json（家族唯一真源）。",
  " *",
  " * C 方案：机翻基线。接入翻译 API 后重跑生成器覆盖。 */",
  "",
  "export const STRINGS: Record<string, Record<string, string>> = {"];
for (const lang of Object.keys(table)) {
  tbl.push(`  ${lang}: {`);
  for (const [en, v] of Object.entries(table[lang])) tbl.push(`    ${q(en)}: ${q(v)},`);
  tbl.push("  },");
}
tbl.push("};", "");
writeFileSync(join(HERE, "..", "src", "i18n-strings.ts"), tbl.join("\n"));
console.error(`\n  ✅ src/i18n-strings.ts（${Object.keys(table).length} 语言 × ${calls.size} 条）\n`);