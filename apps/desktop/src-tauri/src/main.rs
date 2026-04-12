// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(target_os = "macos")]
use std::ffi::c_void;
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicPtr;
use tauri::{Emitter, Listener, Manager};

// ── File logging (visible when launched from Finder where stderr is lost) ────
fn log(msg: &str) {
    use std::io::Write;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let line = format!("[{}] {}\n", secs, msg);
    let log_path = std::env::temp_dir().join("coagent.log");
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
    {
        let _ = f.write_all(line.as_bytes());
    }
}

// ── Raw Objective-C helpers (avoid cocoa/objc crate dependencies) ────────────
#[cfg(target_os = "macos")]
unsafe fn sel(name: &str) -> *mut c_void {
    extern "C" { fn sel_registerName(name: *const u8) -> *mut c_void; }
    let cstr = std::ffi::CString::new(name).unwrap();
    sel_registerName(cstr.as_ptr() as *const u8)
}
#[cfg(target_os = "macos")]
unsafe fn objc_cls(name: &str) -> *mut c_void {
    extern "C" { fn objc_getClass(name: *const u8) -> *mut c_void; }
    let cstr = std::ffi::CString::new(name).unwrap();
    objc_getClass(cstr.as_ptr() as *const u8)
}
#[cfg(target_os = "macos")]
unsafe fn objc_msg(obj: *mut c_void, sel: *mut c_void) -> *mut c_void {
    extern "C" { fn objc_msgSend(obj: *mut c_void, sel: *mut c_void, ...) -> *mut c_void; }
    objc_msgSend(obj, sel)
}
#[cfg(target_os = "macos")]
unsafe fn objc_msg_1(obj: *mut c_void, sel: *mut c_void, arg: *mut c_void) -> *mut c_void {
    extern "C" { fn objc_msgSend(obj: *mut c_void, sel: *mut c_void, ...) -> *mut c_void; }
    objc_msgSend(obj, sel, arg)
}
#[cfg(target_os = "macos")]
unsafe fn objc_msg_bool(obj: *mut c_void, sel: *mut c_void, val: bool) -> *mut c_void {
    extern "C" { fn objc_msgSend(obj: *mut c_void, sel: *mut c_void, ...) -> *mut c_void; }
    objc_msgSend(obj, sel, val as i32)
}

#[cfg(target_os = "macos")]
unsafe fn objc_msg_2(obj: *mut c_void, sel: *mut c_void, a: *mut c_void, b: *mut c_void) -> *mut c_void {
    extern "C" { fn objc_msgSend(obj: *mut c_void, sel: *mut c_void, ...) -> *mut c_void; }
    objc_msgSend(obj, sel, a, b)
}
#[cfg(target_os = "macos")]
unsafe fn create_nsstring(s: &str) -> *mut c_void {
    let cls = objc_cls("NSString");
    let cstr = std::ffi::CString::new(s).unwrap();
    let alloc: *mut c_void = objc_msg(cls, sel("alloc"));
    objc_msg_1(alloc, sel("initWithUTF8String:"), cstr.as_ptr() as *mut c_void)
}

// Whether voice mode is enabled (controlled by frontend settings)
static VOICE_ENABLED: AtomicBool = AtomicBool::new(false);

// ── Activation nonce — guards coagent://activate deep links ──────────────────
// Stores (nonce_hex, unix_secs_at_creation). Cleared after first successful use.
static ACTIVATION_NONCE: Mutex<Option<(String, u64)>> = Mutex::new(None);
// Whether the CGEventTap thread has been spawned (only once, on first voice enable)
#[cfg(target_os = "macos")]
static EVENT_TAP_STARTED: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
static FN_DOWN: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static CTRL_DOWN: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static SYSTEM_SLEEPING: AtomicBool = AtomicBool::new(false);
#[cfg(target_os = "macos")]
static ROOT_PORT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
#[cfg(target_os = "macos")]
const FN_FLAG: u64 = 0x800000;
#[cfg(target_os = "macos")]
const CTRL_FLAG: u64 = 0x40000; // kCGEventFlagMaskControl

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
enum FnKeyEvent { Pressed, Released, Cancel }

#[cfg(target_os = "macos")]
static FN_SENDER: Mutex<Option<std::sync::mpsc::Sender<FnKeyEvent>>> = Mutex::new(None);

#[cfg(target_os = "macos")]
mod cg {
    use std::ffi::c_void;
    pub const K_CG_HID_EVENT_TAP: u32 = 0;
    pub const K_CG_HEAD_INSERT: u32 = 0;
    pub const K_CG_EVENT_TAP_OPTION_DEFAULT: u32 = 0;
    pub const K_CG_FLAGS_CHANGED: u32 = 12;
    pub fn event_mask_bit(t: u32) -> u64 { 1 << t }
    extern "C" {
        pub fn CGEventTapCreate(
            tap: u32, place: u32, options: u32, mask: u64,
            cb: extern "C" fn(*mut c_void, u32, *mut c_void, *mut c_void) -> *mut c_void,
            info: *mut c_void,
        ) -> *mut c_void;
        pub fn CGEventTapEnable(tap: *mut c_void, enable: bool);
        pub fn CGEventTapIsEnabled(tap: *mut c_void) -> bool;
        pub fn CGEventGetFlags(event: *mut c_void) -> u64;
        pub fn CFMachPortCreateRunLoopSource(alloc: *const c_void, port: *mut c_void, order: i64) -> *mut c_void;
        pub fn CFRunLoopGetCurrent() -> *mut c_void;
        pub fn CFRunLoopAddSource(rl: *mut c_void, source: *mut c_void, mode: *const c_void);
        pub fn CFRunLoopRun();
        pub static kCFRunLoopCommonModes: *const c_void;
    }
}

// Accessibility permission check — prompts the user if not granted
#[cfg(target_os = "macos")]
mod ax {
    use std::ffi::c_void;
    extern "C" {
        // Returns true if this process is trusted for Accessibility
        pub fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
        // CoreFoundation helpers to build the options dictionary
        pub fn CFDictionaryCreate(
            alloc: *const c_void,
            keys: *const *const c_void,
            values: *const *const c_void,
            count: isize,
            key_cbs: *const c_void,
            value_cbs: *const c_void,
        ) -> *const c_void;
        pub static kCFBooleanTrue: *const c_void;
        // Key: kAXTrustedCheckOptionPrompt
        pub static kAXTrustedCheckOptionPrompt: *const c_void;
        pub static kCFTypeDictionaryKeyCallBacks: c_void;
        pub static kCFTypeDictionaryValueCallBacks: c_void;
    }

    /// Check if we have Accessibility permission. If `prompt` is true, shows
    /// the macOS system dialog asking the user to grant it.
    pub fn is_trusted(prompt: bool) -> bool {
        unsafe {
            if prompt {
                let keys = [kAXTrustedCheckOptionPrompt];
                let values = [kCFBooleanTrue];
                let opts = CFDictionaryCreate(
                    std::ptr::null(),
                    keys.as_ptr(),
                    values.as_ptr(),
                    1,
                    &kCFTypeDictionaryKeyCallBacks as *const _ as *const c_void,
                    &kCFTypeDictionaryValueCallBacks as *const _ as *const c_void,
                );
                AXIsProcessTrustedWithOptions(opts)
            } else {
                AXIsProcessTrustedWithOptions(std::ptr::null())
            }
        }
    }
}

// IOKit power management — sleep/wake notifications
#[cfg(target_os = "macos")]
mod iokit {
    use std::ffi::c_void;
    pub const SYSTEM_WILL_SLEEP: u32 = 0xe0000280;
    pub const SYSTEM_HAS_POWERED_ON: u32 = 0xe0000300;
    pub const CAN_SYSTEM_SLEEP: u32 = 0xe0000240;

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        pub fn IORegisterForSystemPower(
            refcon: *mut c_void,
            notify_port: *mut *mut c_void,
            callback: extern "C" fn(*mut c_void, u32, u32, *mut c_void),
            notifier: *mut u32,
        ) -> u32;
        pub fn IOAllowPowerChange(kernel_port: u32, notification_id: isize) -> u32;
        pub fn IONotificationPortGetRunLoopSource(notify_port: *mut c_void) -> *mut c_void;
    }
}

#[cfg(target_os = "macos")]
extern "C" fn power_callback(
    _refcon: *mut c_void, _service: u32, msg_type: u32, msg_arg: *mut c_void,
) {
    let root_port = ROOT_PORT.load(Ordering::Relaxed);
    match msg_type {
        iokit::SYSTEM_WILL_SLEEP => {
            log("[Power] System sleeping — disabling event tap");
            SYSTEM_SLEEPING.store(true, Ordering::Release);
            let tap = EVENT_TAP.load(Ordering::Relaxed);
            if !tap.is_null() {
                unsafe { cg::CGEventTapEnable(tap, false); }
            }
            unsafe { iokit::IOAllowPowerChange(root_port, msg_arg as isize); }
        }
        iokit::SYSTEM_HAS_POWERED_ON => {
            log("[Power] System woke — re-enabling event tap");
            SYSTEM_SLEEPING.store(false, Ordering::Release);
            let tap = EVENT_TAP.load(Ordering::Relaxed);
            if !tap.is_null() {
                unsafe { cg::CGEventTapEnable(tap, true); }
            }
        }
        iokit::CAN_SYSTEM_SLEEP => {
            // Allow idle sleep — don't block it
            unsafe { iokit::IOAllowPowerChange(root_port, msg_arg as isize); }
        }
        _ => {}
    }
}

#[cfg(target_os = "macos")]
static EVENT_TAP: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

// Callback: detect fn edge, send to channel, suppress event.
// NOTE: The emoji picker CANNOT be suppressed from code — macOS handles Globe key
// in the kernel before CGEventTap fires. User must set System Settings → Keyboard →
// "Press Globe key to" → "Do Nothing". We set AppleFnUsageType=0 on startup as a hint.
#[cfg(target_os = "macos")]
extern "C" fn fn_key_callback(
    _proxy: *mut c_void, etype: u32, event: *mut c_void, _info: *mut c_void,
) -> *mut c_void {
    // 0xFFFFFFFE = tap disabled notification — re-enable and pass through
    if etype == 0xFFFFFFFE {
        let tap = EVENT_TAP.load(Ordering::Relaxed);
        if !tap.is_null() { unsafe { cg::CGEventTapEnable(tap, true); } }
        return event;
    }
    if !VOICE_ENABLED.load(Ordering::Relaxed) {
        return event;
    }

    let flags = unsafe { cg::CGEventGetFlags(event) };
    let is_fn = (flags & FN_FLAG) != 0;
    let is_ctrl = (flags & CTRL_FLAG) != 0;

    // Only process flagsChanged events
    if etype != cg::K_CG_FLAGS_CHANGED { return event; }

    let was_fn = FN_DOWN.load(Ordering::Relaxed);
    let was_ctrl = CTRL_DOWN.load(Ordering::Relaxed);

    // Track modifier state
    if is_fn != was_fn { FN_DOWN.store(is_fn, Ordering::Release); }
    if is_ctrl != was_ctrl { CTRL_DOWN.store(is_ctrl, Ordering::Release); }

    // Control+fn combo: detect edges
    let both_now = is_fn && is_ctrl;
    let both_before = was_fn && was_ctrl;

    if both_now && !both_before {
        // Control+fn just pressed together → voice trigger
        if let Ok(guard) = FN_SENDER.lock() { if let Some(tx) = guard.as_ref() { let _ = tx.send(FnKeyEvent::Pressed); } }
    } else if !both_now && both_before {
        // One of them released → voice release
        if let Ok(guard) = FN_SENDER.lock() { if let Some(tx) = guard.as_ref() { let _ = tx.send(FnKeyEvent::Released); } }
    }

    // Don't suppress the event — let fn/ctrl pass through normally
    event
}

struct ServerProcess(Arc<Mutex<Option<Child>>>);

/// Validate that a path is within allowed directories to prevent arbitrary file access.
fn is_allowed_path(path: &str) -> Result<std::path::PathBuf, String> {
    let p = std::path::Path::new(path);

    // Resolve symlinks to prevent escapes
    let canonical = p.canonicalize()
        .map_err(|e| format!("Cannot resolve path '{}': {}", path, e))?;

    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
    let home_path = std::path::Path::new(&home);

    let allowed_prefixes: Vec<std::path::PathBuf> = vec![
        home_path.join(".coagent"),
        home_path.join("Downloads"),
        home_path.join("Desktop"),
        home_path.join("Documents"),
        std::env::temp_dir(),
    ];

    // Explicitly deny dotfile dirs (except .coagent)
    if let Ok(rel) = canonical.strip_prefix(home_path) {
        if let Some(first) = rel.components().next() {
            let first_str = first.as_os_str().to_string_lossy();
            if first_str.starts_with('.') && first_str != ".coagent" {
                return Err(format!("Access denied: path is in a hidden directory: {}", path));
            }
        }
    }

    for prefix in &allowed_prefixes {
        if let Ok(canon_prefix) = prefix.canonicalize() {
            if canonical.starts_with(&canon_prefix) {
                return Ok(canonical);
            }
        }
        // If prefix doesn't exist yet, check without canonicalize
        if canonical.starts_with(prefix) {
            return Ok(canonical);
        }
    }

    Err(format!("Access denied: path '{}' is outside allowed directories", path))
}

/// File extensions that could execute code when opened
const DANGEROUS_EXTENSIONS: &[&str] = &[
    "command", "terminal", "app", "sh", "bash", "workflow", "action", "scpt", "applescript",
];

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    let canonical = is_allowed_path(&path)?;

    // Block executable file extensions
    if let Some(ext) = canonical.extension() {
        let ext_lower = ext.to_string_lossy().to_lowercase();
        if DANGEROUS_EXTENSIONS.contains(&ext_lower.as_str()) {
            return Err(format!("Cannot open executable file type: .{}", ext_lower));
        }
    }

    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(target_os = "windows")]
    let cmd = "cmd";
    #[cfg(target_os = "linux")]
    let cmd = "xdg-open";

    let path_str = canonical.to_string_lossy().to_string();
    #[cfg(target_os = "windows")]
    let args = vec!["/C".to_string(), "start".to_string(), "".to_string(), path_str.clone()];
    #[cfg(not(target_os = "windows"))]
    let args = vec![path_str.clone()];

    Command::new(cmd)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to open '{}': {}", path_str, e))?;
    Ok(())
}

#[tauri::command]
async fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    // `async` so Tauri runs this on the async runtime thread-pool rather than
    // the main thread — lets multiple thumbnails read in parallel without
    // blocking the UI. The file I/O itself is still sync (tiny payloads).
    let canonical = is_allowed_path(&path)?;
    std::fs::read(&canonical).map_err(|e| format!("Failed to read '{}': {}", path, e))
}

#[tauri::command]
fn reveal_in_file_manager(path: String) -> Result<(), String> {
    is_allowed_path(&path)?;
    let p = std::path::Path::new(&path);
    #[cfg(target_os = "macos")]
    {
        if p.is_file() {
            Command::new("open").args(["-R", &path]).spawn()
                .map_err(|e| format!("Failed to reveal '{}': {}", path, e))?;
        } else {
            Command::new("open").arg(&path).spawn()
                .map_err(|e| format!("Failed to open '{}': {}", path, e))?;
        }
    }
    #[cfg(target_os = "windows")]
    {
        if p.is_file() {
            Command::new("explorer").args(["/select,", &path]).spawn()
                .map_err(|e| format!("Failed to reveal '{}': {}", path, e))?;
        } else {
            Command::new("explorer").arg(&path).spawn()
                .map_err(|e| format!("Failed to open '{}': {}", path, e))?;
        }
    }
    #[cfg(target_os = "linux")]
    {
        let dir = if p.is_file() { p.parent().map(|p| p.to_str().unwrap_or(&path)).unwrap_or(&path) } else { &path };
        Command::new("xdg-open").arg(dir).spawn()
            .map_err(|e| format!("Failed to open '{}': {}", dir, e))?;
    }
    Ok(())
}

#[tauri::command]
fn get_ws_nonce() -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let nonce_path = std::path::Path::new(&home).join(".coagent").join(".ws-nonce");
    std::fs::read_to_string(&nonce_path)
        .map(|s| s.trim().to_string())
        .map_err(|e| format!("Failed to read WS nonce: {}", e))
}

#[tauri::command]
fn get_relay_credentials() -> Result<String, String> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    let cred_path = std::path::Path::new(&home).join(".coagent").join(".relay-credentials");
    std::fs::read_to_string(&cred_path)
        .map_err(|e| format!("Failed to read relay credentials: {}", e))
}

/// Generate a one-time activation nonce for the coagent://activate deep link.
///
/// Reads 32 cryptographically random bytes from the OS (`/dev/urandom` on
/// macOS/Linux) and hex-encodes them.  The nonce is stored alongside its
/// creation timestamp.  The deep link handler will reject any deep link whose
/// nonce doesn't match or whose nonce is older than 10 minutes.
#[tauri::command]
fn generate_activation_nonce() -> Result<String, String> {
    use std::io::Read;

    // Read 32 random bytes from the OS.
    let mut buf = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| format!("Failed to read /dev/urandom: {}", e))?;

    // Hex-encode into a 64-character string.
    let nonce: String = buf.iter().map(|b| format!("{:02x}", b)).collect();

    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();

    if let Ok(mut guard) = ACTIVATION_NONCE.lock() {
        *guard = Some((nonce.clone(), now_secs));
    } else {
        return Err("Failed to lock nonce state".to_string());
    }

    log(&format!("[Nonce] Activation nonce generated (expires in 10 min)"));
    Ok(nonce)
}

/// Check if the sidecar server process is alive.
/// Returns: "running", "crashed", or "not_found"
#[tauri::command]
fn server_status(state: tauri::State<'_, ServerProcess>) -> String {
    let guard = state.0.lock().unwrap();
    match guard.as_ref() {
        None => "not_found".to_string(),
        Some(_child) => {
            // try_wait isn't available on the borrowed child, so check if port is open
            match std::net::TcpStream::connect_timeout(
                &"127.0.0.1:7830".parse().unwrap(),
                std::time::Duration::from_millis(200),
            ) {
                Ok(_) => "running".to_string(),
                Err(_) => "starting".to_string(),
            }
        }
    }
}

fn find_server_binary() -> Option<std::path::PathBuf> {
    // The binary is in the same directory as the main executable.
    // Tauri's externalBin places it there automatically during bundling.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = if cfg!(target_os = "windows") { "coagent-server.exe" } else { "coagent-server" };
            let candidate = dir.join(name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn find_node_binary() -> Option<std::path::PathBuf> {
    // Bundled node sidecar — sits next to coagent-server in Contents/MacOS/
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let name = if cfg!(target_os = "windows") { "node.exe" } else { "node" };
            let candidate = dir.join(name);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Start the CGEventTap + channel reader threads for fn-key voice input.
/// Called lazily on first voice-mode enable so we never prompt for accessibility on launch.
#[cfg(target_os = "macos")]
fn start_event_tap() {
    log("[Voice] Starting CGEventTap threads (first voice enable)...");

    let trusted = ax::is_trusted(true); // NOW prompt — user explicitly enabled voice
    if trusted {
        log("[Tauri] Accessibility permission: granted");
    } else {
        log("[Tauri] Accessibility permission: NOT granted — prompting user");
    }

    let (tx, rx) = std::sync::mpsc::channel::<FnKeyEvent>();
    if let Ok(mut guard) = FN_SENDER.lock() {
        *guard = Some(tx);
    }

    // Thread 1: CGEventTap setup
    std::thread::spawn(move || {
        if !trusted {
            log("[Tauri] Waiting for Accessibility permission...");
            loop {
                std::thread::sleep(std::time::Duration::from_secs(2));
                if ax::is_trusted(false) {
                    log("[Tauri] Accessibility permission granted!");
                    break;
                }
            }
        }

        let _ = std::process::Command::new("defaults")
            .args(["write", "com.apple.HIToolbox", "AppleFnUsageType", "-int", "0"])
            .output();
        log("[Tauri] Set AppleFnUsageType=0 (Globe → Do Nothing)");

        unsafe {
            let mask = cg::event_mask_bit(cg::K_CG_FLAGS_CHANGED)
                     | cg::event_mask_bit(10)
                     | cg::event_mask_bit(11);
            let tap = cg::CGEventTapCreate(
                cg::K_CG_HID_EVENT_TAP,
                cg::K_CG_HEAD_INSERT,
                cg::K_CG_EVENT_TAP_OPTION_DEFAULT,
                mask,
                fn_key_callback,
                std::ptr::null_mut(),
            );
            if tap.is_null() {
                log("[Tauri] CGEventTap failed even after permission check");
                return;
            }
            EVENT_TAP.store(tap, Ordering::Release);
            log("[Tauri] CGEventTap active — fn key will trigger voice");
            let src = cg::CFMachPortCreateRunLoopSource(std::ptr::null(), tap, 0);
            let rl = cg::CFRunLoopGetCurrent();
            cg::CFRunLoopAddSource(rl, src, cg::kCFRunLoopCommonModes);
            cg::CGEventTapEnable(tap, true);

            let mut notify_port: *mut std::ffi::c_void = std::ptr::null_mut();
            let mut notifier: u32 = 0;
            let root_port = iokit::IORegisterForSystemPower(
                std::ptr::null_mut(),
                &mut notify_port,
                power_callback,
                &mut notifier,
            );
            if root_port != 0 {
                ROOT_PORT.store(root_port, Ordering::Release);
                let power_src = iokit::IONotificationPortGetRunLoopSource(notify_port);
                cg::CFRunLoopAddSource(rl, power_src, cg::kCFRunLoopCommonModes);
                log("[Power] Registered for sleep/wake notifications");
            } else {
                log("[Power] Failed to register for sleep/wake notifications");
            }

            cg::CFRunLoopRun();
        }
    });

    // Thread 2: Blocks on channel
    std::thread::spawn(move || {
        loop {
            match rx.recv_timeout(std::time::Duration::from_secs(10)) {
                Ok(evt) => {
                    let Some(handle) = APP_HANDLE.get() else { continue; };
                    match evt {
                        FnKeyEvent::Pressed => {
                            log("[Voice] fn pressed");
                            let _ = handle.emit("voice-fn-press", ());
                            if let Some(pill) = handle.get_webview_window("voice-pill") {
                                if let Ok(Some(monitor)) = pill.primary_monitor() {
                                    let screen = monitor.size();
                                    let scale = monitor.scale_factor();
                                    let logical_w = screen.width as f64 / scale;
                                    let logical_h = screen.height as f64 / scale;
                                    let pill_w = 440.0;
                                    let x = (logical_w - pill_w) / 2.0;
                                    let y = logical_h - 170.0;
                                    let _ = pill.set_position(tauri::LogicalPosition::new(x, y));
                                }
                                let _ = pill.show();
                            }
                        }
                        FnKeyEvent::Released => {
                            log("[Voice] fn released");
                            let _ = handle.emit("voice-fn-release", ());
                        }
                        FnKeyEvent::Cancel => {
                            log("[Voice] fn+Control — cancel");
                            let _ = handle.emit("voice-cancel", ());
                        }
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    if SYSTEM_SLEEPING.load(Ordering::Relaxed) { continue; }
                    let tap = EVENT_TAP.load(Ordering::Relaxed);
                    if !tap.is_null() && !unsafe { cg::CGEventTapIsEnabled(tap) } {
                        log("[Voice] Re-enabling disabled event tap");
                        unsafe { cg::CGEventTapEnable(tap, true); }
                    }
                }
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
}

// Minimal base64 decoder — avoids pulling in the base64 crate for one use.
fn base64_decode_from(input: &str) -> Result<Vec<u8>, String> {
    const DECODE: [i8; 128] = {
        let mut t = [-1i8; 128];
        let alphabet = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut i = 0usize;
        while i < alphabet.len() {
            t[alphabet[i] as usize] = i as i8;
            i += 1;
        }
        t
    };
    let bytes = input.as_bytes();
    let len = bytes.len();
    if len % 4 != 0 {
        return Err(format!("invalid base64 length {}", len));
    }
    let mut out = Vec::with_capacity(len / 4 * 3);
    let mut i = 0;
    while i < len {
        let c0 = bytes[i] as usize;
        let c1 = bytes[i + 1] as usize;
        let c2 = bytes[i + 2] as usize;
        let c3 = bytes[i + 3] as usize;
        if c0 >= 128 || c1 >= 128 {
            return Err(format!("invalid base64 char at {}", i));
        }
        let v0 = DECODE[c0];
        let v1 = DECODE[c1];
        if v0 < 0 || v1 < 0 {
            return Err(format!("invalid base64 char at {}", i));
        }
        out.push(((v0 as u8) << 2) | ((v1 as u8) >> 4));
        if bytes[i + 2] != b'=' {
            if c2 >= 128 { return Err(format!("invalid base64 char at {}", i + 2)); }
            let v2 = DECODE[c2];
            if v2 < 0 { return Err(format!("invalid base64 char at {}", i + 2)); }
            out.push(((v1 as u8 & 0x0f) << 4) | ((v2 as u8) >> 2));
            if bytes[i + 3] != b'=' {
                if c3 >= 128 { return Err(format!("invalid base64 char at {}", i + 3)); }
                let v3 = DECODE[c3];
                if v3 < 0 { return Err(format!("invalid base64 char at {}", i + 3)); }
                out.push(((v2 as u8 & 0x03) << 6) | (v3 as u8));
            }
        }
        i += 4;
    }
    Ok(out)
}

// Write bytes (passed as base64) to a path inside ~/.coagent.
//
// The app is sandboxed to its own data directory — callers cannot write
// anywhere else on the filesystem. If a user wants to save a file outside
// ~/.coagent, they should drag it out in Finder, or a future "Export As..."
// flow should use Tauri's native save dialog plugin (which returns an
// OS-verified path rather than a caller-supplied string).
//
// We validate the *parent* directory rather than the full path because the
// target file doesn't exist yet and can't be canonicalized directly.
#[tauri::command]
fn write_file_bytes(path: String, base64: String) -> Result<(), String> {
    let bytes = base64_decode_from(&base64).map_err(|e| format!("base64 decode: {}", e))?;

    let p = std::path::Path::new(&path);
    let parent = p.parent()
        .ok_or_else(|| format!("path has no parent directory: {}", path))?;

    // Filename must be a simple, non-traversing component.
    let filename = p.file_name()
        .ok_or_else(|| format!("path has no filename: {}", path))?;
    let filename_str = filename.to_string_lossy();
    if filename_str.is_empty() || filename_str == "." || filename_str == ".." {
        return Err(format!("write denied: invalid filename '{}'", filename_str));
    }

    // Create parent dir (idempotent) so we can canonicalize it to resolve symlinks.
    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir: {}", e))?;
    let canonical_parent = parent.canonicalize()
        .map_err(|e| format!("resolve parent '{}': {}", parent.display(), e))?;

    let home = std::env::var("HOME").unwrap_or_else(|_| "/root".to_string());
    let coagent_root = std::path::Path::new(&home).join(".coagent");
    let canonical_root = coagent_root.canonicalize().unwrap_or(coagent_root);

    if !canonical_parent.starts_with(&canonical_root) {
        return Err(format!(
            "write denied: '{}' is outside ~/.coagent",
            parent.display()
        ));
    }

    let target = canonical_parent.join(filename);
    std::fs::write(&target, &bytes).map_err(|e| format!("write: {}", e))?;
    Ok(())
}

// Write a PDF (passed as base64) to a path returned by the OS save dialog.
//
// The path MUST come from Tauri's native save dialog — the dialog itself
// enforces that the user explicitly chose the destination, so we trust it
// without further directory restriction. We still validate that:
//   • the path is absolute
//   • the filename ends with .pdf (case-insensitive)
//   • the path does not contain traversal components
//   • the parent directory exists (or can be created as a sibling of an existing dir)
#[tauri::command]
fn write_pdf_file(path: String, base64: String) -> Result<(), String> {
    let bytes = base64_decode_from(&base64).map_err(|e| format!("base64 decode: {}", e))?;

    let p = std::path::Path::new(&path);

    if !p.is_absolute() {
        return Err(format!("write_pdf_file: path must be absolute: {}", path));
    }

    // Ensure the filename ends with .pdf
    let filename = p.file_name()
        .ok_or_else(|| format!("write_pdf_file: path has no filename: {}", path))?;
    let filename_str = filename.to_string_lossy();
    if !filename_str.to_lowercase().ends_with(".pdf") {
        return Err(format!("write_pdf_file: filename must end with .pdf: {}", filename_str));
    }

    // Reject traversal in any path component
    for component in p.components() {
        let s = component.as_os_str().to_string_lossy();
        if s == ".." {
            return Err("write_pdf_file: path traversal not allowed".to_string());
        }
    }

    // Create parent directory if needed (e.g. user chose a new subfolder in the dialog)
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("write_pdf_file: mkdir '{}': {}", parent.display(), e))?;
    }

    std::fs::write(p, &bytes)
        .map_err(|e| format!("write_pdf_file: write '{}': {}", path, e))?;

    Ok(())
}

fn main() {
    log("CoAgent starting up");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_deep_link::init())
        .manage(ServerProcess(Arc::new(Mutex::new(None))))
        .setup(|app| {
            #[cfg(not(debug_assertions))]
            {
                let state_handle = app.state::<ServerProcess>().inner().0.clone();
                // Spawn server with a watchdog that auto-restarts on crash
                // Kill any orphaned coagent-server from a previous app launch
                // so we always run the current binary, not a stale one
                let _ = Command::new("pkill").args(["-f", "coagent-server"]).output();
                let _ = Command::new("lsof")
                    .args(["-ti:7830"])
                    .output()
                    .and_then(|out| {
                        let pids = String::from_utf8_lossy(&out.stdout);
                        for pid in pids.split_whitespace() {
                            let _ = Command::new("kill").args(["-9", pid]).output();
                        }
                        Ok(())
                    });
                // Brief pause to let the port release
                std::thread::sleep(std::time::Duration::from_millis(300));

                // Locate bundled node + vendor dir so we can pass them to the
                // server sidecar. This lets custom integrations run without
                // requiring the user to have Node.js installed.
                let node_path: Option<std::path::PathBuf> = find_node_binary();
                let vendor_dir: Option<std::path::PathBuf> = app
                    .path()
                    .resource_dir()
                    .ok()
                    .map(|d| d.join("vendor").join("node_modules"))
                    .filter(|p| p.exists());
                if let Some(n) = &node_path {
                    log(&format!("[Tauri] Bundled node: {}", n.display()));
                } else {
                    log("[Tauri] Bundled node NOT found next to executable");
                }
                if let Some(v) = &vendor_dir {
                    log(&format!("[Tauri] Vendor dir: {}", v.display()));
                } else {
                    log("[Tauri] Vendor dir NOT found in resources");
                }

                if let Some(server_path) = find_server_binary() {
                    let path = server_path.clone();
                    // Initial launch — pass bundled node + vendor as env vars
                    let mut cmd = Command::new(&path);
                    cmd.stdout(Stdio::null()).stderr(Stdio::null());
                    if let Some(n) = &node_path { cmd.env("COAGENT_NODE_PATH", n); }
                    if let Some(v) = &vendor_dir { cmd.env("COAGENT_VENDOR_DIR", v); }
                    match cmd.spawn() {
                        Ok(child) => {
                            log(&format!("[Tauri] Server started (pid: {})", child.id()));
                            *state_handle.lock().unwrap() = Some(child);
                        }
                        Err(e) => log(&format!("[Tauri] Failed to start server: {}", e)),
                    }
                    // Watchdog thread — checks every 5s, restarts if dead
                    let watchdog_state = state_handle.clone();
                    let watchdog_node = node_path.clone();
                    let watchdog_vendor = vendor_dir.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_secs(5));
                        let mut consecutive_failures = 0u32;
                        loop {
                            std::thread::sleep(std::time::Duration::from_secs(5));
                            let needs_restart = {
                                let mut guard = watchdog_state.lock().unwrap();
                                match guard.as_mut() {
                                    Some(ref mut child) => match Child::try_wait(child) {
                                        Ok(Some(status)) => {
                                            log(&format!("[Tauri] Server exited with {}", status));
                                            *guard = None;
                                            true
                                        }
                                        Ok(None) => false, // still running
                                        Err(e) => {
                                            log(&format!("[Tauri] Error checking server: {}", e));
                                            true
                                        }
                                    },
                                    None => true,
                                }
                            };
                            if needs_restart {
                                if consecutive_failures >= 5 {
                                    log("[Tauri] Server crashed 5 times — stopping restart attempts");
                                    break;
                                }
                                let backoff = std::time::Duration::from_secs(2u64.pow(consecutive_failures));
                                log(&format!("[Tauri] Restarting server (attempt {}, backoff {:?})", consecutive_failures + 1, backoff));
                                std::thread::sleep(backoff);
                                let mut cmd = Command::new(&path);
                                cmd.stdout(Stdio::null()).stderr(Stdio::null());
                                if let Some(n) = &watchdog_node { cmd.env("COAGENT_NODE_PATH", n); }
                                if let Some(v) = &watchdog_vendor { cmd.env("COAGENT_VENDOR_DIR", v); }
                                match cmd.spawn() {
                                    Ok(child) => {
                                        log(&format!("[Tauri] Server restarted (pid: {})", child.id()));
                                        *watchdog_state.lock().unwrap() = Some(child);
                                        consecutive_failures = 0;
                                    }
                                    Err(e) => {
                                        log(&format!("[Tauri] Restart failed: {}", e));
                                        consecutive_failures += 1;
                                    }
                                }
                            } else {
                                consecutive_failures = 0;
                            }
                        }
                    });
                } else {
                    log("[Tauri] No server binary found next to executable");
                }
            }
            #[cfg(debug_assertions)]
            log("[Tauri] Dev mode — skipping sidecar server (beforeDevCommand handles it)");

            let _ = APP_HANDLE.set(app.handle().clone());

            // Deep link: listen for coagent:// URLs and extract token or session_id.
            // Security: the URL must carry the nonce generated by `generate_activation_nonce`
            // just before the Stripe redirect.  If the nonce is present but invalid (wrong
            // value or expired), the deep link is silently dropped and a warning is logged.
            // If the nonce is absent we still allow activation but log a warning — this
            // preserves backwards compatibility during the transition period.
            const NONCE_TTL_SECS: u64 = 600; // 10 minutes
            let handle_for_deeplink = app.handle().clone();
            app.listen("deep-link://new-url", move |event| {
                if let Ok(urls) = serde_json::from_str::<Vec<String>>(event.payload()) {
                    for url in urls {
                        log(&format!("[DeepLink] Received: {}", url));
                        // Parse coagent://activate?token=xxx or coagent://activate?session_id=xxx&nonce=yyy
                        if let Some(query) = url.strip_prefix("coagent://activate") {
                            let query = query.strip_prefix('?').unwrap_or(query);
                            let mut params = std::collections::HashMap::new();
                            for pair in query.split('&') {
                                if let Some((key, value)) = pair.split_once('=') {
                                    params.insert(key.to_string(), value.trim().to_string());
                                }
                            }

                            // ── Nonce validation ─────────────────────────────────────────────
                            let incoming_nonce = params.get("nonce").map(|s| s.as_str());
                            match incoming_nonce {
                                None => {
                                    // No nonce supplied — allow but warn (backwards compat).
                                    log("[DeepLink] WARNING: deep link has no nonce — accepting for transition period");
                                }
                                Some(n) => {
                                    // Nonce present — validate against stored value.
                                    let now_secs = std::time::SystemTime::now()
                                        .duration_since(std::time::UNIX_EPOCH)
                                        .unwrap_or_default()
                                        .as_secs();

                                    let valid = match ACTIVATION_NONCE.lock() {
                                        Ok(guard) => {
                                            match guard.as_ref() {
                                                None => {
                                                    log("[DeepLink] WARNING: nonce provided but none was generated — rejecting");
                                                    false
                                                }
                                                Some((stored, created_at)) => {
                                                    if stored != n {
                                                        log("[DeepLink] WARNING: nonce mismatch — possible CSRF attempt, rejecting");
                                                        false
                                                    } else if now_secs.saturating_sub(*created_at) > NONCE_TTL_SECS {
                                                        log(&format!("[DeepLink] WARNING: nonce expired (age {}s > {}s) — rejecting", now_secs.saturating_sub(*created_at), NONCE_TTL_SECS));
                                                        false
                                                    } else {
                                                        true
                                                    }
                                                }
                                            }
                                        }
                                        Err(_) => {
                                            log("[DeepLink] WARNING: failed to lock nonce state — rejecting");
                                            false
                                        }
                                    };

                                    if !valid {
                                        continue; // drop this URL
                                    }

                                    // Nonce is valid — consume it (one-time use).
                                    if let Ok(mut guard) = ACTIVATION_NONCE.lock() {
                                        *guard = None;
                                        log("[DeepLink] Nonce consumed");
                                    }
                                }
                            }
                            // ── End nonce validation ──────────────────────────────────────────

                            if let Some(token) = params.get("token") {
                                if !token.is_empty() {
                                    log(&format!("[DeepLink] Token received: {}...", &token[..token.len().min(8)]));
                                    let _ = handle_for_deeplink.emit("deep-link-activate", serde_json::json!({ "token": token }));
                                }
                            }
                            if let Some(session_id) = params.get("session_id") {
                                if !session_id.is_empty() {
                                    log(&format!("[DeepLink] Checkout session: {}...", &session_id[..session_id.len().min(12)]));
                                    let _ = handle_for_deeplink.emit("deep-link-activate", serde_json::json!({ "sessionId": session_id }));
                                }
                            }
                        }
                    }
                }
            });

            // Voice pill: position at bottom center
            // NOTE: with_webview Obj-C styling removed — deadlocks the main thread in
            // release builds. Transparency is handled by tauri.conf.json + overlay.html CSS.
            if let Some(pill_win) = app.get_webview_window("voice-pill") {
                if let Ok(Some(monitor)) = pill_win.primary_monitor() {
                    let screen = monitor.size();
                    let scale = monitor.scale_factor();
                    let logical_w = screen.width as f64 / scale;
                    let logical_h = screen.height as f64 / scale;
                    let pill_w = 440.0;
                    let x = (logical_w - pill_w) / 2.0;
                    let y = logical_h - 170.0;
                    let _ = pill_win.set_position(tauri::LogicalPosition::new(x, y));
                }
                let _ = pill_win.set_ignore_cursor_events(true);
                log("[Tauri] Voice pill positioned (click-through)");
            }

            // Listen for voice mode toggle from frontend settings
            app.listen("set-voice-mode", |event| {
                // Payload is JSON: {"enabled": true/false}
                if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
                    let enabled = payload.get("enabled").and_then(|v| v.as_bool()).unwrap_or(false);
                    VOICE_ENABLED.store(enabled, Ordering::Release);
                    log(&format!("[Voice] Mode set to: {}", if enabled { "enabled" } else { "disabled" }));

                    if let Some(handle) = APP_HANDLE.get() {
                        if let Some(pill) = handle.get_webview_window("voice-pill") {
                            if enabled {
                                // Show and position the pill
                                if let Ok(Some(monitor)) = pill.primary_monitor() {
                                    let screen = monitor.size();
                                    let scale = monitor.scale_factor();
                                    let logical_w = screen.width as f64 / scale;
                                    let logical_h = screen.height as f64 / scale;
                                    let pill_w = 440.0;
                                    let x = (logical_w - pill_w) / 2.0;
                                    let y = logical_h - 170.0;
                                    let _ = pill.set_position(tauri::LogicalPosition::new(x, y));
                                }
                                let _ = pill.show();
                            } else {
                                let _ = pill.hide();
                            }
                        }
                    }

                    // macOS: Start CGEventTap thread on first voice enable (lazy — avoids accessibility prompt on launch)
                    #[cfg(target_os = "macos")]
                    if enabled && !EVENT_TAP_STARTED.swap(true, Ordering::AcqRel) {
                        start_event_tap();
                    }
                }
            });

            // macOS: CGEventTap threads are started lazily via set-voice-mode (no accessibility prompt on launch)

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            open_file,
            read_file_bytes,
            write_file_bytes,
            write_pdf_file,
            reveal_in_file_manager,
            server_status,
            get_ws_nonce,
            get_relay_credentials,
            generate_activation_nonce,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.lock().unwrap().take() {
            log("[Tauri] Killing server process");
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
