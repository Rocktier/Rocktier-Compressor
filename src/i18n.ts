/* Compressor 的 i18n 查表。
 *
 * ── 与家族其他产品的差异 ──
 * PDF/CAD/Sign 都有**字典表**（键 → 多语言）。Compressor 原本没有 ——
 * 翻译直接内联在 JSX 里：
 *
 *     const t = (zh: string, en: string) => (lang === "zh" ? zh : en);
 *     <button>{t("选择文件", "Choose files")}</button>
 *
 * 只有 42 处，内联形态在这里是合理的，所以**保留调用点**，
 * 只把闭包从二元扩到查表。改动面最小，行为可验证。
 *
 * ── 为什么键用英文原文 ──
 * 中文只对中文界面有意义。`STRINGS[lang][en]` 里 en 是跨语言稳定的标识，
 * 译文表按英文原文组织，术语也能直接对齐家族 glossary.json。
 *
 * ── 8 个位置参数的坑 ──
 * 若把闭包写成 `t(zh, en, ja, ko, de, es, pt, ar)`，把 ja 与 ko 写反
 * 也能编译通过，运行时显示错语言且无人察觉。所以译文单独放
 * `i18n-strings.ts`（生成物），下标顺序由数组唯一决定。
 *
 * 英文兜底 —— 缺键时回落到英文原文，不会露出 key 或空白。
 *
 * C 方案：机翻基线。接入翻译 API 后重跑 scripts/gen-i18n.mjs 覆盖。
 */

import { STRINGS } from "./i18n-strings";

export type Lang = "en" | "zh" | "ja" | "ko" | "de" | "es" | "pt" | "ar";

/** 家族标准语言表 —— 单一真源，与 PDF / CAD / Sign 同构。 */
export const LOCALES = [
  { code: "en", endonym: "English" },
  { code: "zh", endonym: "中文" },
  { code: "ja", endonym: "日本語" },
  { code: "ko", endonym: "한국어" },
  { code: "de", endonym: "Deutsch" },
  { code: "es", endonym: "Español" },
  { code: "pt", endonym: "Português" },
  { code: "ar", endonym: "العربية" },
] as const;

/** 取指定语言下英文原文 `en` 的译文；未收录时回落英文原文本身。 */
export function lookup(lang: Lang, en: string): string {
  const table = STRINGS[lang];
  return table?.[en] ?? STRINGS.en?.[en] ?? en;
}
