/**
 * Windows 平台陷阱检查（family-check 第 13-15 条）。
 *
 * 三条都来自 2026-10-03 Windows 商店审核的一批真实问题，共性是：
 * **在 macOS 上完全正常，只有 Windows 才暴露，且静默失败**（不报错、不崩溃、
 * 只是"点了没反应"）。因此它们不会被任何跨平台 CI 抓到，只能靠契约闸门拦。
 *
 * 为什么单独一个文件而不是并进 family-check.mjs：那三条的判定逻辑与
 * family-check 的"读文件比对"不同 —— 要读的是 muda 这类**依赖库的实现**
 * （About(None) 落空分支）与「菜单项创建了但前端无处理分支」这种跨语言配对。
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const results = [];
const add = (id, status, detail) => {
  results.push({ id, status, detail });
  return { id, status, detail };
};

/** 返回本模块累积的全部结果（供 family-check 汇总）。 */
export function collect() {
  return results.slice();
}

export function reset() {
  results.length = 0;
}

/* ── 13. about-menu-metadata ──────────────────────────────────────────────
 *
 * muda 的 Windows 后端只匹配 `PredefinedMenuItemType::About(Some(metadata))`
 * 才调 show_about_dialog；传 `None` 落入 `_ => {}` —— 菜单项在，点击**无任何反应**。
 * macOS 走 NSAboutPanel（忽略 metadata），所以本机开发永远看不到这个问题。
 *
 * 判定：源码里 `PredefinedMenuItem::about(` 之后 10 行内是否出现 `AboutMetadata`。
 */
export function checkAboutMetadata(productDir) {
  const files = ["src-tauri/src/main.rs", "src-tauri/src/lib.rs", "src-tauri/src/menu.rs"];
  for (const f of files) {
    const p = join(productDir, f);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, "utf8");
    const idx = src.indexOf("PredefinedMenuItem::about(");
    if (idx < 0) continue;
    const window = src.slice(idx, idx + 600);
    // 注释里出现的 AboutMetadata 不算，看代码里有没有 Some(AboutMetadata
    if (window.includes("Some(AboutMetadata")) return add("about-menu-metadata", "PASS", `${f} 已传 AboutMetadata`);
    return add("about-menu-metadata", "FAIL",
      `${f}: PredefinedMenuItem::about 第三参数是 None —— Windows 上点击「关于」无任何反应`);
  }
  return add("about-menu-metadata", "NA", "未找到 about 菜单项");
}

/* ── 14. menu-action-has-frontend-handler ────────────────────────────────
 *
 * 菜单项在 Rust 侧创建、在前端 listen("menu-action") 里分发。两侧只要有一侧
 * 漏写，用户点菜单就是**完全无反应**（无报错、无提示）。
 * 实测 2026-10-03：Write / OCR / Compressor / Pic2WebP 的「反馈」都属此类。
 *
 * 判定：Rust 侧 MenuItem::with_id(app, "<id>", …) 的每个 id，
 * 前端（src 或 ui 下的 .ts/.tsx/.js/.svelte）必须能搜到该 id 字面量。
 */
export function checkMenuActionHandlers(productDir, ids) {
  const missing = [];
  const found = [];

  /* Rust 里 `MenuItem::with_id(app, "open", …)` 或 `with_id(&app, "add", …)`。
     实测写法跨多行，故用 `[^,]+` 吃 handle、再取第一个字符串字面量。
     带 1 个空格的可选前缀，避免 `with_idX` 之类误配。 */
  const RUST_ID = /with_id\(\s*&?\w+\s*,\s*"([a-z0-9-]+)"/g;

  // 收集前端源文件文本
  let front = "";
  for (const dir of ["src", "ui", "frontend"]) {
    const d = join(productDir, dir);
    if (!existsSync(d)) continue;
    for (const f of walk(d)) {
      if (/\.(ts|tsx|js|svelte|vue)$/.test(f) && !/node_modules|dist|\.git/.test(f)) {
        try { front += readFileSync(f, "utf8") + "\n"; } catch {}
      }
    }
  }

  // 调用方没给 ids 时自己从 Rust 侧抓
  const list = ((ids && ids.length) ? ids : extractMenuIds(productDir))
    /* quit/hide/separator/close_window 由 muda 与操作系统自己处理，
       不经 menu-action 事件，不需要前端分支 —— 否则恒为误报。 */
    .filter((id) => !NATIVE_IDS.has(id));

  for (const id of list) {
    if (hasFrontendHandler(front, id)) found.push(id);
    else missing.push(id);
  }

  if (!list.length) {
    return add("menu-action-has-frontend-handler", "NA", "未找到 MenuItem::with_id 菜单项");
  }
  if (missing.length) {
    return add("menu-action-has-frontend-handler", "FAIL",
      `Rust 建了菜单项但前端无处理分支 → 点击完全无反应：${missing.join(", ")}`);
  }
  return add("menu-action-has-frontend-handler", "PASS",
    `${found.length} 个菜单项均有前端处理分支`);
}

/** 从 Rust 源码里抽出全部自定义菜单项 id。 */
export function extractMenuIds(productDir) {
  const ids = new Set();
  const RUST_ID = /with_id\(\s*&?\w+\s*,\s*"([a-z0-9-]+)"/g;
  for (const f of ["src-tauri/src/main.rs", "src-tauri/src/lib.rs", "src-tauri/src/menu.rs"]) {
    const p = join(productDir, f);
    if (!existsSync(p)) continue;
    const s = readFileSync(p, "utf8");
    for (const m of s.matchAll(RUST_ID)) ids.add(m[1]);
  }
  return [...ids];
}

/** 这些 id 由 muda / 操作系统自己处理，不 emit menu-action。 */
const NATIVE_IDS = new Set(["quit", "hide", "hide_others", "separator", "close_window", "minimize", "fullscreen"]);

/**
 * 前端是否处理了某个菜单 id。
 *
 * 两种写法都要认：
 *   switch (e.payload) { case 'feedback': … }        ← 字符串字面量
 *   const menuActions = { feedback: () => … }        ← 对象裸键（无引号）
 * 实测 Pic2WebP 用后者，只查字面量会全量误报。
 */
function hasFrontendHandler(front, id) {
  if (front.includes(`"${id}"`) || front.includes(`'${id}'`) || front.includes(`\`${id}\``)) return true;
  // 对象裸键：`^\s*<id>\s*:` （避免把 CSS 类名误判）
  return new RegExp(`^\\s*${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`, "m").test(front);
}

/* ── 15. error-text-localized ────────────────────────────────────────────
 *
 * Rust 把错误拍平成英文字符串返回，前端原样显示 → 中文用户全程看英文。
 * 2026-10-03 实测：PDF 23 处、Journal 14 处、Compressor 2 处。
 *
 * 判定：产品里有 `services/errorText.ts`（本地化映射层），
 * 或 Rust 侧 Err() 里没有面向用户的英文句子（技术性错误可豁免）。
 */
export function checkErrorLocalized(productDir) {
  /* 判定「有本地化映射层」——**按证据认，不按文件名认**。
   *
   * 早先只认 `services/errorText.*`，那是把 PDF 的实现当成了全家族的形状。
   * Pic2WebP 早于这条检查就有自己的映射层 `translateBackendMessage`
   * （i18n.js 里的模式表，连带 decode_fail / ext_mismatch 都在里面）——
   * 按文件名判会把它报成「无映射层」，而唯一「修法」是再造一个 errorText 文件，
   * 那是为过检查而写代码。现在两种合法形态都认：
   *   ① 独立的 errorText 模块（PDF / Sign / Compressor）
   *   ② i18n 模块里导出的 translateBackendMessage（Pic2WebP）
   * 加新形态时往这里加，不要改回文件名白名单。 */
  const hasErrorTextModule = ["src/services/errorText.ts", "src/services/errorText.js", "ui/errorText.js"]
    .some((f) => existsSync(join(productDir, f)));
  const hasTranslateBackend = ["src/i18n.js", "src/i18n.ts", "ui/lang.js", "src/i18n/index.ts"]
    .some((f) => existsSync(join(productDir, f)) && /export\s+(?:function|const)\s+translateBackendMessage/.test(readFileSync(join(productDir, f), "utf8")));
  const hasLayer = hasErrorTextModule || hasTranslateBackend;

  // 统计 Rust 里"面向用户"的英文错误（排除纯技术性/许可码）
  const techOnly = /LICENSE_|_EXPIRED|WRONG_PRODUCT|no public key|failed to parse|panic|unwrap/;
  let userFacing = 0;
  for (const f of ["src-tauri/src/commands.rs", "src-tauri/src/lib.rs", "src-tauri/src/main.rs", "src-tauri/src/vault.rs"]) {
    const p = join(productDir, f);
    if (!existsSync(p)) continue;
    const src = readFileSync(p, "utf8");
    const m = src.match(/Err\("[A-Z][^"]{6,120}"/g) || [];
    userFacing += m.filter((x) => !techOnly.test(x)).length;
  }

  if (userFacing === 0) return add("error-text-localized", "PASS", "无面向用户的英文错误串");
  if (hasLayer) return add("error-text-localized", "PASS",
    `有本地化映射层（errorText），覆盖 ${userFacing} 处英文错误`);
  return add("error-text-localized", "WARN",
    `${userFacing} 处面向用户的英文错误串，且无 services/errorText.ts 映射层`);
}

/* ---------- 小工具 ---------- */
function walk(dir, depth = 0) {
  if (depth > 8) return [];
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, depth + 1));
    else out.push(p);
  }
  return out;
}