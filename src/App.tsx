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
};
type FileItem = {
  path: string;
  name: string;
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

export default function App() {
  const [lang, setLang] = useState<Lang>(() => {
    const saved = localStorage.getItem("co.lang");
    return saved === "zh" || saved === "en" ? (saved as Lang) : "en"; // 家族规范：默认英文，不跟随系统
  });
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profile, setProfile] = useState<string>("default");
  const [quality, setQuality] = useState<"low" | "medium" | "high">("medium");
  const [files, setFiles] = useState<FileItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");

  // Refs that always hold the latest values, so the once-registered menu /
  // event listeners never read stale state.
  const langRef = useRef<Lang>(lang);
  const filesRef = useRef<FileItem[]>(files);
  const profileRef = useRef(profile);
  const qualityRef = useRef(quality);
  const busyRef = useRef(false);
  langRef.current = lang;
  filesRef.current = files;
  profileRef.current = profile;
  qualityRef.current = quality;

  const t = (zh: string, en: string) => (langRef.current === "zh" ? zh : en);

  const addPaths = (paths: string[]) => {
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.path));
      const next = [...prev];
      for (const p of paths) {
        const lower = p.toLowerCase();
        if (!SUPPORTED_EXT.some((e) => lower.endsWith(e))) continue;
        if (seen.has(p)) continue;
        seen.add(p);
        next.push({ path: p, name: basename(p), status: "pending" });
      }
      return next;
    });
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

  const compress = async () => {
    if (busyRef.current) return;
    const pending = filesRef.current.filter((f) => f.status !== "done");
    if (pending.length === 0) {
      setStatus(t("没有待压缩文件", "No files to compress"));
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setStatus(t("压缩中…", "Compressing…"));
    try {
      const res = await invoke<CompressResult[]>("batch_compress", {
        paths: pending.map((f) => f.path),
        profile: profileRef.current,
        quality: qualityRef.current,
      });
      setFiles((prev) =>
        prev.map((f) => {
          const r = res.find((x) => x.inputPath === f.path);
          if (!r) return f;
          return { ...f, status: r.error ? "error" : "done", result: r, error: r.error };
        }),
      );
      const ok = res.filter((r) => !r.error).length;
      const fail = res.length - ok;
      setStatus(
        t(`完成：${ok} 成功${fail ? `，${fail} 失败` : ""}`, `Done: ${ok} ok${fail ? `, ${fail} failed` : ""}`),
      );
    } catch (e) {
      setStatus(String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
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
        const def = p.find((x) => x.name === "default") || p[0];
        if (def) {
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
        await listen<{ paths: string[] }>("drag-drop", (e) => addPaths(e.payload.paths)),
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
  }, [lang]);

  const pendingCount = files.filter((f) => f.status !== "done").length;

  return (
    <div className="app">
      <header className="titlebar">
        <div className="titlebar-drag-region">
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
                    <span className="file-info">
                      {fmtBytes(f.result.originalSize)} → {fmtBytes(f.result.compressedSize)}{" "}
                      <span className="ratio">({(f.result.ratio * 100).toFixed(0)}%)</span>
                    </span>
                  ) : f.status === "error" ? (
                    <span className="file-info err">{f.error || t("失败", "Failed")}</span>
                  ) : (
                    <span className="file-info muted">{t("待压缩", "Pending")}</span>
                  )}
                </div>
                <button className="row-x" onClick={() => removeFile(f.path)} aria-label="Remove">×</button>
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
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <div className="control-group">
          <div className="control-label">{t("质量", "Quality")}</div>
          <div className="chip-grid">
            {(["low", "medium", "high"] as const).map((q) => (
              <button
                key={q}
                className={"chip" + (quality === q ? " active" : "")}
                onClick={() => setQuality(q)}
              >
                {q === "low" ? t("更小", "Smaller") : q === "medium" ? t("均衡", "Balanced") : t("更佳", "Better")}
              </button>
            ))}
          </div>
        </div>
      </section>

      <footer className="statusbar">
        <span className="status-text">{status || t("就绪", "Ready")}</span>
        <button className="primary" disabled={busy || pendingCount === 0} onClick={compress}>
          {busy ? t("压缩中…", "Compressing…") : t("开始压缩", "Start Compress")}
        </button>
      </footer>
    </div>
  );
}
