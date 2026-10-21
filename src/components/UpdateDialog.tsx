import { lookup, type Lang } from "../i18n";
// 检查更新对话框。入口只在帮助菜单「检查更新…」—— 点击才联网，
// 启动时、工作中、后台都不检查，见 services/updates.ts 头注。
// 结果一律在这里展示：早期版本在右下角放了常驻悬浮入口，fixed 定位
// 漏了 right 会盖住底部内容（v0.1.10 实测），故全部收进菜单 + 弹框。
import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UpdateResult, UpdateState } from "../services/updates";

interface UpdateDialogProps {
  state: UpdateState;
  result: UpdateResult | null;
  /** 当前安装版本，取自 package.json（与 tag 同源）。 */
  currentVersion: string;
  /** 当前界面语言：行内双语 t(zh, en) 据此取词。 */
  lang: Lang;
  onClose: () => void;
}

/** 打开发布页：桌面端走 Rust 白名单入口，浏览器 dev 直接开新窗口。 */
function open(url: string) {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    invoke("open_url", { url }).catch(() => {});
  } else {
    window.open(url, "_blank", "noopener");
  }
}

export function UpdateDialog({ state, result, currentVersion, lang, onClose }: UpdateDialogProps) {
  const t = (zh: string, en: string) => (lang === "zh" ? zh : lookup(lang as Lang, en));

  // Esc 关闭（与 LicenseDialog 一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const body = () => {
    if (state === "checking") {
      return (
        <p>
          {t("正在检查…", "Checking…")}
          <br />
          <small>{t("检查更新只会在你点击时联网。", "This check connects only because you clicked.")}</small>
        </p>
      );
    }
    if (state === "uptodate") {
      return (
        <p>
          {t(`已是最新版本（v${currentVersion}）。`, `You're up to date (v${currentVersion}).`)}
          <br />
          <small>{t("有新版本时，「检查更新」会告诉你就近的下载地址。", "When a newer version exists, this dialog will point you to the download.")}</small>
        </p>
      );
    }
    if (state === "failed") {
      return (
        <p>
          {t("检查失败，请稍后再试。", "Couldn't check for updates. Please try again later.")}
          <br />
          <small>{t("也可以直接打开发布页查看。", "You can also open the releases page directly.")}</small>
        </p>
      );
    }
    if (state === "available" && result) {
      return (
        <p>
          {t(`发现新版本 v${result.latest}（当前 v${currentVersion}）。`, `New version v${result.latest} (you have v${currentVersion}).`)}
          <br />
          <small>{t("点击「获取」打开发布页，下载与安装由你决定。", "Choose \"Get\" to open the releases page — downloading and installing stay your call.")}</small>
        </p>
      );
    }
    return null;
  };

  const download = result?.url ?? "";

  return (
    <div className="update-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="update-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("检查更新", "Check for updates")}
      >
        <div className="update-header">
          <h3>{t("检查更新", "Check for updates")}</h3>
          <button type="button" className="update-close" onClick={onClose} aria-label={t("关闭", "Close")}>
            ×
          </button>
        </div>
        <div className="update-body">{body()}</div>
        <div className="update-footer">
          <button type="button" onClick={onClose}>
            {t("关闭", "Close")}
          </button>
          <span className="update-footer-spacer" />
          {state === "failed" ? (
            <button type="button" onClick={() => open("https://github.com/Rocktier/Rocktier-Compressor/releases/latest")}>
              {t("打开发布页", "Open releases")}
            </button>
          ) : null}
          {state === "available" && result ? (
            <button
              type="button"
              className="update-get-btn"
              onClick={() => open(download)}
            >
              {t(`获取 v${result.latest}`, `Get v${result.latest}`)}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
