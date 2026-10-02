import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

type Lang = "en" | "zh";
type Profile = { name: string; label: string; description: string; quality: string };
type CompressResult = {
  inputPath: string;
  outputPath: string;
  originalSize: number;
  compressedSize: number;
  ratio: number;
  format: string;
  error?: string;
  note?: string;
};

// Preset target sizes (decimal MB, matching mail/upload limits). 0 = off.
const TARGETS: { value: number; label: string }[] = [
  { value: 0, label: "Off" },
  { value: 1_000_000, label: "1 MB" },
  { value: 5_000_000, label: "5 MB" },
  { value: 10_000_000, label: "10 MB" },
  { value: 25_000_000, label: "25 MB" },
];
type FileItem = {
  path: string;
  name: string;
  size?: number;
  status: "pending" | "done" | "error";
  result?: CompressResult;
  error?: string;
};

const SUPPORTED_EXT = [
  ".pdf", ".docx", ".docm", ".xlsx", ".xlsm", ".pptx", ".pptm",
  ".jpg", ".jpeg", ".png", ".tif", ".tiff",
];

function fmtBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + " " + u[i];
}

function basename(p: string): string {
  return p.split(/[/\\]/).pop() || p;
}

function isSupported(p: string): boolean {
  const lower = p.toLowerCase();
  return SUPPORTED_EXT.some((e) => lower.endsWith(e));
}

// The engine's get_profiles() returns fixed bilingual strings ("默认 / Default")
// — fine for CLI humans, wrong for a UI that switches language. The frontend
// owns i18n: map profile name → [label, description] per language, falling
// back to whatever the engine sent for unknown profiles.
const PROFILE_I18N: Record<string, { zh: [string, string]; en: [string, string] }> = {
  default: { zh: ["默认", "平衡质量与体积"], en: ["Default", "Balanced quality and size"] },
  web: { zh: ["网页", "优化用于网页上传"], en: ["Web", "Optimised for web upload"] },
  print: { zh: ["打印", "保留打印质量"], en: ["Print", "Preserve print quality"] },
  screen: { zh: ["屏幕", "屏幕显示即可"], en: ["Screen", "Screen display only"] },
  maximum: { zh: ["极限", "最小文件，质量可损"], en: ["Maximum", "Smallest file, lossy"] },
};

export default function App() {
  const [lang, setLang] = useState<Lang>(() => {
    const saved = localStorage.getItem("co.lang");
    return saved === "zh" || saved === "en" ? (saved as Lang) : "en"; // 家族规范：默认英文，不跟随系统
  });
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profile, setProfile] = useState<string>(() => localStorage.getItem("co.profile") || "default");
  const [quality, setQuality] = useState<"low" | "medium" | "high">(
    () => (localStorage.getItem("co.quality") as "low" | "medium" | "high") || "medium",
  );
  const [target, setTarget] = useState<number>(() => Number(localStorage.getItem("co.target") || 0));
  const [files, setFiles] = useState<FileItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  // Refs that always hold the latest values, so the once-registered menu /
  // event listeners and the per-file compress loop never read stale state.
  const langRef = useRef<Lang>(lang);
  const filesRef = useRef<FileItem[]>(files);
  const profileRef = useRef(profile);
  const qualityRef = useRef(quality);
  const busyRef = useRef(false);
  const cancelRef = useRef(false);
  const targetRef = useRef(target);
  langRef.current = lang;
  filesRef.current = files;
  profileRef.current = profile;
  qualityRef.current = quality;
  targetRef.current = target;

  const t = (zh: string, en: string) => (langRef.current === "zh" ? zh : en);

  const addFile = (p: string) => {
    setFiles((prev) => {
      if (prev.some((f) => f.path === p)) return prev;
      return [...prev, { path: p, name: basename(p), status: "pending" }];
    });
    // Input sizes up front: know what you are shrinking before you run.
    invoke<number>("file_size", { path: p })
      .then((sz) => setFiles((prev) => prev.map((f) => (f.path === p ? { ...f, size: sz } : f))))
      .catch(() => {});
  };

  const addPaths = async (paths: string[]) => {
    for (const p of paths) {
      if (isSupported(p)) {
        addFile(p);
        continue;
      }
      // No matching extension — it may be a dropped folder: walk it instead
      // of silently dropping it (first principles: never lose a user's drop).
      try {
        const list = await invoke<string[]>("list_files", { dir: p });
        for (const f of list) {
          if (isSupported(f)) addFile(f);
        }
      } catch {
        /* neither a supported file nor a readable folder — ignore */
      }
    }
  };

  const removeFile = (path: string) =>
    setFiles((prev) => prev.filter((f) => f.path !== path));

  const openAdd = async () => {
    const sel = await open({
      multiple: true,
      filters: [{ name: "Documents & Images", extensions: ["pdf", "docx", "xlsx", "pptx", "jpg", "jpeg", "png", "tif", "tiff"] }],
    });
    if (sel) addPaths(Array.isArray(sel) ? sel : [sel]);
  };

  const openAddFolder = async () => {
    const dir = await open({ directory: true });
    if (typeof dir === "string") {
      try {
        const list = await invoke<string[]>("list_files", { dir });
        addPaths(list);
      } catch (e) {
        setStatus(String(e));
      }
    }
  };

  // Per-file compress loop driven from the frontend: real progress (current
  // file + N/M) and a working cancel, without any Rust-side threading.
  const compress = async () => {
    if (busyRef.current) return;
    const pending = filesRef.current.filter((f) => f.status !== "done");
    if (pending.length === 0) {
      setStatus(t("没有待压缩文件", "No files to compress"));
      return;
    }
    busyRef.current = true;
    cancelRef.current = false;
    setBusy(true);
    let ok = 0;
    let fail = 0;
    let orig = 0;
    let comp = 0;
    let skipped = 0;
    for (let i = 0; i < pending.length; i++) {
      if (cancelRef.current) {
        skipped = pending.length - i;
        break;
      }
      const f = pending[i];
      setStatus(t(`压缩中 (${i + 1}/${pending.length})：`, `Compressing (${i + 1}/${pending.length}): `) + f.name);
      try {
        const r = await invoke<CompressResult>("compress_file", {
          path: f.path,
          profile: profileRef.current,
          quality: qualityRef.current,
          target_bytes: targetRef.current > 0 ? targetRef.current : undefined,
        });
        setFiles((prev) =>
          prev.map((x) =>
            x.path === f.path ? { ...x, status: r.error ? "error" : "done", result: r, error: r.error } : x,
          ),
        );
        if (r.error) fail++;
        else {
          ok++;
          orig += r.originalSize;
          comp += r.compressedSize;
        }
      } catch (e) {
        fail++;
        setFiles((prev) =>
          prev.map((x) => (x.path === f.path ? { ...x, status: "error", error: String(e) } : x)),
        );
      }
    }
    let msg: string;
    if (skipped > 0) {
      msg = t(`已取消（完成 ${ok}，跳过 ${skipped}）`, `Cancelled (${ok} done, ${skipped} skipped)`);
    } else if (fail === 0) {
      msg = t(`完成：${ok} 个文件`, `Done: ${ok} file${ok === 1 ? "" : "s"}`);
    } else {
      msg = t(`完成：${ok} 成功，${fail} 失败`, `Done: ${ok} ok, ${fail} failed`);
    }
    if (orig > comp) {
      msg += t(
        `，共节省 ${fmtBytes(orig - comp)}（省 ${(100 - (comp / orig) * 100).toFixed(0)}%）`,
        ` · saved ${fmtBytes(orig - comp)} (${(100 - (comp / orig) * 100).toFixed(0)}% off)`,
      );
    }
    setStatus(msg);
    busyRef.current = false;
    setBusy(false);
  };

  // One-time wiring: frontend readiness, menu, cold-start file, drag-drop, close guard.
  useEffect(() => {
    const un: UnlistenFn[] = [];
    const setup = async () => {
      await invoke("mark_ready"); // close-guard gate: tell Rust the UI is live
      await invoke("build_menu", { lang: langRef.current });
      try {
        const p = await invoke<Profile[]>("get_profiles");
        setProfiles(p);
        // Restore saved settings only if they still exist; otherwise default.
        if (p.length && !p.some((x) => x.name === profileRef.current)) {
          const def = p.find((x) => x.name === "default") || p[0];
          setProfile(def.name);
          setQuality((def.quality as "low" | "medium" | "high") || "medium");
        }
      } catch { /* profiles optional */ }
      try {
        const ini = await invoke<string | null>("initial_file");
        if (ini) addPaths([ini]);
      } catch { /* no initial file */ }

      un.push(
        await listen<string>("menu-action", (e) => {
          const id = e.payload;
          if (id === "add") openAdd();
          else if (id === "add-folder") openAddFolder();
          else if (id === "compress") compress();
          else if (id === "website") invoke("open_url", { url: "https://rocktier.com" });
          else if (id === "support") invoke("open_url", { url: "https://rocktier.com/support" });
        }),
      );
      un.push(await listen<string>("opened-file", (e) => addPaths([e.payload])));
      un.push(
        await listen<{ paths: string[] }>("tauri://drag-drop", (e) => addPaths(e.payload.paths)),
      );
      un.push(
        await listen("app-close-requested", () => {
          const proceed = () => invoke("force_close");
          if (busyRef.current) {
            if (window.confirm(t("正在压缩，确定退出？", "Compression in progress. Quit anyway?"))) proceed();
          } else {
            proceed();
          }
        }),
      );
    };
    setup();
    return () => un.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Language switch → persist + rebuild native menu (family standard).
  useEffect(() => {
    localStorage.setItem("co.lang", lang);
    invoke("build_menu", { lang }).catch(() => {});
    document.title = "Rocktier Compressor";
    // 无障碍底线：屏幕阅读器要用对应语言的语音引擎朗读
    document.documentElement.lang = lang;
  }, [lang]);

  // Settings persist across launches.
  useEffect(() => { localStorage.setItem("co.profile", profile); }, [profile]);
  useEffect(() => { localStorage.setItem("co.quality", quality); }, [quality]);
  useEffect(() => { localStorage.setItem("co.target", String(target)); }, [target]);

  const pendingCount = files.filter((f) => f.status !== "done").length;
  const selProfile = profiles.find((p) => p.name === profile);

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-drag-region" data-tauri-drag-region>
          <span className="brand-dot" />
          <span className="title-text">Rocktier Compressor</span>
        </div>
        <div className="lang-toggle">
          <button className={lang === "zh" ? "active" : ""} onClick={() => setLang("zh")}>中文</button>
          <button className={lang === "en" ? "active" : ""} onClick={() => setLang("en")}>EN</button>
        </div>
      </header>

      {files.length === 0 ? (
        <main className="content">
          <div className="dropzone" onClick={openAdd}>
            <div className="dropzone-icon">↓</div>
            <p className="dropzone-title">{t("拖放文件到这里开始压缩", "Drop files here to start compressing")}</p>
            <p className="dropzone-subtitle">
              {t("支持 PDF, Word, Excel, PowerPoint, 图片", "Supports PDF, Word, Excel, PowerPoint, Images")}
            </p>
          </div>
        </main>
      ) : (
        <main className="content with-list">
          <div className="file-list">
            {files.map((f) => (
              <div className="file-row" key={f.path}>
                <div className="file-meta">
                  <span className="file-name">{f.name}</span>
                  {f.status === "done" && f.result ? (
                    f.result.outputPath ? (
                      <span className="file-info">
                        {fmtBytes(f.result.originalSize)} → {fmtBytes(f.result.compressedSize)}{" "}
                        <span className="ratio">({(f.result.ratio * 100).toFixed(0)}%)</span>
                        {f.result.note ? <span className="note"> · {f.result.note}</span> : null}
                      </span>
                    ) : (
                      <span className="file-info muted">
                        {t("已是最优，无需压缩", "Already optimized")}
                        {f.result.originalSize ? ` · ${fmtBytes(f.result.originalSize)}` : ""}
                      </span>
                    )
                  ) : f.status === "error" ? (
                    <span className="file-info err">{f.error || t("失败", "Failed")}</span>
                  ) : (
                    <span className="file-info muted">
                      {t("待压缩", "Pending")}
                      {f.size ? ` · ${fmtBytes(f.size)}` : ""}
                    </span>
                  )}
                </div>
                <div className="row-actions">
                  {f.status === "done" && f.result?.outputPath ? (
                    <button
                      className="row-x"
                      title={t("在访达中显示", "Show in Finder")}
                      aria-label="Reveal"
                      onClick={() => invoke("reveal_path", { path: f.result!.outputPath })}
                    >
                      ↗
                    </button>
                  ) : null}
                  <button className="row-x" onClick={() => removeFile(f.path)} aria-label="Remove">×</button>
                </div>
              </div>
            ))}
          </div>
        </main>
      )}

      <section className="controls">
        <div className="control-group">
          <div className="control-label">{t("压缩方案", "Profile")}</div>
          <div className="chip-grid">
            {(profiles.length ? profiles : [{ name: "default", label: "Default", description: "", quality: "medium" }]).map((p) => (
              <button
                key={p.name}
                className={"chip" + (profile === p.name ? " active" : "")}
                onClick={() => setProfile(p.name)}
              >
                {PROFILE_I18N[p.name]?.[lang]?.[0] ?? p.label}
              </button>
            ))}
          </div>
          {selProfile ? (
            <div className="profile-desc">
              {PROFILE_I18N[selProfile.name]?.[lang]?.[1] ?? selProfile.description}
            </div>
          ) : null}
        </div>
        <div className="control-group">
          <div className="control-label">{t("质量", "Quality")}</div>
          <div className="chip-grid">
            {(["low", "medium", "high"] as const).map((q) => (
              <button
                key={q}
                className={"chip" + (quality === q ? " active" : "")}
                disabled={target > 0}
                onClick={() => setQuality(q)}
              >
                {q === "low" ? t("更小", "Smaller") : q === "medium" ? t("均衡", "Balanced") : t("更佳", "Better")}
              </button>
            ))}
          </div>
          {target > 0 ? (
            <div className="profile-desc">{t("目标大小模式下自动调整质量", "Quality is auto-tuned to hit the target")}</div>
          ) : null}
        </div>
        <div className="control-group">
          <div className="control-label">{t("目标大小", "Target size")}</div>
          <div className="chip-grid">
            {TARGETS.map((tg) => (
              <button
                key={tg.value}
                className={"chip" + (target === tg.value ? " active" : "")}
                onClick={() => setTarget(tg.value)}
              >
                {tg.value === 0 ? t("关闭", "Off") : tg.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <footer className="statusbar">
        <span className="status-text">{status || t("就绪", "Ready")}</span>
        {busy ? (
          <button className="secondary" onClick={() => { cancelRef.current = true; }}>
            {t("取消", "Cancel")}
          </button>
        ) : (
          <button className="primary" disabled={pendingCount === 0} onClick={compress}>
            {t("开始压缩", "Start Compress")}
          </button>
        )}
      </footer>
    </div>
  );
}
