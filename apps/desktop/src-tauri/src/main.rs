// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::ffi::c_void;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicPtr, Ordering};
use std::sync::Mutex;
use tauri::{Emitter, Listener, Manager};

// ── File logging (visible when launched from Finder where stderr is lost) ────
fn log(msg: &str) {
    use std::io::Write;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let line = format!("[{}] {}\n", secs, msg);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open("/tmp/coagent.log")
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
// Whether fn key is currently held (for press/release edge detection in callback)
static FN_DOWN: AtomicBool = AtomicBool::new(false);
static CTRL_DOWN: AtomicBool = AtomicBool::new(false);
static SYSTEM_SLEEPING: AtomicBool = AtomicBool::new(false);
static ROOT_PORT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
const FN_FLAG: u64 = 0x800000;
const CTRL_FLAG: u64 = 0x40000; // kCGEventFlagMaskControl

#[derive(Clone, Copy)]
enum FnKeyEvent { Pressed, Released, Cancel }

// Channel sender — callback sends events here (non-blocking, nanoseconds)
static FN_SENDER: std::sync::OnceLock<std::sync::mpsc::Sender<FnKeyEvent>> = std::sync::OnceLock::new();

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

static EVENT_TAP: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
static APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

// Callback: nanoseconds of work — detect edge, send to channel, suppress event.
extern "C" fn fn_key_callback(
    _proxy: *mut c_void, etype: u32, event: *mut c_void, _info: *mut c_void,
) -> *mut c_void {
    // 0xFFFFFFFE = tap disabled notification — re-enable and pass through
    if etype == 0xFFFFFFFE {
        let tap = EVENT_TAP.load(Ordering::Relaxed);
        if !tap.is_null() { unsafe { cg::CGEventTapEnable(tap, true); } }
        return event;
    }
    // If voice mode is disabled, don't intercept fn key at all
    if !VOICE_ENABLED.load(Ordering::Relaxed) {
        return event;
    }

    let flags = unsafe { cg::CGEventGetFlags(event) };
    let is_fn = (flags & FN_FLAG) != 0;
    let is_ctrl = (flags & CTRL_FLAG) != 0;
    let was_down = FN_DOWN.load(Ordering::Relaxed);
    let ctrl_was_down = CTRL_DOWN.load(Ordering::Relaxed);

    // Detect Control press while fn is held → cancel voice
    if is_ctrl && !ctrl_was_down {
        CTRL_DOWN.store(true, Ordering::Release);
        if was_down || is_fn {
            // fn is held + Control just pressed → cancel
            if let Some(tx) = FN_SENDER.get() { let _ = tx.send(FnKeyEvent::Cancel); }
            return std::ptr::null_mut();
        }
    } else if !is_ctrl && ctrl_was_down {
        CTRL_DOWN.store(false, Ordering::Release);
    }

    if is_fn && !was_down {
        FN_DOWN.store(true, Ordering::Release);
        if let Some(tx) = FN_SENDER.get() { let _ = tx.send(FnKeyEvent::Pressed); }
        return std::ptr::null_mut(); // suppress emoji picker
    } else if !is_fn && was_down {
        FN_DOWN.store(false, Ordering::Release);
        if let Some(tx) = FN_SENDER.get() { let _ = tx.send(FnKeyEvent::Released); }
        return std::ptr::null_mut();
    }
    event
}

struct ServerProcess(Mutex<Option<Child>>);

#[tauri::command]
fn open_file(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(target_os = "windows")]
    let cmd = "cmd";
    #[cfg(target_os = "linux")]
    let cmd = "xdg-open";

    #[cfg(target_os = "windows")]
    let args = vec!["/C".to_string(), "start".to_string(), "".to_string(), path.clone()];
    #[cfg(not(target_os = "windows"))]
    let args = vec![path.clone()];

    Command::new(cmd)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to open '{}': {}", path, e))?;
    Ok(())
}

#[tauri::command]
fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    std::fs::read(&path).map_err(|e| format!("Failed to read '{}': {}", path, e))
}

#[tauri::command]
fn reveal_in_file_manager(path: String) -> Result<(), String> {
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

fn find_server_binary() -> Option<std::path::PathBuf> {
    // The binary is in the same directory as the main executable (Contents/MacOS/)
    // Tauri's externalBin places it there automatically during bundling
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join("coagent-server");
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn main() {
    log("CoAgent starting up");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            // In dev mode (debug builds), beforeDevCommand already starts the
            // backend via start-dev.js — don't launch the sidecar binary or it
            // will kill the running server and take over the port.
            #[cfg(not(debug_assertions))]
            if let Some(server_path) = find_server_binary() {
                log(&format!("[Tauri] Starting server: {:?}", server_path));
                match Command::new(&server_path)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                {
                    Ok(child) => {
                        log(&format!("[Tauri] Server started (pid: {})", child.id()));
                        let state: tauri::State<ServerProcess> = app.state();
                        *state.0.lock().unwrap() = Some(child);
                    }
                    Err(e) => {
                        log(&format!("[Tauri] Failed to start server: {}", e));
                    }
                }
            } else {
                log("[Tauri] No server binary found next to executable");
            }
            #[cfg(debug_assertions)]
            log("[Tauri] Dev mode — skipping sidecar server (beforeDevCommand handles it)");

            let _ = APP_HANDLE.set(app.handle().clone());

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
                log("[Tauri] Voice pill positioned");
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
                }
            });

            // Check Accessibility permission — prompt user if missing
            let trusted = ax::is_trusted(true); // true = show macOS prompt dialog
            if trusted {
                log("[Tauri] Accessibility permission: granted");
            } else {
                log("[Tauri] Accessibility permission: NOT granted — prompted user");
            }

            // Channel: callback sends events (nanoseconds), worker receives (blocks, zero CPU)
            let (tx, rx) = std::sync::mpsc::channel::<FnKeyEvent>();
            let _ = FN_SENDER.set(tx);

            // Thread 1: CGEventTap setup — waits for permission if needed, then runs RunLoop
            std::thread::spawn(move || {
                // If not trusted yet, poll every 2s until user grants permission
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

                unsafe {
                    let mask = cg::event_mask_bit(cg::K_CG_FLAGS_CHANGED);
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

                    // Register for system sleep/wake so we disable the tap before sleep
                    let mut notify_port: *mut c_void = std::ptr::null_mut();
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

            // Thread 2: Blocks on channel — zero CPU when idle, instant wake on fn key.
            // recv_timeout(10s) periodically re-enables the tap if macOS killed it.
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
                                        // Position pill at bottom center of primary monitor
                                        if let Ok(Some(monitor)) = pill.primary_monitor() {
                                            let screen = monitor.size();
                                            let scale = monitor.scale_factor();
                                            let logical_w = screen.width as f64 / scale;
                                            let logical_h = screen.height as f64 / scale;
                                            let pill_w = 440.0;
                                            let x = (logical_w - pill_w) / 2.0;
                                            let y = logical_h - 170.0; // above the dock
                                            let _ = pill.set_position(tauri::LogicalPosition::new(x, y));
                                        }
                                        let _ = pill.show();
                                    }
                                }
                                FnKeyEvent::Released => {
                                    log("[Voice] fn released");
                                    let _ = handle.emit("voice-fn-release", ());
                                    // Don't hide pill here — voice.ts hides it after showing response
                                }
                                FnKeyEvent::Cancel => {
                                    log("[Voice] fn+Control — cancel");
                                    let _ = handle.emit("voice-cancel", ());
                                }
                            }
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                            // Skip health check while system is sleeping
                            if SYSTEM_SLEEPING.load(Ordering::Relaxed) { continue; }
                            // Periodic health check: re-enable tap if macOS disabled it
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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_file, read_file_bytes, reveal_in_file_manager])
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
