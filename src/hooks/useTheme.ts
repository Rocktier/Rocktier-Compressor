import { useCallback, useEffect, useState } from "react";

/** 两态：light ⇄ dark。
 *  2026-11-15 用户令：全家族取消「跟随系统」，原 §6.5 三态状态机
 *  （auto → light → dark）退役为二态切换；图标只做太阳 / 月亮。 */
export type ThemeMode = "light" | "dark";
type Resolved = "light" | "dark";

/** 家族前缀。Compressor 此前完全没有主题系统，这是第一个键，不存在迁移问题。 */
const THEME_KEY = "rocktier.theme";
// 2026-10-04 键改名：此前 "rocktier-compressor-theme" 不在家族命名空间里。
// Compressor 的主题系统那时刚加、用户存量极少，但读取处仍回落旧键 —— 白写一行，换来
// 「改名永远不丢用户偏好」这条家族规矩不必再逐案讨论。
const THEME_KEY_LEGACY = "rocktier-compressor-theme";

function systemTheme(): Resolved {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function persist(mode: ThemeMode) {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    // ignore —— 主题本次会话仍然生效
  }
}

function readMode(): ThemeMode {
  if (typeof window === "undefined") return "dark";
  try {
    const stored = (localStorage.getItem(THEME_KEY) ??
      localStorage.getItem(THEME_KEY_LEGACY)) as ThemeMode | "auto" | null;
    if (stored === "light" || stored === "dark") return stored;
    if (stored === "auto") {
      // 旧「跟随系统」用户：按读取当时的系统值一次性落定并持久化，
      // 此后不再跟随系统变化（用户看得见的偏好不丢）。
      const resolved = systemTheme();
      persist(resolved);
      return resolved;
    }
  } catch {
    // 隐私模式 / 存储被禁用：偏好读取失败不能把整个 App 渲染打挂
  }
  // 从没手动选过：深色（家族基线；2026-11-15 起不再跟随系统）
  return "dark";
}

function applyResolved(resolved: Resolved) {
  document.documentElement.setAttribute("data-theme", resolved);
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(readMode);

  useEffect(() => {
    applyResolved(mode);
  }, [mode]);

  // 「跟随系统」已取消：不再监听 prefers-color-scheme 变化，
  // light/dark 都是明确选择，启动后保持不变。

  const cycleTheme = useCallback(() => {
    setMode((prev) => {
      const next: ThemeMode = prev === "dark" ? "light" : "dark";
      persist(next);
      return next;
    });
  }, []);

  return { mode, cycleTheme };
}
