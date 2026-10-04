/**
 * 错误文案本地化 —— 把 Rust 侧返回的英文原文映射为当前语言的措辞。
 * 家族 L6 的一部分（拷自 PDF 的同名文件，按 Compressor 的内联双语形态适配：
 * 本产品没有键值字典，`t(zh, en)` 直接收两串文案，所以映射表里放的是成对文案
 * 而不是 i18n 键 —— 与 PDF/Sign 的差异就在这一处，其余判据完全一致）。
 *
 * 为什么需要这一层：`lib.rs` 把错误**拍平为英文字符串**再返回，前端
 * `App.tsx` 用 `String(e)` 直接塞进状态栏与文件行。结果：中文用户全程看英文。
 *
 * 为什么不用错误码改 Rust 侧：那要动每个返回点，且改动面比这层大得多。这里做
 * **纯前端映射**，未知文案回退到原文 —— 新增错误不需要改前端也能正常显示
 * （只是没有本地化），这符合规范「失败必须展示底层真实错误文本」。
 */

/** Rust 错误原文 → 成对文案。键为原文（另一条通路按归一化后的串查）。 */
const EXACT: Record<string, [zh: string, en: string]> = {
  "Failed to query profiles": [
    "读取预设配置失败。",
    "Could not read the profiles.",
  ],
  "URL not allowed": [
    "这个网址不在允许的范围内，出于安全考虑没有下载。",
    "That address is not on the allow list, so nothing was downloaded.",
  ],
};

/** 归一化匹配：忽略大小写、标点与多余空白。同一句意思在 Rust 里常被写两遍。 */
const NORMALIZED: Record<string, [zh: string, en: string]> = {};
for (const [raw, pair] of Object.entries(EXACT)) NORMALIZED[normalize(raw)] = pair;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[.,;:!?'"()]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 返回本地化后的错误文案。
 *
 * @param raw   Rust 返回的原始错误串
 * @param isZh  当前是否为中文
 *
 * ⚠️ 别把未知错误换成「操作失败」：那会把一个可自查的技术原因变成一句没有
 * 信息量的话，比显示英文更糟。
 */
export function localizeError(raw: string, isZh: boolean): string {
  if (!raw) return raw;

  // 许可错误码走专用处理路径（对话框已分流），不该被当成普通错误改写。
  if (raw === "LICENSE_EXPIRED" || raw === "LICENSE_WRONG_PRODUCT") return raw;

  const pair = EXACT[raw] ?? NORMALIZED[normalize(raw)];
  // 未知文案 → 原样显示底层真实错误，不隐藏细节。
  if (!pair) return raw;

  return isZh ? pair[0] : pair[1];
}