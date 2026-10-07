use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri_plugin_opener::OpenerExt;
use tauri::{Emitter, Manager, WindowEvent};

// 授权：试用状态与回执验签（单一来源 docs/rocktier/license.rs，规程 FAMILY-LICENSE.md）。
// 写命令的拦截在下方 ensure_write_allowed，界面在前端 LicenseDialog。
// 注意：Compressor 的 ENFORCE=false（B.9-2，官网尚不可购）——闸门接好但只记账不拦截。
pub mod license;

/* ── 授权：试用与激活（见 license.rs 的模块说明）────────────────────── */

/// 试用与授权状态的落盘目录。由 `setup()` 注入。
///
/// 用全局而不是给每个写命令各加一个参数：那会让所有命令签名都多一个与业务无关的
/// 参数，而它也不是业务状态，读它不需要与压缩任务同步。
static LICENSE_DIR: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

pub fn init_license_dir(dir: std::path::PathBuf) {
    let _ = LICENSE_DIR.set(dir);
}

/// 供闸门发事件用。setup 注入；即使没注入也照样能拦截，只是界面不会自动弹窗。
static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

pub fn init_app_handle(app: tauri::AppHandle) {
    let _ = APP_HANDLE.set(app);
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 当前授权状态。
///
/// 目录未注入（setup 失败）时按"试用中、满额天数"处理 —— 失败方向刻意选**放行**：
/// 一个取不到的目录不该变成一次锁死。
fn current_license() -> crate::license::Status {
    let Some(dir) = LICENSE_DIR.get() else {
        return crate::license::Status::Trialing { days_left: crate::license::TRIAL_DAYS };
    };
    let now = now_secs();
    let started = crate::license::ensure_started(dir, now);
    // 只认本单品与全家桶的回执：别人的回执即使验签通过，也不是本应用的授权。
    let receipt = crate::license::read_valid_receipt(dir, crate::license::PUBLIC_KEY_B64)
        .filter(crate::license::accepts);
    crate::license::status_from(started, receipt.as_ref(), now)
}

/// 写操作的统一闸门。
///
/// 在**命令层**拦，而不是在每个界面路径上判断：界面路径会随功能增长而增加，漏掉一条
/// 就是一道缝；命令层是所有写操作的必经之路。Compressor 的写命令是 compress_file
/// （前端逐文件循环调用，天然逐个过闸）与 batch_compress（Rust 批量入口，虽暂无前端
/// 调用方，照 FAMILY-LICENSE.md §2「及批量入口」一并看住）；读操作一律不拦。
///
/// 错误码固定为 `LICENSE_EXPIRED`，前端凭它弹购买/激活框。
///
/// 当前 `ENFORCE=false`（B.9-2：官网尚不可购）——本函数恒返回 `Ok(())`，但接线和
/// 事件链保持就绪，官网上架可购后把 license.rs 的开关改 true 即生效。
fn ensure_write_allowed() -> Result<(), String> {
    if current_license().allows_write(crate::license::enforced()) {
        return Ok(());
    }
    // 让界面主动知道"被拦下了"，而不是在每个动作的 catch 里各判一次错误码 ——
    // 那种写法漏掉一处，用户看到的就只是一个没有解释的失败。
    if let Some(app) = APP_HANDLE.get() {
        let _ = app.emit("license-expired", ());
    }
    Err("LICENSE_EXPIRED".to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseInfo {
    /// `trial` / `expired` / `licensed`。
    pub status: String,
    /// 仅 `trial` 时有意义。
    pub days_left: i64,
    /// 仅 `licensed` 时有值（`CO` 单品 / `FL` 全家桶）。
    pub product: Option<String>,
    /// 当前是否真的会拦截写操作（渠道 + 公钥 + 总开关三者决定）。
    pub enforcing: bool,
    /// `direct`（官网直链）/ `store`（微软商店）。
    pub channel: String,
    /// 本构建是否已配置验签公钥。
    ///
    /// 没配置时**任何人都激活不了**（回执必然验不过）。界面据此如实说明，而不是
    /// 拿"激活码未被接受"去搪塞一位已经付过钱的用户。
    pub activation_configured: bool,
}

fn license_info() -> LicenseInfo {
    let status = current_license();
    LicenseInfo {
        status: status.as_str().to_string(),
        days_left: match &status {
            crate::license::Status::Trialing { days_left } => *days_left,
            _ => 0,
        },
        product: match &status {
            crate::license::Status::Licensed { product } => Some(product.clone()),
            _ => None,
        },
        enforcing: crate::license::enforced(),
        channel: crate::license::channel().to_string(),
        activation_configured: !crate::license::PUBLIC_KEY_B64.trim().is_empty(),
    }
}

/// 供界面展示：剩余试用天数 / 是否已激活 / 当前渠道。
///
/// ⚠️ 不能加 `pub`：Compressor 的命令都定义在 crate 根（lib.rs），而 `#[tauri::command]`
/// 对 `pub` 命令会生成 `#[macro_export]`，宏被提升到 crate 根后与本地定义同名冲突
/// （E0255，MD 模板验证发现的坑）。
#[tauri::command]
async fn license_status() -> Result<LicenseInfo, String> {
    Ok(license_info())
}

/// 保存服务端签出的回执并立即验签。
///
/// 联网换回执的那一步在**前端**做（`fetch` 到 rocktier.com/api/activate），
/// 为的是不引入 HTTP 客户端依赖；但**验签与落盘必须在这里** —— 前端拿到的只是一段
/// 待验的字符串，能证明它有效与否的只有公钥。
#[tauri::command]
async fn store_receipt(signed: String) -> Result<LicenseInfo, String> {
    let dir = LICENSE_DIR
        .get()
        .ok_or_else(|| "no app data directory".to_string())?;
    let trimmed = signed.trim();
    let receipt = crate::license::verify_receipt(trimmed, crate::license::PUBLIC_KEY_B64)?;

    // 其它单品的码虽然签名有效，但**不属于**本应用 —— 而且不要落盘：落下去以后
    // 会被当成有效回执读回来，等于自己给自己开后门。
    if !crate::license::accepts(&receipt) {
        return Err("LICENSE_WRONG_PRODUCT".to_string());
    }

    crate::license::save_receipt(dir, trimmed)?;
    Ok(license_info())
}

/// Platform-specific compress-engine binary name.
#[cfg(target_os = "macos")]
const ENGINE_BIN: &str = "compress-engine-macos";
#[cfg(target_os = "linux")]
const ENGINE_BIN: &str = "compress-engine-linux";
#[cfg(target_os = "windows")]
const ENGINE_BIN: &str = "compress-engine-windows.exe";

/// Frontend readiness flag for close-guard.
pub struct Ready(pub AtomicBool);

/// Launch document buffered before frontend mount.
pub struct InitialFile(pub Mutex<Option<String>>);

/// Cold-start file-open queue. macOS `application:openURLs:` can arrive before
/// the webview/frontend exists (tao#1235) — buffer here, drain in `setup`, and
/// emit live to the window once it is mounted. Mirrors the Rocktier family
/// PENDING pattern used by MD / CAD Viewer.
static PENDING_OPEN: Mutex<Vec<String>> = Mutex::new(Vec::new());

fn file_from_args() -> Option<String> {
    std::env::args_os()
        .skip(1)
        .map(std::path::PathBuf::from)
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn initial_file(state: tauri::State<InitialFile>) -> Option<String> {
    state.0.lock().ok().and_then(|slot| slot.clone())
}

#[tauri::command]
fn force_close(window: tauri::Window) {
    let _ = window.destroy();
}

#[tauri::command]
fn mark_ready(state: tauri::State<Ready>) {
    state.0.store(true, Ordering::Release);
}

/// Compress a single file using the native compress engine.
/// Returns JSON with original size, compressed size, ratio, and output path.
#[tauri::command]
async fn compress_file(
    app_handle: tauri::AppHandle,
    path: String,
    profile: String,
    quality: String,
    target_bytes: Option<u64>,
) -> Result<serde_json::Value, String> {
    // 压缩会产出新文件：受授权闸门保护（FAMILY-LICENSE.md §2）。必须在
    // spawn_blocking **之前**拦——未授权时不该再起线程干活。前端是逐文件循环调用
    // 本命令，批量天然逐个过闸。
    ensure_write_allowed()?;
    // 阻塞调用（等待 Go 引擎子进程退出）移到 blocking 线程，避免冻结整个窗口、
    // 让页脚「取消」按钮点不到（P0-17）。前端 await invoke 契约保持不变。
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<serde_json::Value, String> {
        let exe_dir = app_handle
            .path()
            .resource_dir()
            .map(|p| p.to_path_buf())
            .or_else(|_| {
                std::env::current_exe().map(|p| p.parent().unwrap_or(Path::new(".")).to_path_buf())
            })
            .map_err(|e| e.to_string())?;

        let engine_path = exe_dir.join(ENGINE_BIN);
        if !engine_path.exists() {
            return Err(format!("compress-engine not found at {engine_path:?}"));
        }

        let mut cmd = Command::new(&engine_path);
        cmd.args([
            "compress",
            "--input", &path,
            "--profile", &profile,
            "--quality", &quality,
        ]);
        if let Some(n) = target_bytes.filter(|n| *n > 0) {
            cmd.arg("--target-bytes").arg(n.to_string());
        }
        let output = cmd
            .output()
            .map_err(|e| format!("Failed to execute compress engine: {e}"))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(format!("Compress engine failed: {stderr}"));
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        let result: serde_json::Value = serde_json::from_str(&stdout)
            .map_err(|e| format!("Failed to parse engine output: {e}\n{stdout}"))?;
        Ok(result)
    })
    .await
    .map_err(|e| format!("compress task failed: {e}"))??;
    Ok(result)
}

/// Get available compression profiles (e.g., "web", "print", "screen", "default").
#[tauri::command]
fn get_profiles(app_handle: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let exe_dir = app_handle
        .path()
        .resource_dir()
        .map(|p| p.to_path_buf())
        .or_else(|_| {
            std::env::current_exe().map(|p| p.parent().unwrap_or(Path::new(".")).to_path_buf())
        })
        .map_err(|e| e.to_string())?;

    let engine_path = exe_dir.join(ENGINE_BIN);
    if !engine_path.exists() {
        return Err(format!("compress-engine not found at {engine_path:?}"));
    }

    let output = Command::new(&engine_path)
        .arg("profiles")
        .output()
        .map_err(|e| format!("Failed to query profiles: {e}"))?;

    if !output.status.success() {
        return Err("Failed to query profiles".to_string());
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let result: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse profiles output: {e}"))?;
    Ok(result)
}

/// Compress multiple files (batch mode).
#[tauri::command]
fn batch_compress(
    app_handle: tauri::AppHandle,
    paths: Vec<String>,
    profile: String,
    quality: String,
    target_bytes: Option<u64>,
) -> Result<serde_json::Value, String> {
    // 批量压缩同样产出新文件：受授权闸门保护（FAMILY-LICENSE.md §2「及批量入口」）。
    // 目前前端未调用本命令（走 compress_file 逐文件循环），先接好闸门防将来漏拦。
    ensure_write_allowed()?;
    let exe_dir = app_handle
        .path()
        .resource_dir()
        .map(|p| p.to_path_buf())
        .or_else(|_| {
            std::env::current_exe().map(|p| p.parent().unwrap_or(Path::new(".")).to_path_buf())
        })
        .map_err(|e| e.to_string())?;

    let engine_path = exe_dir.join(ENGINE_BIN);
    if !engine_path.exists() {
        return Err(format!("compress-engine not found at {engine_path:?}"));
    }

    let mut args = vec![
        "batch".to_string(),
        "--profile".to_string(),
        profile,
        "--quality".to_string(),
        quality,
    ];
    if let Some(n) = target_bytes.filter(|n| *n > 0) {
        args.push("--target-bytes".to_string());
        args.push(n.to_string());
    }
    args.extend(paths.iter().map(|p| p.to_string()));

    let output = Command::new(&engine_path)
        .args(&args)
        .output()
        .map_err(|e| format!("Failed to execute batch compress: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("Batch compress failed: {stderr}"));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let result: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse batch output: {e}"))?;
    Ok(result)
}

/// Open a URL in the default browser (whitelist: rocktier.com + mailto).
/// Exact host match via URL parsing — a prefix check would let
/// `https://rocktier.com.evil.tld/` through.
#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let allowed = url::Url::parse(&url).is_ok_and(|u| match u.scheme() {
        "mailto" => true,
        "https" => {
            u.host_str() == Some("rocktier.com") || u.host_str() == Some("www.rocktier.com")
        }
        _ => false,
    });
    if !allowed {
        return Err("URL not allowed".to_string());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Size of a single file in bytes — the file list shows input sizes before
/// any compression happens (first principles: know what you're shrinking).
#[tauri::command]
fn file_size(path: String) -> Result<u64, String> {
    std::fs::metadata(&path).map(|m| m.len()).map_err(|e| e.to_string())
}

/// Reveal a compressed file in Finder/Explorer — the user must be able to
/// find the output without guessing the "_compressed" naming rule.
#[tauri::command]
fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

/// 引擎输出路径，复刻 Go 引擎的 outputFile()（main.go）："base_compressed" + ext。
fn compressed_output_path(input: &str) -> std::path::PathBuf {
    let p = Path::new(input);
    let ext = p
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let mut out = p.with_extension("").into_os_string();
    out.push("_compressed");
    out.push(ext);
    std::path::PathBuf::from(out)
}

/// 引擎用 os.Create 直接写输出，已有同名文件会被静默覆盖。前端在开始压缩前
/// 调用本命令，把已存在的输出路径列出来让用户确认。
#[tauri::command]
fn check_output_conflicts(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| compressed_output_path(p).exists())
        .collect()
}

/// Recursively list files under a directory (used by the "Add Folder" menu
/// action). Uses `walkdir` (already a dependency) so we don't shell out.
#[tauri::command]
fn list_files(dir: String) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for entry in walkdir::WalkDir::new(&dir).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            out.push(entry.path().to_string_lossy().into_owned());
        }
    }
    Ok(out)
}

/// Build the native application menu with family-standard structure.
#[tauri::command]
/// Menu labels for one language.
///
/// Same approach as the other five products' menus: a struct per language
/// instead of widening the old `l(zh, en)` closure to eight arguments — with
/// eight positional string arguments, swapping `ja` and `ko` compiles cleanly
/// and silently shows the wrong language. One field per call site makes that a
/// compile error.
///
/// Unknown codes fall back to English rather than panicking, so a stale
/// `localStorage` value degrades to a usable menu.
struct MenuStrings {
    app: &'static str,
    file: &'static str,
    edit: &'static str,
    view: &'static str,
    window: &'static str,
    add_files: &'static str,
    add_folder: &'static str,
    start: &'static str,
    help: &'static str,
    support: &'static str,
    website: &'static str,
    about: &'static str,
    license: &'static str,
}

impl MenuStrings {
    fn for_lang(lang: &str) -> Self {
        // Primary subtag, so "zh-CN" and "zh-Hans" both land on zh.
        let code = lang.split(['-', '_']).next().unwrap_or("");
        match code {
            "zh" => Self {
                app: "Rocktier Compressor", file: "文件", edit: "编辑", view: "显示",
                window: "窗口", add_files: "添加文件…", add_folder: "添加文件夹…",
                start: "开始压缩", help: "帮助", support: "获取支持",
                website: "访问 rocktier.com", about: "关于 Rocktier Compressor",
                license: "许可与激活…",
            },
            "ja" => Self {
                app: "Rocktier Compressor", file: "ファイル", edit: "編集", view: "表示",
                window: "ウインドウ", add_files: "ファイルを追加…", add_folder: "フォルダーを追加…",
                start: "圧縮を開始", help: "ヘルプ", support: "サポート",
                website: "rocktier.com を開く", about: "Rocktier Compressor について",
                license: "ライセンス…",
            },
            "ko" => Self {
                app: "Rocktier Compressor", file: "파일", edit: "편집", view: "보기",
                window: "창", add_files: "파일 추가…", add_folder: "폴더 추가…",
                start: "압축 시작", help: "도움말", support: "지원 받기",
                website: "rocktier.com 방문", about: "Rocktier Compressor 정보",
                license: "라이선스…",
            },
            "de" => Self {
                app: "Rocktier Compressor", file: "Datei", edit: "Bearbeiten", view: "Ansicht",
                window: "Fenster", add_files: "Dateien hinzufügen…", add_folder: "Ordner hinzufügen…",
                start: "Komprimieren starten", help: "Hilfe", support: "Support erhalten",
                website: "rocktier.com besuchen", about: "Über Rocktier Compressor",
                license: "Lizenz…",
            },
            "es" => Self {
                app: "Rocktier Compressor", file: "Archivo", edit: "Editar", view: "Ver",
                window: "Ventana", add_files: "Añadir archivos…", add_folder: "Añadir carpeta…",
                start: "Empezar a comprimir", help: "Ayuda", support: "Obtener soporte",
                website: "Visitar rocktier.com", about: "Acerca de Rocktier Compressor",
                license: "Licencia…",
            },
            "pt" => Self {
                app: "Rocktier Compressor", file: "Arquivo", edit: "Editar", view: "Exibir",
                window: "Janela", add_files: "Adicionar arquivos…", add_folder: "Adicionar pasta…",
                start: "Iniciar compressão", help: "Ajuda", support: "Obter suporte",
                website: "Visitar rocktier.com", about: "Sobre o Rocktier Compressor",
                license: "Licença…",
            },
            "ar" => Self {
                app: "Rocktier Compressor", file: "ملف", edit: "تحرير", view: "عرض",
                window: "نافذة", add_files: "إضافة ملفات…", add_folder: "إضافة مجلد…",
                start: "ابدأ الضغط", help: "مساعدة", support: "الحصول على الدعم",
                website: "زيارة rocktier.com", about: "حول Rocktier Compressor",
                license: "الترخيص…",
            },
            // English is both the family default and the fallback.
            _ => Self {
                app: "Rocktier Compressor", file: "File", edit: "Edit", view: "View",
                window: "Window", add_files: "Add Files…", add_folder: "Add Folder…",
                start: "Start Compress", help: "Help", support: "Get Support",
                website: "Visit rocktier.com", about: "About Rocktier Compressor",
                license: "License…",
            },
        }
    }
}

fn build_menu(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    let m = MenuStrings::for_lang(&lang);

    let add_i = MenuItem::with_id(&app, "add", m.add_files, true, Some("CmdOrCtrl+O"))
        .map_err(|e| e.to_string())?;
    let add_folder_i = MenuItem::with_id(&app, "add-folder", m.add_folder, true, Some("CmdOrCtrl+Shift+O"))
        .map_err(|e| e.to_string())?;
    let compress_i = MenuItem::with_id(&app, "compress", m.start, true, Some("CmdOrCtrl+Return"))
        .map_err(|e| e.to_string())?;

    let app_menu = Submenu::with_items(
        &app,
        m.app,
        true,
        &[
            &PredefinedMenuItem::about(
                &app,
                Some(m.about),
                                Some(AboutMetadata {
                    version: Some(env!("CARGO_PKG_VERSION").to_string()),
                    copyright: Some("Copyright 2026 Rocktier".to_string()),
                    ..Default::default()
                }),
            )
                .map_err(|e| e.to_string())?,
            &PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::hide(&app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::hide_others(&app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::show_all(&app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::quit(&app, None).map_err(|e| e.to_string())?,
        ],
    ).map_err(|e| e.to_string())?;

    let file_menu = Submenu::with_items(
        &app,
        m.file,
        true,
        &[
            &add_i,
            &add_folder_i,
            &PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?,
            &compress_i,
            &PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::close_window(&app, None).map_err(|e| e.to_string())?,
        ],
    ).map_err(|e| e.to_string())?;

    let edit_menu = Submenu::with_items(
        &app,
        m.edit,
        true,
        &[
            &PredefinedMenuItem::undo(&app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::redo(&app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::cut(&app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::copy(&app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::paste(&app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::select_all(&app, None).map_err(|e| e.to_string())?,
        ],
    ).map_err(|e| e.to_string())?;

    let view_menu = Submenu::with_items(
        &app,
        m.view,
        true,
        &[&PredefinedMenuItem::fullscreen(&app, None).map_err(|e| e.to_string())?],
    ).map_err(|e| e.to_string())?;

    let window_menu = Submenu::with_items(
        &app,
        m.window,
        true,
        &[
            &PredefinedMenuItem::minimize(&app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::fullscreen(&app, None).map_err(|e| e.to_string())?,
        ],
    ).map_err(|e| e.to_string())?;

    let help_menu = Submenu::with_items(
        &app,
        m.help,
        true,
        &[
            // 购买页面上写着"打开应用 → License → 输入激活码"，所以应用里必须真有一个能到
            // 那儿的入口（授权胶囊在已激活/商店版下会隐藏，帮助菜单是常驻入口）。
            &MenuItem::with_id(&app, "license", m.license, true, None::<&str>)
                .map_err(|e| e.to_string())?,
            &MenuItem::with_id(&app, "website", m.website, true, None::<&str>)
                .map_err(|e| e.to_string())?,
            &MenuItem::with_id(&app, "support", m.support, true, None::<&str>)
                .map_err(|e| e.to_string())?,
        ],
    ).map_err(|e| e.to_string())?;

    let menu = Menu::with_items(
        &app,
        &[&app_menu, &file_menu, &edit_menu, &view_menu, &window_menu, &help_menu],
    ).map_err(|e| e.to_string())?;

    app.set_menu(menu).map_err(|e| e.to_string())?;

    if let Some(main_window) = app.get_webview_window("main") {
        main_window.on_menu_event(move |window, event| {
            let _ = window.emit("menu-action", event.id().as_ref());
        });
    }

    Ok(())
}

#[tauri::command]
fn build_default_menu(app: tauri::AppHandle) -> Result<(), String> {
    build_menu(app, "en".to_string())
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().to_owned();
            let initial = {
                let mut q = PENDING_OPEN.lock().unwrap();
                let first = q.drain(..).next();
                first.or_else(file_from_args)
            };
            app.manage(InitialFile(Mutex::new(initial)));
            app.manage(Ready(AtomicBool::new(false)));
            // 授权状态的落盘目录。取不到就留空，current_license() 会按"不拦截"处理
            // —— 宁可少拦一次，也不能因为一个目录取不到把用户锁在外面（与 PDF/MD 同款）。
            if let Ok(dir) = app.path().app_data_dir() {
                init_license_dir(dir);
            }
            init_app_handle(handle.clone());
            let _ = build_default_menu(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                // Family-standard close-guard: intercept only after the frontend
                // has mounted (mark_ready). Before that, let the window close
                // normally so a failed startup can't leave a zombie window.
                let ready = window.state::<Ready>().0.load(Ordering::Acquire);
                if !ready {
                    return;
                }
                api.prevent_close();
                let _ = window.emit("app-close-requested", ());
            }
        })
        .invoke_handler(tauri::generate_handler![
            compress_file,
            get_profiles,
            batch_compress,
            list_files,
            reveal_path,
            file_size,
            check_output_conflicts,
            build_menu,
            initial_file,
            force_close,
            mark_ready,
            open_url,
            license_status,
            store_receipt,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, _event| {
        // Cold/hot-start file-open (macOS application:openURLs: → RunEvent::Opened).
        // On hot start the window exists, so emit straight to the UI; in both
        // cases buffer into PENDING_OPEN so setup can drain it on cold start.
        //
        // The `Opened` variant itself is cfg-gated to macOS upstream — without
        // this gate Windows builds fail with "no variant named `Opened`".
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = _event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    let p = path.to_string_lossy().into_owned();
                    if let Some(w) = _app_handle.get_webview_window("main") {
                        let _ = w.emit("opened-file", p.clone());
                    }
                    if let Ok(mut q) = PENDING_OPEN.lock() {
                        q.push(p);
                    }
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 验收（FAMILY-LICENSE.md §6）：把试用起始时间改到 30 天前，写命令的闸门
    /// `ensure_write_allowed` 的行为必须与 `ENFORCE` 开关一致 ——
    /// `ENFORCE=true`（官网上架可购后）：必须拦下并返回 `LICENSE_EXPIRED`；
    /// `ENFORCE=false`（当前，B.9-2 官网尚不可购）：只记账不拦人，恒放行。
    /// 构造法照 MD 模板：直接往状态目录里写起始时间戳。
    #[test]
    fn the_write_gate_behaves_according_to_the_enforce_switch() {
        let dir = std::env::temp_dir().join(format!("rt-co-license-gate-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // LICENSE_DIR 是进程级单例：本测试是唯一设置它的测试。若将来有人加第二条，
        // 后到的 set 会失败 —— 那时合并两条测试，不要让闸门测试静默跑偏。
        if LICENSE_DIR.set(dir.clone()).is_err() {
            panic!("LICENSE_DIR 已被其他测试设置，闸门测试无法控制状态目录");
        }

        // 试用期第一天：无论开关如何都放行。
        let now = now_secs();
        // 文件名即 license.rs 的 STATE_FILE（模块私有常量，这里按值写）。
        std::fs::write(dir.join("state.bin"), now.to_string()).unwrap();
        assert_eq!(ensure_write_allowed(), Ok(()), "试用期内写操作必须放行");

        // 把试用起始时间改到 30 天前：状态 = Expired。
        std::fs::write(dir.join("state.bin"), (now - 30 * 86_400).to_string()).unwrap();
        if license::ENFORCE {
            let err = ensure_write_allowed().unwrap_err();
            assert!(
                err.contains("LICENSE_EXPIRED"),
                "过期后写操作应返回 LICENSE_EXPIRED，实际为 {err}"
            );
        } else {
            // B.9-2：Compressor 官网尚不可购，闸门只记账不拦人。
            assert_eq!(
                ensure_write_allowed(),
                Ok(()),
                "ENFORCE=false 时过期也必须放行（官网上架可购后随开关自动收紧）"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }
}
