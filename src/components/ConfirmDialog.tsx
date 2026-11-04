// 应用内确认框（规范 v2 §7 禁止原生 window.confirm / ask）。
// 复用 UpdateDialog 的 overlay / dialog / footer 样式与 tokens，
// 不再自建第二套弹框视觉。
import { useEffect } from "react";
import { lookup, type Lang } from "../i18n";

interface ConfirmDialogProps {
  message: string;
  confirmLabel: string;
  /** 当前界面语言：行内双语 t(zh, en) 据此取词。 */
  lang: Lang;
  /** 破坏性操作（如覆盖输出文件）用 --danger 标示确认按钮。 */
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDialog({
  message,
  confirmLabel,
  lang,
  danger = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const t = (zh: string, en: string) => (lang === "zh" ? zh : lookup(lang, en));

  // Esc = 取消（与 UpdateDialog / LicenseDialog 一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="update-overlay" onMouseDown={onCancel} role="presentation">
      <div
        className="update-dialog confirm-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("请确认", "Confirm")}
      >
        <div className="update-header">
          <h3>{t("请确认", "Confirm")}</h3>
        </div>
        <div className="update-body">
          <p className="confirm-message">{message}</p>
        </div>
        <div className="update-footer">
          <button type="button" onClick={onCancel}>
            {t("取消", "Cancel")}
          </button>
          <span className="update-footer-spacer" />
          <button
            type="button"
            className={danger ? "update-danger-btn" : "update-get-btn"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
