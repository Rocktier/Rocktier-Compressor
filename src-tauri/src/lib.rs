use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri_plugin_opener::OpenerExt;
use tauri::{Emitter, Manager, WindowEvent};

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
fn compress_file(
    app_handle: tauri::AppHandle,
    path: String,
    profile: String,
    quality: String,
) -> Result<serde_json::Value, String> {
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
        .args([
            "compress",
            "--input", &path,
            "--profile", &profile,
            "--quality", &quality,
        ])
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
) -> Result<serde_json::Value, String> {
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
#[tauri::command]
fn open_url(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let allowed = url.starts_with("https://rocktier.com")
        || url.starts_with("mailto:");
    if !allowed {
        return Err("URL not allowed".to_string());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Reveal a compressed file in Finder/Explorer — the user must be able to
/// find the output without guessing the "_compressed" naming rule.
#[tauri::command]
fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().reveal_item_in_dir(&path).map_err(|e| e.to_string())
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
fn build_menu(app: tauri::AppHandle, lang: String) -> Result<(), String> {
    let zh = lang.starts_with("zh");
    let l = |zhv: &'static str, en: &'static str| if zh { zhv } else { en };

    let add_i = MenuItem::with_id(&app, "add", l("添加文件…", "Add Files…"), true, Some("CmdOrCtrl+O"))
        .map_err(|e| e.to_string())?;
    let add_folder_i = MenuItem::with_id(&app, "add-folder", l("添加文件夹…", "Add Folder…"), true, Some("CmdOrCtrl+Shift+O"))
        .map_err(|e| e.to_string())?;
    let compress_i = MenuItem::with_id(&app, "compress", l("开始压缩", "Start Compress"), true, Some("CmdOrCtrl+Return"))
        .map_err(|e| e.to_string())?;

    let app_menu = Submenu::with_items(
        &app,
        l("Rocktier Compressor", "Rocktier Compressor"),
        true,
        &[
            &PredefinedMenuItem::about(&app, Some(l("关于 Rocktier Compressor", "About Rocktier Compressor")), None)
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
        l("文件", "File"),
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
        l("编辑", "Edit"),
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
        l("显示", "View"),
        true,
        &[&PredefinedMenuItem::fullscreen(&app, None).map_err(|e| e.to_string())?],
    ).map_err(|e| e.to_string())?;

    let window_menu = Submenu::with_items(
        &app,
        l("窗口", "Window"),
        true,
        &[
            &PredefinedMenuItem::minimize(&app, None).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?,
            &PredefinedMenuItem::fullscreen(&app, None).map_err(|e| e.to_string())?,
        ],
    ).map_err(|e| e.to_string())?;

    let help_menu = Submenu::with_items(
        &app,
        l("帮助", "Help"),
        true,
        &[
            &MenuItem::with_id(&app, "website", l("访问 rocktier.com", "Visit rocktier.com"), true, None::<&str>)
                .map_err(|e| e.to_string())?,
            &MenuItem::with_id(&app, "support", l("获取支持", "Get Support"), true, None::<&str>)
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
            build_menu,
            initial_file,
            force_close,
            mark_ready,
            open_url,
        ]);

    let app = builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        // Cold/hot-start file-open (macOS application:openURLs: → RunEvent::Opened).
        // On hot start the window exists, so emit straight to the UI; in both
        // cases buffer into PENDING_OPEN so setup can drain it on cold start.
        if let tauri::RunEvent::Opened { urls } = event {
            for url in urls {
                if let Ok(path) = url.to_file_path() {
                    let p = path.to_string_lossy().into_owned();
                    if let Some(w) = app_handle.get_webview_window("main") {
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
