// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::Command;
use std::sync::Mutex;
use tauri::Manager;
use tauri_plugin_shell::ShellExt;
use tauri_plugin_shell::process::CommandChild;

struct ServerProcess(Mutex<Option<CommandChild>>);

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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ServerProcess(Mutex::new(None)))
        .setup(|app| {
            // Use Tauri's sidecar API — it knows where the binary is in the bundle
            let sidecar_command = app.shell().sidecar("binaries/coagent-server")
                .map_err(|e| format!("Failed to create sidecar command: {}", e))?;

            match sidecar_command.spawn() {
                Ok((mut rx, child)) => {
                    println!("[Tauri] Server sidecar started (pid: {})", child.pid());
                    let state: tauri::State<ServerProcess> = app.state();
                    *state.0.lock().unwrap() = Some(child);

                    // Log sidecar output in background
                    tauri::async_runtime::spawn(async move {
                        use tauri_plugin_shell::process::CommandEvent;
                        while let Some(event) = rx.recv().await {
                            match event {
                                CommandEvent::Stdout(line) => {
                                    let text = String::from_utf8_lossy(&line);
                                    print!("[server] {}", text);
                                }
                                CommandEvent::Stderr(line) => {
                                    let text = String::from_utf8_lossy(&line);
                                    eprint!("[server] {}", text);
                                }
                                CommandEvent::Terminated(payload) => {
                                    println!("[Tauri] Server exited: {:?}", payload);
                                    break;
                                }
                                _ => {}
                            }
                        }
                    });
                }
                Err(e) => {
                    eprintln!("[Tauri] Failed to start server sidecar: {}", e);
                    // Fall through — frontend will show connection retry
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![open_file, read_file_bytes])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

impl Drop for ServerProcess {
    fn drop(&mut self) {
        if let Some(child) = self.0.lock().unwrap().take() {
            println!("[Tauri] Killing server sidecar");
            let _ = child.kill();
        }
    }
}
