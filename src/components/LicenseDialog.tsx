// 许可与激活对话框（家族 L6，拷自 PDF/MD 的 LicenseDialog 并适配 Compressor：
// Compressor 没有 Modal 组件，遮罩/卡片就地实现，样式走 styles.css；
// 文案用 Compressor 的行内双语 t(zh, en) 模式，不引入 i18n 字典）。
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { activate, BUY_URL, type LicenseInfo } from "../services/license";

interface LicenseDialogProps {
  info: LicenseInfo | null;
  /** 当前界面语言：行内双语 t(zh, en) 据此取词。 */
  lang: "zh" | "en";
  onRefresh: () => void;
  onClose: () => void;
}

/** 打开产品页：桌面端走 Rust 白名单入口，浏览器 dev 直接开新窗口。 */
function buy() {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    invoke("open_url", { url: BUY_URL }).catch(() => {});
  } else {
    window.open(BUY_URL, "_blank", "noopener");
  }
}

/**
 * 许可与激活。
 *
 * 三种状态对应三套文案，其中 `store` 渠道**不显示激活码输入框** —— 商店版的付费由
 * 微软代收、授权也由商店判定，在这里再摆一个输入框只会让人以为要在别处再买一次
 * （而且会给商店审核留下"引导外部购买"的口实）。
 */
export function LicenseDialog({ info, lang, onRefresh, onClose }: LicenseDialogProps) {
  const t = (zh: string, en: string) => (lang === "zh" ? zh : en);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const isStore = info?.channel === "store";
  const licensed = info?.status === "licensed";
  /* 没有公钥就没人激活得了。如实说明，而不是让付过钱的用户看到"激活码未被接受"。 */
  const canActivate = info?.activationConfigured !== false;

  const submit = async () => {
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await activate(code);
      setCode("");
      onRefresh(); // 激活成功立刻刷新 license_status：无需重启即可继续压缩
    } catch (e) {
      /* 三种失败要分开说，用户的下一步动作不同：没连上网（重试即可）、码属于别的
         应用（要买对单品或全家桶）、码不对（检查有没有抄错）。 */
      const detail = e instanceof Error ? e.message : String(e);
      if (detail === "offline") setError(t("连不上 rocktier.com。激活需要一次联网，之后便不再联网。", "Can't reach rocktier.com. Activating needs one connection; after that it never goes online again."));
      else if (detail.includes("WRONG_PRODUCT")) setError(t("这个激活码属于另一个 Rocktier 应用。每个应用各有自己的码，或者用全家桶（可解锁全部）。", "This code belongs to another Rocktier app. Each app has its own code — or use a family bundle (unlocks everything)."));
      else if (detail.includes("REFUNDED")) setError(t("这个激活码对应的购买已退款，因此不能再解锁。如属误判，请把订单号发到 hello@rocktier.com。", "The purchase behind this code was refunded, so it can't unlock anything. If that's wrong, email your order number to hello@rocktier.com."));
      else setError(t("该激活码未被接受。请检查是否输错（不区分大小写）。", "That code wasn't accepted. Please check for typos (case-insensitive)."));
    } finally {
      setBusy(false);
    }
  };

  const statusLine = () => {
    if (!info) return t("正在检查…", "Checking…");
    if (licensed) {
      return info.product === "FL"
        ? t("已激活 —— 全家桶，所有 Rocktier 应用均已解锁。", "Licensed — family bundle. Every Rocktier app is unlocked.")
        : t("已激活。谢谢。", "Licensed. Thank you.");
    }
    if (info.status === "expired") {
      return t("试用已结束。添加与查看文件仍可用；开始压缩需要许可。", "Your trial has ended. Adding and viewing files still work; compressing needs a license.");
    }
    return t(`免费试用中 —— 还剩 ${info.daysLeft} 天。`, `Free trial — ${info.daysLeft} day(s) left.`);
  };

  return (
    <div className="license-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="license-dialog"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("许可与激活", "License")}
      >
        <div className="license-header">
          <h3>{t("许可与激活", "License")}</h3>
          <button type="button" className="license-close" onClick={onClose} aria-label={t("关闭", "Close")}>
            ×
          </button>
        </div>
        <div className="license-body">
          <p>{statusLine()}</p>

          {licensed ? (
            <p>
              <small>{t("此副本已激活。此后不再有任何校验，也不联网。", "This copy is activated. No further checks, and no network access.")}</small>
            </p>
          ) : !canActivate ? (
            /* 这个构建没有验签公钥：任何回执都验不过。与其让买家以为码错了，不如说清。 */
            <p>
              <small>{t("此构建尚未配置验签公钥，暂时无法激活。请写信到 hello@rocktier.com。", "This build cannot activate a code yet — it carries no verification key. Please write to hello@rocktier.com.")}</small>
            </p>
          ) : isStore ? (
            /* 商店版：说明授权由商店负责，并指向商店页面，不提供任何站外购买入口。 */
            <p>
              <small>{t("此副本购自微软商店，许可由商店负责。", "This copy came from the Microsoft Store, so the Store handles the license for it.")}</small>
            </p>
          ) : (
            <>
              <div className="license-field">
                <label htmlFor="license-code">{t("激活码", "Activation code")}</label>
                <input
                  id="license-code"
                  type="text"
                  value={code}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="RKT-…"
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submit();
                  }}
                  disabled={busy}
                />
              </div>
              {error ? <p className="license-error">{error}</p> : null}
              <p>
                <small>{t("付款后页面上会显示激活码，购买确认邮件里也有一份。", "After purchase the code is shown on the page and included in your confirmation email.")}</small>
              </p>
              <p>
                <small>{t("激活会把激活码发送到 rocktier.com 一次，并把签名回执保存在本机。除此之外不传输任何内容。", "Activation sends the code to rocktier.com once and stores a signed receipt on this machine. Nothing else is transmitted.")}</small>
              </p>
            </>
          )}
        </div>
        <div className="license-footer">
          <button type="button" onClick={onClose}>
            {t("关闭", "Close")}
          </button>
          <span className="license-footer-spacer" />
          {!licensed && !isStore ? (
            <button type="button" onClick={buy}>
              {t("购买", "Buy")}
            </button>
          ) : null}
          {!licensed && !isStore && canActivate ? (
            <button
              type="button"
              className="license-activate"
              onClick={() => void submit()}
              disabled={busy || !code.trim()}
            >
              {busy ? t("正在激活…", "Activating…") : t("激活", "Activate")}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
