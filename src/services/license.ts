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
export async function activate(code: string): Promise<LicenseInfo> {
  let payload: { receipt?: string; error?: string };
  try {
    /* 上报机器指纹 —— 服务端据此限制「一张码能激活几台设备」。
       取不到时是空串，服务端不计数也不拦激活（见 api/devices.js）。
       指纹只用于设备计数，不含任何硬件序列号原文。 */
    let fingerprint = "";
    try {
      fingerprint = await invoke("machine_fingerprint");
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
