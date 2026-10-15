/* 由 scripts/gen-i18n.mjs 生成 —— 勿手改。
 * Compressor 的界面文案内联在 JSX 里（t("中文", "English")），
 * en/zh 由调用点闭包分发，不进本表；本表只放基线之外的语言，
 * 键用**英文原文** —— 英文是跨语言稳定的标识。
 * 2026-10-13 收敛后无基线外语言，故 STRINGS 为空对象（正常终态）。
 *
 * 术语部分取自 docs/rocktier/i18n/glossary.json（家族唯一真源）。
 *
 * C 方案：机翻基线。接入翻译 API 后重跑生成器覆盖。 */

export const STRINGS: Record<string, Record<string, string>> = {
};

export const PROFILE_EN: Record<string, [string, string]> = {
  "default": ["Default", "Balanced quality and size"],
  "web": ["Web", "Optimised for web upload"],
  "print": ["Print", "Preserve print quality"],
  "screen": ["Screen", "Screen display only"],
  "maximum": ["Maximum", "Smallest file, lossy"],
};

export const PROFILE_ZH: Record<string, [string, string]> = {
  "default": ["默认", "平衡质量与体积"],
  "web": ["网页", "优化用于网页上传"],
  "print": ["打印", "保留打印质量"],
  "screen": ["屏幕", "屏幕显示即可"],
  "maximum": ["极限", "最小文件，质量可损"],
};

/** 档位文案按语言索引。键是档位名，与 TARGETS 里的 profile 对应。 */
export const PROFILE_I18N: Record<string, Record<string, [string, string]>> = {
  "en": PROFILE_EN,
  "zh": PROFILE_ZH,
};
