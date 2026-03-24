fn main() {
    // Link ApplicationServices for AXIsProcessTrustedWithOptions
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-lib=framework=ApplicationServices");
    tauri_build::build()
}
