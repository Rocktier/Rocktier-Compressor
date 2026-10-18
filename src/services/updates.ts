/* 更新检查 —— 只在用户主动要求时才联网。
 *
 * ── 为什么不用 Tauri 的 updater 插件 ──────────────────────────────
 *
 * 家族对外的承诺是「除非你要求，应用不会联网」，且「绝不在未经询问的
 * 情况下下载或安装任何东西」（privacy.html 的 Update checks 一节）。
 *
 * Tauri updater 插件会在应用里常驻一个「下载并替换自身」的通道，需要
 * 为每款产品维护签名密钥对与 CI secret。而我们并不需要它：用户想要的是
 * 「有没有新版本，去哪下」，不是「静默替我装好」。
 *
 * 所以这里只做一件事：请求一个列出最新版本的公开文件，比对版本号，
 * 把结果和官方发布页链接交给用户。下载与安装由用户自己决定。
 * 全程零 Rust 改动、零密钥、零新增依赖。
 *
 * ── 请求里有什么 ──────────────────────────────────────────────────
 *
 * 只有 GitHub Releases 的公开 API 地址。不含许可证码、设备标识、
 * 机器信息，或与文件有关的任何内容。这也是它能被写进隐私政策的理由。
 */

import pkg from "../../package.json";

/** GitHub 仓库（形如 "Owner/Repo"）—— 各产品不同，复制时改这一行。 */
const REPO = "Rocktier/Rocktier-Compressor";

const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const FALLBACK_URL = `https://github.com/${REPO}/releases/latest`;

export type UpdateResult = {
  latest: string;
  url: string;
  hasUpdate: boolean;
  checkedAt: number;
};

/** 去掉前导 v，逐段转数字。非数字段按 0 处理，永不抛错。 */
function parse(version: string): number[] {
  return version
    .replace(/^v/i, "")
    .split(".")
    .map((part) => parseInt(part, 10) || 0);
}

/** 语义化版本比较：a 比 b 新则返回 true。位数不等时缺失位按 0 补。 */
export function isNewer(a: string, b: string): boolean {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/**
 * 当前版本。优先取打包时的 package.json（与 tag 同源，不会出现
 * 系统里装着 0.1.8 而代码里写着 0.1.7 的错位）。
 */
export function currentVersion(): string {
  return pkg.version;
}

/**
 * 检查一次更新。**只在用户点击时调用** —— 启动时、工作中、后台都不调用，
 * 这是隐私承诺的落点，改动时请勿在别处调用它。
 */
export async function checkForUpdates(): Promise<UpdateResult> {
  const res = await fetch(API, {
    headers: { Accept: "application/vnd.github+json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = (await res.json()) as { tag_name?: string; html_url?: string };
  const latest = String(data.tag_name ?? "").replace(/^v/i, "");
  if (!latest) throw new Error("release has no tag_name");

  return {
    latest,
    url: data.html_url || FALLBACK_URL,
    hasUpdate: isNewer(latest, currentVersion()),
    checkedAt: Date.now(),
  };
}
