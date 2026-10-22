/** 运行时平台判断。
 *
 *  Tauri webview 的 UA 带平台信息（MD/Write 用同一判据渲染快捷键
 *  修饰符：⌘ vs Ctrl+），此处用于**文件管理器名称的地域化** ——
 *  macOS 叫访达（Finder），Windows 叫文件资源管理器（File Explorer），
 *  结果行的「在访达中显示」按钮曾把 macOS 术语写死，Windows 用户
 *  对着一个叫 Finder 的东西满头问号（世界百佳评审罪状 #9）。
 *
 *  判据必须与 MD/Write 的 MOD_KEY 一致（/Mac/i.test(UA)），
 *  否则同一台机器上快捷键显示 ⌘、按钮却说「资源管理器」。 */

export function isMacOS(): boolean {
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
}
