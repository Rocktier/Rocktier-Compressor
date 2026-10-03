import { useCallback, useEffect, useState } from "react";

/** 三态：auto 跟随系统 → light → dark → auto（家族 §6.5 唯一状态机）。 */
export type ThemeMode = "auto" | "light" | "dark";
type Resolved = "light" | "dark";

/** 家族前缀。Compressor 此前完全没有主题系统，这是第一个键，不存在迁移问题。 */
const THEME_KEY = "rocktier-compressor-theme";
const CYCLE: readonly ThemeMode[] = ["auto", "light", "dark"];

function readMode(): ThemeMode {
  if (typeof window === "undefined") return "auto";
  try {
    const stored = localStorage.getItem(THEME_KEY) as ThemeMode | null;
    if (stored === "auto" || stored === "light" || stored === "dark") return stored;
  } catch {
    // 隐私模式 / 存储被禁用：偏好读取失败不能把整个 App 渲染打挂
  }
  // 从没手动选过：跟随系统（家族基线）
  return "auto";
}

function systemTheme(): Resolved {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** auto 落成实际生效值 —— data-theme 只接受 light/dark。 */
function resolveTheme(mode: ThemeMode): Resolved {
  return mode === "auto" ? systemTheme() : mode;
}

function applyResolved(resolved: Resolved) {
  document.documentElement.setAttribute("data-theme", resolved);
}

function persist(mode: ThemeMode) {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // ignore —— 主题本次会话仍然生效
  }
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readMode);

  useEffect(() => {
    applyResolved(resolveTheme(mode));
  }, [mode]);

  // auto 态下系统外观变了要跟着变；light/dark 是明确选择，不动。
  useEffect(() => {
    if (mode !== "auto") return;
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyResolved(systemTheme());
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [mode]);

  const cycleTheme = useCallback(() => {
    setMode((prev) => {
      const next = CYCLE[(CYCLE.indexOf(prev) + 1) % CYCLE.length];
      persist(next);
      return next;
    });
  }, []);

  return { mode, cycleTheme };
}