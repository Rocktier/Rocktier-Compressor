//! 试用期的机器指纹绑定。
//!
//! ## 要解决什么
//!
//! 试用期状态原本单点存在 AppData 的 `state.bin`。删掉它、或换个 Windows
//! 账户，就能重新拿满 7 天。这条路径人人都会踩 —— 卸载重装、清缓存、
//! 多用户切换。
//!
//! ## 明确不解决什么
//!
//! **这不是反破解，是成本抬升。** 业界的事实：Cursor 有公开的试用重置工具
//! （`Y0oshi/Cursor-Trial-Reset`），做法是重置 `MachineGuid` + 清
//! Local/Session Storage + 重写 telemetry ID。Adobe、Microsoft 靠的是
//! **账号体系**，不是本地指纹。
//!
//! 本地指纹是明牌，反制有标准套路。所以：
//! - 不要在 UI 或文案里承诺"防卸载重装" —— 做不到，会变成客诉；
//! - 这一层只承诺"拦顺手党"，专er 与工具类用户不在投入产出比内。
//!
//! ## 怎么拦
//!
//! 时间戳**不存一份，存两份**，判定时取**最早**：
//!
//! | 平台 | 主位置 | 副位置 |
//! |---|---|---|
//! | Windows | AppData `state.bin` | 注册表 `HKCU\Software\Rocktier\<App>\Trial` |
//! | macOS   | AppData `state.bin` | `~/Library/Preferences/com.rocktier.<app>.trial.plist` |
//!
//! 删掉任意一份，另一份仍能把起点拉回来。**两份都删仍然可绕过** ——
//! 那是"知道门道"的层级，与 Cursor 同档，不在本方案的目标内。
//!
//! ## 换机器 / 重装系统怎么办
//!
//! **重新给满 7 天。** 副位置里记着本机的指纹，与当前机器不一致就丢弃该记录。
//!
//! 理由：换电脑、装新系统的用户本来就是新用户，硬按旧时间戳算会让���一装上
//! 就看到"试用已结束"—— 而他压根没试过。这对口碑的伤害远大于多给 7 天。
//! 付费用户另有邮箱找回通道，不依赖这里。

use std::path::{Path, PathBuf};

/// 主存储的文件名（相对于应用数据目录）。沿用旧名 `state.bin` ——
/// 改名等于让所有老用户丢试用记录、白送 7 天。
const STATE_FILE: &str = "state.bin";

/// 单条试用记录的内容。序列化形如 `<时间戳>|<指纹>`。
#[derive(Debug, Clone, PartialEq)]
pub struct TrialRecord {
    pub started_at: i64,
    pub fingerprint: String,
}

impl TrialRecord {
    fn serialize(&self) -> String {
        format!("{}|{}", self.started_at, self.fingerprint)
    }

    /// 解析。**必须兼容旧格式**（裸整数，无指纹）—— 否则老用户一升级
    /// 就丢试用记录、白送 7 天。这是升级路径上的真实收入漏洞。
    fn parse(raw: &str) -> Option<Self> {
        let raw = raw.trim();
        if raw.is_empty() {
            return None;
        }
        match raw.split_once('|') {
            Some((ts, fp)) => Some(TrialRecord {
                started_at: ts.trim().parse().ok()?,
                fingerprint: fp.trim().to_string(),
            }),
            // 旧格式：裸时间戳。指纹留空 —— 空指纹在比对时按"同机"处理，
            // 这样老用户既不丢记录，也不会因为指纹缺失被判成新机器。
            None => Some(TrialRecord {
                started_at: raw.parse().ok()?,
                fingerprint: String::new(),
            }),
        }
    }
}

/// 取本机指纹。取不到时返回空串（空指纹按"无法判定"处理，见
/// `TrialRecord::same_machine`）。
///
/// 组成刻意避开单一易改项：
/// - Windows `MachineGuid`：装系统即定，但可被工具改写；
/// - macOS `IOPlatformUUID`：硬件级，比 MachineGuid 硬。
///
/// **不取 MAC 地址**（虚拟网卡可任意伪造）、**不取用户名/主机名**
///（改起来最方便）。
pub fn machine_fingerprint() -> String {
    #[cfg(target_os = "windows")]
    {
        windows_machine_guid()
    }
    #[cfg(target_os = "macos")]
    {
        macos_platform_uuid()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        String::new()
    }
}

#[cfg(target_os = "windows")]
fn windows_machine_guid() -> String {
    // reg.exe 而非注册表 API：省掉一个依赖，且只在启动时调用一次，
    // 性能无关。取不到就返回空串（不 panic —— 指纹是增强项，不是必需项）。
    std::process::Command::new("reg")
        .args([
            "query",
            r"HKLM\SOFTWARE\Microsoft\Cryptography",
            "/v",
            "MachineGuid",
        ])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| {
            // 输出形如 `    MachineGuid    REG_SZ    4f8b…`
            s.lines()
                .find(|l| l.contains("MachineGuid"))
                .and_then(|l| l.split_whitespace().last())
                .map(|v| format!("win:{}", v))
        })
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn macos_platform_uuid() -> String {
    std::process::Command::new("ioreg")
        .args(["-rd1", "-c", "IOPlatformExpertDevice"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .and_then(|s| {
            s.lines()
                .find(|l| l.contains("IOPlatformUUID"))
                .and_then(|l| l.split('"').nth(1))
                .map(|v| format!("mac:{}", v))
        })
        .unwrap_or_default()
}

/// 副存储的位置。`app_key` 是家族内唯一的产品标识（如 `pdf`）。
///
/// 选 `HKCU` 而非 `HKLM`：后者需要管理员权限，普通用户写不了；
/// 而 `HKCU` 随用户走，删 AppData 不会连带清掉。
/// Windows 副存储：**注册表** `HKCU\Software\Rocktier\<AppKey>\TrialStartedAt`。
///
/// 为什么是注册表而不是文件：AppData 与注册表是两套独立存储，
/// 删 AppData 不会连带清掉 HKCU —— 这正是"删一份仍能恢复"的前提。
///
/// 选 HKCU 而非 HKLM：后者需要管理员权限，普通用户写不了；
/// HKCU 随用户走，但删 AppData 时不会被一起清掉。
///
/// 读不到（如策略禁用、非常规沙箱）时回落到 AppData 下的文件，
/// 保证"拿不到副存储"不会变成"多给一次试用"以外更糟的故障。
#[cfg(target_os = "windows")]
fn secondary_read(app_key: &str) -> Option<String> {
    let out = std::process::Command::new("reg")
        .args(["query", r"HKCU\Software\Rocktier", "/v", app_key])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .and_then(|o| String::from_utf8(o.stdout).ok())?;
    out.lines()
        .find(|l| l.contains(app_key))
        .and_then(|l| l.split_whitespace().last())
        .map(|v| v.to_string())
}

#[cfg(target_os = "windows")]
fn secondary_write(app_key: &str, value: &str) -> bool {
    std::process::Command::new("reg")
        .args([
            "add",
            r"HKCU\Software\Rocktier",
            "/v",
            app_key,
            "/t",
            "REG_SZ",
            "/d",
            value,
            "/f",
        ])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// macOS 副存储：`~/Library/Preferences/com.rocktier.<app>.trial.plist`。
///
/// 卸载不删 `~/Library`，而主存储在 Application Support 下 —— 两者独立，
/// 与 Windows 上的 AppData / HKCU 关系相同。
#[cfg(target_os = "macos")]
fn secondary_path(app_key: &str) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home)
        .join("Library/Preferences")
        .join(format!("com.rocktier.{}.trial.plist", app_key))
}

#[cfg(target_os = "macos")]
fn secondary_read(app_key: &str) -> Option<String> {
    std::fs::read_to_string(secondary_path(app_key)).ok()
}

#[cfg(target_os = "macos")]
fn secondary_write(app_key: &str, value: &str) -> bool {
    std::fs::write(secondary_path(app_key), value).is_ok()
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn secondary_read(_app_key: &str) -> Option<String> {
    None
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
fn secondary_write(_app_key: &str, _value: &str) -> bool {
    false
}

/// 主存储的路径。副存储不走文件抽象（Windows 上是注册表），
/// 见 `secondary_read` / `secondary_write`。
pub fn primary_path(dir: &Path) -> PathBuf {
    dir.join(STATE_FILE)
}

/// 从主存储读一条记录。文件不存在或内容损坏都返回 `None`
/// （不panic —— 这个文件可能被用户删改，坏掉不该让应用起不来）。
pub fn read_record(path: &Path) -> Option<TrialRecord> {
    std::fs::read_to_string(path).ok().and_then(|r| TrialRecord::parse(&r))
}

/// 从副存储读一条记录。取不到返回 `None`（注册表被策略禁用、
/// HOME 未设置等）—— 那一路失效不该影响另一路。
fn read_secondary(app_key: &str) -> Option<TrialRecord> {
    secondary_read(app_key).and_then(|r| TrialRecord::parse(&r))
}

/// 写一条记录。失败只记日志不 panic —— 试用状态写不出去时，
/// 上层按"放行"处理（宁可多给一段试用，不能把人锁在门外）。
pub fn write_record(path: &Path, rec: &TrialRecord) {
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                eprintln!("license: cannot create trial dir {}: {e}", parent.display());
                return;
            }
        }
    }
    if let Err(e) = std::fs::write(path, rec.serialize()) {
        eprintln!("license: cannot write trial state {}: {e}", path.display());
    }
}

/// 两条记录是否属于同一台机器。
///
/// 空指纹（取不到指纹、或旧格式记录）按**同机**处理：
/// 宁可少拦一次，也不能因为指纹取不到就把付费后新装的用户判成新机器、
/// 白送 7 天。这与"失败方向选放行"是同一条准则。
pub fn same_machine(a: &str, current: &str) -> bool {
    a.is_empty() || current.is_empty() || a == current
}

/// 综合两处存储，得出生效的起始时间戳。
///
/// 规则：
/// 1. 只采信指纹与本机相符的记录（换机器 → 重新给满，见模块头）；
/// 2. 相符的记录里取**最早** —— 删掉任意一份都不会延长试用。
pub fn effective_start(dir: &Path, app_key: &str, current_fp: &str) -> Option<i64> {
    let from_primary = read_record(&primary_path(dir));
    let from_secondary = read_secondary(app_key);
    [from_primary, from_secondary]
        .into_iter()
        .flatten()
        .filter(|r| same_machine(&r.fingerprint, current_fp))
        .map(|r| r.started_at)
        .min()
}

/// 确保存在起始时间戳：没有（或已过期需重置）就写入当前时间。
///
/// **双写**：主位置与副存储都写。任一处成功即可 —— 单写的话，
/// 副存储就形同虚设，而主位置被删时副存储是唯一防线。
pub fn ensure_started(dir: &Path, app_key: &str, now: i64, current_fp: &str) -> i64 {
    if let Some(start) = effective_start(dir, app_key, current_fp) {
        return start;
    }
    let rec = TrialRecord { started_at: now, fingerprint: current_fp.to_string() };
    write_record(&primary_path(dir), &rec);
    if !secondary_write(app_key, &rec.serialize()) {
        // 副存储写失败不影响本次试用 —— 主存储仍然有效。
        // 只记日志：拿不到副存储意味着"删 AppData 就能重置"，
        // 但那本来就属于拦不住的层级，不该因此报错或拒绝启动。
        eprintln!("license: secondary trial store unavailable (app_key={app_key})");
    }
    now
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fp() -> String {
        "win:test-guid".to_string()
    }

    #[test]
    fn legacy_bare_integer_is_accepted() {
        // 升级路径：老用户的 state.bin 里是裸整数，不能判为损坏。
        let r = TrialRecord::parse("1700000000").expect("旧格式应能解析");
        assert_eq!(r.started_at, 1700000000);
        assert!(r.fingerprint.is_empty());
    }

    #[test]
    fn empty_fingerprint_counts_as_same_machine() {
        // 指纹取不到时不得把用户判成新机器（否则白送 7 天）。
        assert!(same_machine("", "win:abc"));
        assert!(same_machine("win:abc", ""));
        assert!(same_machine("", ""));
    }

    #[test]
    fn different_fingerprint_is_a_new_machine() {
        assert!(!same_machine("win:aaa", "win:bbb"));
        assert!(same_machine("win:aaa", "win:aaa"));
    }

    #[test]
    fn take_the_earliest_of_two_records() {
        let dir = std::env::temp_dir().join(format!("rt-trial-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        // 主位置写新的（较晚），副存储冒充为旧记录（较早）→ 应取较早的。
        let later = now_secs();
        let earlier = later - 5 * 86_400;
        write_record(&dir.join("state.bin"), &TrialRecord { started_at: later, fingerprint: fp() });
        secondary_write("rt-unit-1", &TrialRecord { started_at: earlier, fingerprint: fp() }.serialize());

        assert_eq!(effective_start(&dir, "rt-unit-1", &fp()), Some(earlier));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn other_machines_record_is_ignored() {
        let dir = std::env::temp_dir().join(format!("rt-trial-x{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        secondary_write("rt-unit-2", &TrialRecord { started_at: 1, fingerprint: "win:someone-else".into() }.serialize());
        // 该记录属于另一台机器 → 视为没试过。
        assert_eq!(effective_start(&dir, "rt-unit-2", &fp()), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn deleting_one_store_does_not_reset_the_trial() {
        let dir = std::env::temp_dir().join(format!("rt-trial-d{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);

        let start = ensure_started(&dir, "rt-unit-3", now_secs() - 3 * 86_400, &fp());
        // 删掉主位置（用户最可能删的那个），起点仍应从副存储拉回。
        let _ = std::fs::remove_file(primary_path(&dir));
        assert_eq!(effective_start(&dir, "rt-unit-3", &fp()), Some(start));

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// B-7-1：落盘失败（目录建不出来）也必须返回起始时间 —— 若上层拿到
    /// `None`，`status_from` 会判 `Expired`，新用户第一天就被锁死，连一次
    /// 保存都不能做。失败安全：宁可多给试用，不锁人。
    ///
    /// 这个回归防护随旧实现在 license.rs，迁移时一并带过来了。
    #[test]
    fn an_unwritable_state_dir_still_starts_the_trial() {
        // 用一个普通文件占住路径：对它 create_dir_all 必然失败，且无需管理员权限
        let blocker = std::env::temp_dir().join(format!("rt-trial-block-{}", std::process::id()));
        let _ = std::fs::remove_file(&blocker);
        std::fs::write(&blocker, "not a directory").unwrap();

        let started = ensure_started(&blocker.join("state"), "rt-unit-5", now_secs(), &fp());
        assert_eq!(started, now_secs(), "写失败也必须返回当前时间，绝不能当成无限试用");

        let _ = std::fs::remove_file(&blocker);
    }

    /// 副存储写失败（HKCU 不可写等）也不能丢记录 —— 主位置仍可读。
    #[test]
    fn one_writable_store_is_enough() {
        let dir = std::env::temp_dir().join(format!("rt-trial-w{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);

        let t0 = now_secs();
        let start = ensure_started(&dir, "rt-unit-4", t0, &fp());
        assert_eq!(start, t0);
        // 只删主位置，靠副存储把起点拉回来
        let _ = std::fs::remove_file(primary_path(&dir));
        assert_eq!(effective_start(&dir, "rt-unit-4", &fp()), Some(t0));

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn now_secs() -> i64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0)
    }
}