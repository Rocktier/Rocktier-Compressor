// 令牌回退扫描器 —— scope-aware
// 母版 docs/rocktier/tokens.css 是唯一真源。产品 CSS 里在 import 母版之后
// 又出现 :root / [data-theme="light"] 块并重定义 L0 令牌 = 回退。
//
// 与 family-check 的 tokens-snapshot-diff 的区别：
//   tokens-snapshot-diff  只比 tokens.css 文件字节 -> 看不见产品主样式表里的第二个 :root
//   本脚本                    比「实际被加载的样式表」里的令牌值-> 能看见回退
//
// 用法: node scan-token-revert.mjs <familyRoot>
// 退出码 0 = 无回退；1 = 有回退

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2] || ".";
const MASTER = join(root, "docs", "rocktier", "tokens.css");

const REPOS = {
  pdf: "Rocktier PDF",
  markdown: "Rocktier MD",
  write: "Rocktier Write",
  pic2webp: join("Rocktier Pic2Webp", "pic2webp-main"),
  "cad-viewer": "Rocktier CAD Viewer",
  ocr: "Rocktier OCR",
  journal: "Rocktier-Journal",
  compressor: "Rocktier-Compressor",
  sign: "Rocktier Sign",
};

const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

// 归一化：抹掉纯排版差异，只留语义差异。
// rgba(255,255,255,0.03) === rgba(255, 255, 255, 0.03)
// #fff === #ffffff、#000 === #000000
const norm = (v) => {
  let s = v.replace(/\s+/g, "").toLowerCase();
  s = s.replace(/#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3\b/g, "#$1$2$3");
  s = s.replace(/\ba(\d*\.?\d+)\b/g, "a$1").replace(/\.(\d*0+)(?=[,)])/g, "");
  return s;
};

function blocks(css) {
  // 返回 [{ scope, tokens:Map }]，scope = ":root" | 'light'
  const out = [];
  const re = /(:root\s*(?:,\s*\[data-theme="dark"\])?|\[data-theme="light"\])\s*\{/g;
  let m;
  while ((m = re.exec(css))) {
    const scope = m[1].includes("light") ? "light" : "root";
    // 花括号配平
    let depth = 1, i = re.lastIndex;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    const body = css.slice(re.lastIndex, i - 1);
    const tokens = new Map();
    for (const t of body.matchAll(/(--[\w-]+)\s*:\s*([^;{}]+);/g)) {
      tokens.set(t[1], t[2].replace(/\s+/g, " ").trim());
    }
    out.push({ scope, tokens, start: m.index });
  }
  return out;
}

const masterCss = stripComments(readFileSync(MASTER, "utf8"));
const MB = blocks(masterCss);
const master = {
  root: new Map((MB.find((b) => b.scope === "root") || { tokens: new Map() }).tokens),
  light: new Map((MB.find((b) => b.scope === "light") || { tokens: new Map() }).tokens),
};
// light 块里缺的令牌继承 :root —— 展开成完整快照
for (const [k, v] of master.root) if (!master.light.has(k)) master.light.set(k, v);

console.log(
  `母版 ${MASTER}  :root ${master.root.size} 令牌 / light ${master.light.size} 令牌\n`,
);

function walk(dir, acc = []) {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === "target" || e === ".git") continue;
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, acc);
    else if (/\.(css|html|svelte)$/.test(e)) acc.push(p);
  }
  return acc;
}

let total = 0;
const report = [];

for (const [id, rel] of Object.entries(REPOS)) {
  const dir = join(root, rel);
  let files;
  try {
    files = walk(dir);
  } catch {
    continue;
  }
  for (const f of files) {
    if (f.endsWith(join("rocktier", "tokens.css")) || f.endsWith("src" + "\\styles\\tokens.css")) continue;
    if (relative(dir, f).replace(/\\/g, "/").endsWith("rocktier/tokens.css")) continue;
    if (relative(dir, f).replace(/\\/g, "/").endsWith("styles/tokens.css")) continue;

    const css = stripComments(readFileSync(f, "utf8"));
    const bs = blocks(css);
    if (bs.length === 0) continue;

    for (const b of bs) {
      const ref = master[b.scope];
      const diffs = [];
      for (const [k, v] of b.tokens) {
        if (!ref.has(k)) continue; // 私有令牌，不在本检查范围
        if (norm(ref.get(k)) === norm(v)) continue;
        if (/^var\(/.test(v)) continue; // 引用母版，非回退
        diffs.push({ k, prod: v, master: ref.get(k) });
      }
      if (diffs.length === 0) continue;
      const lines = css.slice(0, b.start).split("\n").length;
      report.push({ id, file: relative(dir, f).replace(/\\/g, "/"), line: lines, scope: b.scope, diffs });
      total += diffs.length;
    }
  }
}

for (const r of report) {
  console.log(`${r.id}  ${r.file}:${r.line}  [${r.scope}]  ${r.diffs.length} 处`);
  for (const d of r.diffs) {
    console.log(`    ${d.k}`);
    console.log(`      产品: ${d.prod}`);
    console.log(`      母版: ${d.master}`);
  }
  console.log("");
}
console.log(`\n合计回退 ${total} 处，分布于 ${report.length} 个块`);
process.exit(total > 0 ? 1 : 0);