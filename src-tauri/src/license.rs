//! 直链渠道的试用与授权 —— 准则 §12.3 的应用侧实现。
//!
//! 分两半，互相独立：
//!
//! 1. **试用**：首次启动落一个起始时间戳，之后按天算。纯本地、不联网。
//!    ⚠️ 删掉那个文件即可重置 —— 这是**已知且接受**的设计（§12.3 原文"容忍删除重置"）。
//!    它的目的是让愿意付费的人走完付费，不是拦住铁了心白用的人。
//!
//! 2. **回执**：用户在 `/license` 拿到激活码后，粘贴进应用 → 应用向
//!    `rocktier.com/api/activate` 换取一张**服务端签名**的回执 → 之后**离线验签**，
//!    永不联网。
//!
//! **为什么是签名而不是对称密钥**：代码未合并前的计划是"应用用与服务器相同的 secret
//! 本地校验激活码"。那样 secret 必须打进二进制，等于把它交给每一位用户 ——
//! 谁都能反编译取出并自制无限激活码。这里改为客户端只持有**公钥**（泄露无害），
//! 而激活码本身只在服务端校验（见 `rocktier.com/api/activate`）。
//!
//! **注意**：`ENFORCE` 为 `false` 时只记账、不拦截。在激活链路（服务端端点 + 密钥对 +
//! 应用侧引导 UI）全部就绪之前必须保持 `false`，否则会发出一个"7 天后无法解锁、
//! 且没有任何办法解锁"的包。

use std::path::{Path, PathBuf};

/// 试用天数。与 `terms.html` 对公众承诺的 7 天一致（改动须同步条款）。
pub const TRIAL_DAYS: i64 = 7;

/// 是否真的拦截写操作（本模块的总开关）。
///
/// 注意它**不单独决定**是否拦截 —— 还要看 `enforced()`：渠道必须是直链版、
/// 且公钥必须已配置。这样"忘了配公钥"或"商店版误开"都不会把用户锁在门外。
///
/// ⚠️ Compressor 当前为 `false`（规程 B.9-2）：官网尚不可购（rocktier.com 尚无
/// Compressor 购买条目），先只记账（试用状态照算、胶囊照显）不拦截。
/// **官网上架可购后改 true**；本文件尾部的
/// `a_configured_key_in_the_direct_channel_engages_the_gate` 随断言自动收紧。
pub const ENFORCE: bool = false;

/// 分发渠道。
///
/// **商店版与直链版必须分开**：商店版本的付费由微软代收，商店文案也声明"不启用试用"，
/// 所以它**绝不能**带有自研付费墙 —— 否则会触发微软政策 **10.8.2**（使用第三方购买
/// API 须在 Partner Center 申报、且须标明提供商并逐笔认证）与 **10.8.4**（须披露试用
/// 范围与价格区间）。
///
/// CI 里给 MSIX 那一份构建设 `ROCKTIER_CHANNEL=store`，其余（msi / nsis / dmg）走
/// 默认的 `direct`。**默认是 direct** 是有意的：商店包漏设这个变量会被政策卡住，
/// 而直链包漏设只是少拦一次，前者更该被发现，所以让"漏设"表现为默认的直链。
/// 用函数而不是 `const`：Rust 不允许在常量里对 `str` 做匹配（`cannot match on str
/// in constants`），而 `option_env!` 的取值本就不必在编译期完成比较。
pub fn channel() -> &'static str {
    if option_env!("ROCKTIER_CHANNEL") == Some("store") {
        "store"
    } else {
        "direct"
    }
}

/// 是否真的启用试用拦截。三个条件同时满足才启用：
///
/// 1. `ENFORCE` —— 总开关；
/// 2. 渠道是 `direct` —— 商店版由商店收款，不能带付费墙；
/// 3. **公钥已配置** —— 未配置时**没有人能激活**，此时开启拦截等于把每一位用户
///    在 7 天后锁死且无法解锁。这是最坏的一种失误，所以单独设一道防线。
///
/// 任一不满足都放行：方向刻意选**失败安全**（宁可不拦，不可锁人）。
pub fn enforced() -> bool {
    ENFORCE && channel() == "direct" && !PUBLIC_KEY_B64.trim().is_empty()
}

/// 服务端签名公钥（Ed25519，base64）。与 `rocktier.com` 环境变量 `LICENSE_PUBLIC_KEY`
/// 同源；可在 `tools/license-keygen.mjs` 生成密钥对时得到。
///
/// 留空表示**尚未配置**：此时任何回执都无法通过校验，授权一律判为无效（安全侧默认）。
pub const PUBLIC_KEY_B64: &str = "jIw3pZntprv6umUr4wFBz838/U4VvxRBHvLK08nri4M=";

/// 试用状态的落盘位置（相对于应用数据目录）。文件名故意平淡，不写成 "trial"。
const STATE_FILE: &str = "state.bin";

/// 本应用接受的授权产品码：**本单品自己 + 全家桶**。
///
/// ⚠️ 不能接受"任何产品码"。回执里的产品码来自激活码（`<产品码>:<交易号>`），而家族
/// 各单品是分别售卖的 —— 若照单全收，买一份 $4.99 的 pic2webp 就能解锁 PDF 应用，
/// 单品定价等于失效。准则 §12.3 的原话是 `accepted_products = [本应用, 家族]`，
/// 这里照它执行。
///
/// `CO` = Compressor 的单品码（待定码：MoR 落定后须与官网 `api/_shared.js` 两份 map
/// 同步核对）。`FL` = 全家桶。
pub const ACCEPTED_PRODUCTS: [&str; 2] = ["CO", "FL"];

/// 这份回执是否属于本应用可接受的授权。
pub fn accepts(receipt: &Receipt) -> bool {
    ACCEPTED_PRODUCTS.contains(&receipt.product.as_str())
}

/// 判定的结果。`days_left` 只用于界面提示，不参与是否放行的判断。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Status {
    /// 试用中，剩余天数（0 表示最后一天还没过完）。
    Trialing { days_left: i64 },
    /// 试用已过期，且没有有效回执。
    Expired,
    /// 已激活；`product` 来自回执（`CO` 单品 / `FL` 全家桶等）。
    Licensed { product: String },
}

impl Status {
    /// 是否允许写文件（保存、导出、压缩产出、拆分、加密等）。
    ///
    /// 只读操作（打开、翻页、渲染、搜索、读文本、列表单字段）一律不受影响 ——
    /// 用户到期后仍然**可以看**，只是不能**产出新文件**。这是 2026-09-20 用户定调。
    pub fn allows_write(&self, enforce: bool) -> bool {
        if !enforce {
            return true;
        }
        !matches!(self, Status::Expired)
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            Status::Trialing { .. } => "trial",
            Status::Expired => "expired",
            Status::Licensed { .. } => "licensed",
        }
    }
}

/// 服务端签发的回执内容。字段名与 `rocktier.com/api/activate` 的输出保持一致。
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize, PartialEq, Eq)]
pub struct Receipt {
    /// 产品码：`CO` / `SQ` / `WP` / `MD` / `CV` / `FL` 等（本应用只认 `CO` 与 `FL`）。
    pub product: String,
    /// 交易号（`txn_…` / `che_…`），用于人工核对。
    pub txn: String,
    /// 签发时间（Unix 秒）。
    pub issued_at: i64,
}

/// 计算自 `started_at` 起已过的整天数。抽出来是为了能在测试里喂固定时间。
fn elapsed_days(started_at: i64, now: i64) -> i64 {
    // 时间倒退（用户改了系统时钟）时视为 0 天，而不是负数。
    ((now - started_at).max(0)) / 86_400
}

/// 依据起始时间戳与是否有有效回执判定状态。
pub fn status_from(started_at: Option<i64>, receipt: Option<&Receipt>, now: i64) -> Status {
    if let Some(r) = receipt {
        return Status::Licensed { product: r.product.clone() };
    }
    match started_at {
        Some(start) => {
            let used = elapsed_days(start, now);
            if used < TRIAL_DAYS {
                Status::Trialing { days_left: (TRIAL_DAYS - used).max(0) }
            } else {
                Status::Expired
            }
        }
        // 没有起始戳也不该走到这里（`ensure_started` 会先写一个），保险起见按过期处理，
        // 避免"文件被删"反而变成无限试用。
        None => Status::Expired,
    }
}

/// 读取试用起始时间戳。文件不存在或内容损坏都返回 `None`（不 panic —— 这个文件
/// 可能被用户删改，坏掉不该让应用起不来）。
pub fn read_started_at(dir: &Path) -> Option<i64> {
    let raw = std::fs::read_to_string(dir.join(STATE_FILE)).ok()?;
    raw.trim().parse::<i64>().ok()
}

/// 确保存在起始时间戳，没有就写入当前时间并返回它。
///
/// 落盘失败**不能**返回 `None`：`status_from` 会把 `None` 判成 `Expired`，
/// 于是"state 文件一次都写不出去"的新用户在第一天就会被锁死（B-7-1）。
/// 失败方向刻意选**放行** —— 与 `commands.rs::current_license` 的"目录取不到
/// 按放行"同一条准则：宁可多给一段试用，不能把人锁在门外。
pub fn ensure_started(dir: &Path, now: i64) -> Option<i64> {
    if let Some(existing) = read_started_at(dir) {
        return Some(existing);
    }
    if let Err(e) = std::fs::create_dir_all(dir) {
        eprintln!("license: cannot create state dir {}: {e}", dir.display());
        return Some(now);
    }
    let path = dir.join(STATE_FILE);
    if let Err(e) = std::fs::write(&path, now.to_string()) {
        eprintln!("license: cannot write trial state {}: {e}", path.display());
        return Some(now);
    }
    Some(now)
}

/// 校验回执签名。`signed` 是服务端返回的 `"<base64(receipt_json)>.<base64(signature)>"`。
///
/// 公钥未配置、格式不对、签名不匹配 —— 一律返回 `Err`，绝不放行。
pub fn verify_receipt(signed: &str, public_key_b64: &str) -> Result<Receipt, String> {
    use base64::Engine as _;
    use ed25519_dalek::{Signature, Verifier, VerifyingKey};

    if public_key_b64.trim().is_empty() {
        return Err("no public key configured".to_string());
    }

    let (payload_b64, sig_b64) = signed
        .split_once('.')
        .ok_or_else(|| "malformed receipt".to_string())?;

    let engine = base64::engine::general_purpose::STANDARD;
    let payload = engine.decode(payload_b64).map_err(|e| format!("bad payload: {e}"))?;
    let sig_bytes = engine.decode(sig_b64).map_err(|e| format!("bad signature: {e}"))?;

    let key_bytes = engine
        .decode(public_key_b64)
        .map_err(|e| format!("bad public key: {e}"))?;
    let key_array: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| "public key must be 32 bytes".to_string())?;
    let key = VerifyingKey::from_bytes(&key_array).map_err(|e| format!("invalid key: {e}"))?;

    let sig = Signature::from_slice(&sig_bytes).map_err(|e| format!("invalid signature: {e}"))?;
    key.verify(&payload, &sig).map_err(|_| "signature does not match".to_string())?;

    serde_json::from_slice::<Receipt>(&payload).map_err(|e| format!("bad receipt body: {e}"))
}

/// 保存回执（连签名一起存，验签时不需要重新联网）。返回落盘路径。
///
/// 回执等于一张长期有效的许可证，按私密凭据对待：Unix 上以 0600 创建，
/// 同机的其他账户读不走；Windows 沿用该账户的默认 ACL。
pub fn save_receipt(dir: &Path, signed: &str) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join("receipt.txt");
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .map_err(|e| e.to_string())?;
        file.write_all(signed.as_bytes()).map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    std::fs::write(&path, signed).map_err(|e| e.to_string())?;
    Ok(path)
}

/// 读取并校验已保存的回执；没有或无效都返回 `None`。
pub fn read_valid_receipt(dir: &Path, public_key_b64: &str) -> Option<Receipt> {
    let signed = std::fs::read_to_string(dir.join("receipt.txt")).ok()?;
    verify_receipt(signed.trim(), public_key_b64).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400;
    const T0: i64 = 1_700_000_000;

    #[test]
    fn first_launch_starts_the_clock_and_second_launch_keeps_it() {
        let dir = std::env::temp_dir().join("rt-license-test-start");
        let _ = std::fs::remove_dir_all(&dir);

        let first = ensure_started(&dir, T0).unwrap();
        assert_eq!(first, T0, "首次启动应写入当前时间");
        let second = ensure_started(&dir, T0 + 3 * DAY).unwrap();
        assert_eq!(second, T0, "再次启动不得重置起始时间（否则试用永远不过期）");
    }

    /// B-7-1：落盘失败（目录建不出来）也必须返回起始时间 —— 若返回 `None`，
    /// `status_from` 会判 `Expired`，新用户第一天就被锁死，连一次保存都做不了。
    /// 失败安全：宁可多给试用，不锁人。
    #[test]
    fn an_unwritable_state_dir_still_starts_the_trial() {
        // 用一个普通文件占住路径：对它 create_dir_all 必然失败，且无需 root 权限。
        let blocker = std::env::temp_dir().join(format!("rt-license-block-{}", std::process::id()));
        let _ = std::fs::remove_file(&blocker);
        std::fs::write(&blocker, "not a directory").unwrap();

        let started = ensure_started(&blocker.join("state"), T0);
        assert_eq!(started, Some(T0), "写失败也必须返回起始时间，绝不能返回 None");

        let _ = std::fs::remove_file(&blocker);
    }

    #[test]
    fn trial_counts_down_and_then_expires() {
        assert_eq!(status_from(Some(T0), None, T0), Status::Trialing { days_left: 7 });
        assert_eq!(status_from(Some(T0), None, T0 + 6 * DAY), Status::Trialing { days_left: 1 });
        assert_eq!(status_from(Some(T0), None, T0 + 7 * DAY), Status::Expired);
        assert_eq!(status_from(Some(T0), None, T0 + 99 * DAY), Status::Expired);
    }

    #[test]
    fn a_backwards_clock_does_not_extend_or_break_the_trial() {
        // 用户把系统时间往回调：已用天数按 0 算，不能变成负数（那会得到一个超过 7 天的试用）。
        assert_eq!(status_from(Some(T0), None, T0 - 30 * DAY), Status::Trialing { days_left: 7 });
    }

    #[test]
    fn missing_state_is_not_an_endless_trial() {
        // 起始戳缺失（文件被删坏）时应按过期处理 —— 否则删文件就成了无限试用。
        assert_eq!(status_from(None, None, T0), Status::Expired);
    }

    #[test]
    fn a_valid_receipt_outranks_the_trial_state() {
        let r = Receipt { product: "CO".into(), txn: "txn_abc".into(), issued_at: T0 };
        assert_eq!(
            status_from(Some(T0), Some(&r), T0 + 99 * DAY),
            Status::Licensed { product: "CO".into() }
        );
    }

    #[test]
    fn write_is_blocked_only_when_enforcing_and_expired() {
        let expired = Status::Expired;
        let trialing = Status::Trialing { days_left: 3 };
        let licensed = Status::Licensed { product: "CO".into() };

        assert!(expired.allows_write(false), "未启用拦截时一律放行（当前线上状态）");
        assert!(!expired.allows_write(true), "启用拦截后过期用户不得写文件");
        assert!(trialing.allows_write(true), "试用期内可以写");
        assert!(licensed.allows_write(true), "已激活可以写");
    }

    /// 用固定的测试密钥做一次完整的签/验往返，并确认被篡改的回执会被拒。
    #[test]
    fn receipt_signature_roundtrip_and_tamper_rejection() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};

        let key = SigningKey::from_bytes(&[7u8; 32]);
        let pub_b64 = base64::engine::general_purpose::STANDARD
            .encode(key.verifying_key().to_bytes());

        let receipt = Receipt { product: "FL".into(), txn: "che_xyz".into(), issued_at: T0 };
        let payload = serde_json::to_vec(&receipt).unwrap();
        let sig = key.sign(&payload);
        let engine = base64::engine::general_purpose::STANDARD;
        let signed = format!("{}.{}", engine.encode(&payload), engine.encode(sig.to_bytes()));

        assert_eq!(verify_receipt(&signed, &pub_b64).unwrap(), receipt);

        // 逐字节篡改：改动正文里任意一个字节，签名必须对不上。
        let mut flipped = payload.clone();
        flipped[0] ^= 0x01;
        let forged = format!("{}.{}", engine.encode(&flipped), engine.encode(sig.to_bytes()));
        assert!(verify_receipt(&forged, &pub_b64).is_err(), "正文被改动后必须拒绝");

        // 语义篡改：把全家桶（FL）伪造成单品（CV），签名同样必须对不上。
        let mut swapped = receipt.clone();
        swapped.product = "CV".into();
        let swapped_payload = serde_json::to_vec(&swapped).unwrap();
        let forged = format!("{}.{}", engine.encode(&swapped_payload), engine.encode(sig.to_bytes()));
        assert!(verify_receipt(&forged, &pub_b64).is_err(), "签名与内容不匹配时必须拒绝");

        // 没配公钥的时候任何回执都不能通过。
        assert!(verify_receipt(&signed, "").is_err());
        assert!(verify_receipt("garbage", &pub_b64).is_err());
    }

    /// 与服务端对表：拿 `api/activate` **真正签出**的回执验一遍。
    ///
    /// 这条守的是最容易出错的那道缝 —— Node 与 Rust 之间的线格式（字段名、
    /// base64、payload 与签名的拼接方式）。两侧各自的单元测试都看不住它：各测各的
    /// 都对，合起来不通，而症状是"付了钱的用户激活不了"，只在真机上暴露。
    ///
    /// 用法：先在 rocktier.com 下跑
    ///   node tools/activation-fixture.mjs > /tmp/activation-fixture.json
    /// 再在本目录下跑
    ///   ROCKTIER_ACTIVATION_FIXTURE=/tmp/activation-fixture.json cargo test activation
    /// 未设该环境变量时跳过（CI 不依赖它）。
    #[test]
    fn verifies_a_receipt_minted_by_the_server() {
        let path = match std::env::var("ROCKTIER_ACTIVATION_FIXTURE") {
            Ok(p) => p,
            Err(_) => return,
        };
        let raw = std::fs::read_to_string(&path).expect("夹具文件必须可读");
        let v: serde_json::Value = serde_json::from_str(&raw).expect("夹具必须是 JSON");
        let receipt = v["receipt"].as_str().expect("夹具缺少 receipt");
        let pubkey = v["publicKey"].as_str().expect("夹具缺少 publicKey");
        let product = v["product"].as_str().unwrap_or("");
        let txn = v["txn"].as_str().unwrap_or("");

        let got = verify_receipt(receipt, pubkey).expect("服务端签出的回执必须验得过");
        assert_eq!(got.product, product, "回执里的产品码应与夹具一致");
        assert_eq!(got.txn, txn, "回执里的交易号应与夹具一致");
        assert!(got.issued_at > 0, "签发时间应是一个真实时间戳");

        // 换一把公钥就不能通过（防止"签名其实没被检查"这种假通过）。
        let other = ed25519_dalek::SigningKey::from_bytes(&[42u8; 32]);
        let other_b64 = {
            use base64::Engine as _;
            base64::engine::general_purpose::STANDARD.encode(other.verifying_key().to_bytes())
        };
        assert!(
            verify_receipt(receipt, &other_b64).is_err(),
            "换公钥后必须验不过，否则说明这条测试根本没在验签名"
        );
    }

    /// 守最坏的那种失误：公钥没配就开启拦截 ⇒ 用户 7 天后被锁死，且没有任何办法解锁
    /// （激活要拿回执，而没公钥就验不过任何回执）。所以只要公钥是空的，拦截就必须关闭。
    #[test]
    fn the_gate_cannot_engage_without_a_public_key() {
        if PUBLIC_KEY_B64.trim().is_empty() {
            assert!(
                !enforced(),
                "未配置公钥时绝不能启用拦截 —— 否则用户被锁死后无法激活"
            );
        }
        // 商店版同理：付费由商店代收，应用里不得出现付费墙。
        if channel() == "store" {
            assert!(!enforced(), "商店版不得启用自研试用拦截（微软政策 10.8.2 / 10.8.4）");
        }
    }

    /// 嵌进来的公钥必须是**合法**的 Ed25519 公钥。
    ///
    /// 守的是"手抄错误"：这个常量是人工粘贴进来的，多一个字符、少一个字符、或
    /// base64 解出来不是 32 字节，后果都是**每一份回执都验不过** —— 而症状与"用户
    /// 把激活码输错了"完全一样，只有付过钱的人才会发现。所以在构建期就验它。
    ///
    /// 留空是允许的（开发期尚未配置），此时跳过。
    #[test]
    fn the_embedded_public_key_parses() {
        if PUBLIC_KEY_B64.trim().is_empty() {
            return;
        }
        use base64::Engine as _;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(PUBLIC_KEY_B64.trim())
            .expect("PUBLIC_KEY_B64 必须是合法 base64");
        let arr: [u8; 32] = bytes.try_into().expect("Ed25519 公钥必须是 32 字节");
        ed25519_dalek::VerifyingKey::from_bytes(&arr)
            .expect("必须是合法的 Ed25519 公钥（一个有效的曲线点）");
    }

    /// 公钥已配、且为直链版时，闸门必须**真的开着**。
    ///
    /// 与前一条互补：那条防"没钥匙就开门"（把用户锁死），这条防"配了钥匙却没开门"
    /// （试用永不到期，等于白做）。两者都是安静故障，所以两条都要有。
    ///
    /// Compressor 特例（规程 B.9-2）：官网尚不可购，`ENFORCE=false` 只记账不拦截；
    /// 此时本测试反过来钉住"没开门"。官网上架可购后把 `ENFORCE` 改回 `true`，
    /// 断言自动切回"必须开门"，无需再改测试。
    #[test]
    fn a_configured_key_in_the_direct_channel_engages_the_gate() {
        if !PUBLIC_KEY_B64.trim().is_empty() && channel() == "direct" {
            if ENFORCE {
                assert!(
                    enforced(),
                    "公钥已配置且渠道为直链版，闸门应处于开启状态 —— 否则试用永不到期"
                );
            } else {
                assert!(
                    !enforced(),
                    "ENFORCE=false（B.9-2：官网尚不可购）必须只记账不拦截"
                );
            }
        }
    }

    /// 只有本单品与全家桶的码算授权。这条防的是一次定价失效：家族各单品单独售卖，
    /// 若"任何产品码都收"，买一份 $4.99 的 pic2webp 就能解锁 PDF 应用。
    #[test]
    fn only_this_product_and_the_family_bundle_are_accepted() {
        let make = |p: &str| Receipt {
            product: p.into(),
            txn: "txn_x".into(),
            issued_at: T0,
        };
        assert!(accepts(&make("CO")), "本单品的码必须接受");
        assert!(accepts(&make("FL")), "全家桶的码必须接受");
        for other in ["WP", "MD", "CV", "SQ"] {
            assert!(
                !accepts(&make(other)),
                "别的单品的码不得接受（{other}）—— 否则单品定价形同虚设"
            );
        }
        assert!(!accepts(&make("")), "空产品码不得接受");
        assert!(!accepts(&make("sq")), "产品码区分大小写（大小写不符即为非本应用）");
    }

    #[test]
    fn saving_and_reading_back_a_receipt() {
        use base64::Engine as _;
        use ed25519_dalek::{Signer, SigningKey};

        let dir = std::env::temp_dir().join("rt-license-test-receipt");
        let _ = std::fs::remove_dir_all(&dir);

        let key = SigningKey::from_bytes(&[3u8; 32]);
        let pub_b64 = base64::engine::general_purpose::STANDARD
            .encode(key.verifying_key().to_bytes());
        let receipt = Receipt { product: "CO".into(), txn: "txn_1".into(), issued_at: T0 };
        let payload = serde_json::to_vec(&receipt).unwrap();
        let engine = base64::engine::general_purpose::STANDARD;
        let signed = format!("{}.{}", engine.encode(&payload), engine.encode(key.sign(&payload).to_bytes()));

        save_receipt(&dir, &signed).unwrap();
        assert_eq!(read_valid_receipt(&dir, &pub_b64).unwrap(), receipt);
        // 回执是长期凭据，落盘必须只有属主可读写（B-7-2）。
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(dir.join("receipt.txt"))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "回执文件必须是 0600");
        }
        // 公钥不对时读不回来（回执被换产品/换密钥签的都会落到这里）。
        let other = SigningKey::from_bytes(&[9u8; 32]);
        let other_b64 = engine.encode(other.verifying_key().to_bytes());
        assert!(read_valid_receipt(&dir, &other_b64).is_none());
    }
}
