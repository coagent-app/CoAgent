// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::Manager;

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
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            if let Some(server_path) = find_server_binary() {
                eprintln!("[Tauri] Starting server: {:?}", server_path);
                match Command::new(&server_path)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                {
                    Ok(child) => {
                        eprintln!("[Tauri] Server started (pid: {})", child.id());
                        let state: tauri::State<ServerProcess> = app.state();
                        *state.0.lock().unwrap() = Some(child);
                    }
                    Err(e) => {
                        eprintln!("[Tauri] Failed to start server: {}", e);
                    }
                }
            } else {
                eprintln!("[Tauri] No server binary found next to executable");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_file, read_file_bytes])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.lock().unwrap().take() {
            eprintln!("[Tauri] Killing server process");
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
