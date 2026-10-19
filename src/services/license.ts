// License service — trial & activation（家族 L6，Rust 侧见 src-tauri/src/license.rs）。
// 文案不走 i18n 字典：Compressor 是行内双语 t(zh, en) 模式，license 文案照该模式
// 就地写在 components/LicenseDialog.tsx 里。

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** 产品页：购买与试用说明的唯一入口，官方站点上的文案以此为准。 */
export const BUY_URL = "https://rocktier.com/compressor";

/** Mirrors `LicenseInfo` in src-tauri/src/lib.rs. */
export interface LicenseInfo {
  status: "trial" | "expired" | "licensed";
  daysLeft: number;
  product: string | null;
  /** Whether writes are actually blocked right now (channel + key + switch). */
  enforcing: boolean;
  /** `direct` for the website build, `store` for the Microsoft Store build. */
  channel: "direct" | "store";
  /** False when this build has no verification key, i.e. nothing can be activated. */
  activationConfigured: boolean;
  /** 仅 licensed 时有值：回执里的交易号（吊销复检凭据）。 */
  txn: string | null;
}

/** Current trial / activation state. */
export async function licenseStatus(): Promise<LicenseInfo> {
  return invoke<LicenseInfo>("license_status");
}

/**
 * Hands the server-signed receipt to Rust, which verifies it against the built-in
 * public key and stores it. The check has to happen there: the frontend only has
 * a string, and only the public key can tell whether it means anything.
 */
export async function storeReceipt(signed: string): Promise<LicenseInfo> {
  return invoke<LicenseInfo>("store_receipt", { signed });
}

/**
 * Exchanges an activation code for a signed receipt.
 *
 * The code itself is checked **on the server**, not here: verifying it locally
 * would require shipping the signing secret inside the app, which would let
 * anyone mint their own codes. The frontend only carries the reply to Rust.
 */
/**
 * 吊销复检：用户点击「检查更新」时顺带向服务端核对一次许可状态。
 * 只在用户点击时联网（与更新检查同一承诺）；请求只携带回执里本就有的交易号。
 * revoked 时清除本地回执 —— 授权状态回到未激活，写闸门按状态拦截。
 */
export async function revalidateLicence(): Promise<"ok" | "revoked" | "unknown"> {
  const info = await licenseStatus();
  if (!info.txn) return "unknown";
  try {
    /* B4：吊销复检是「顺手而为」的后台校验（挂在检查更新点击上），网络挂死
       不该拖住整个更新检查 —— 8s 超时后按 unknown 放行（fail-open：宁可漏
       一次复检，不可让检查更新卡死）。 */
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(`https://rocktier.com/api/revalidate?txn=${encodeURIComponent(info.txn)}`, { signal: ctrl.signal });
    if (!res.ok) return "unknown";
      const data = (await res.json()) as { revoked?: boolean };
      /* 响应里没有 revoked 字段 = 服务端 API 形状变了。静默 fail-open 会让
         吊销永久失效且无人知晓，至少留一条线索给排障。 */
      if (!("revoked" in data)) {
        console.warn('license: revalidate response has no "revoked" field — API shape changed?');
      }
    if (!data.revoked) return "ok";
    await invoke("clear_receipt");
    return "revoked";
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return "unknown";
  }
}

export async function activate(code: string): Promise<LicenseInfo> {
  let payload: { receipt?: string; error?: string };
  try {
    /* 上报机器指纹 —— 服务端据此限制「一张码能激活几台设备」。
       取不到时是空串，服务端不计数也不拦激活（见 api/devices.js）。
       指纹只用于设备计数，不含任何硬件序列号原文。 */
    let fingerprint = "";
    try {
      fingerprint = await invoke("report_machine_fingerprint");
    } catch {
      // Rust 命令不可用（极旧版本）不该阻断激活。
    }
    const res = await fetch("https://rocktier.com/api/activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim(), fingerprint, os: (typeof navigator !== "undefined" && navigator.platform) || "" }),
    });
    payload = (await res.json()) as { receipt?: string; error?: string };
    if (!res.ok || !payload.receipt) {
      throw new Error(payload.error || `activation failed (${res.status})`);
    }
  } catch (e) {
    // Offline is the common case here — say so instead of showing a fetch error.
    throw new Error(
      e instanceof Error && e.message && !e.message.includes("fetch")
        ? e.message
        : "offline"
    );
  }
  return storeReceipt(payload.receipt);
}

/** Fires when a write was refused because the trial ran out and nothing is activated. */
export function onLicenseExpired(handler: () => void): Promise<() => void> {
  return listen("license-expired", () => handler());
}

/**
 * 写命令被授权闸门拦下的统一判据：Rust 的 ensure_write_allowed 返回的错误码固定为
 * LICENSE_EXPIRED。各调用点的 catch 用它分流「弹激活对话框」还是「普通失败标记」。
 */
export function isLicenseExpiredError(e: unknown): boolean {
  return e instanceof Error
    ? e.message.includes("LICENSE_EXPIRED")
    : String(e).includes("LICENSE_EXPIRED");
}
