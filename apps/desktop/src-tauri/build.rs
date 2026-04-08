fn main() {
    // Link ApplicationServices for AXIsProcessTrustedWithOptions
    #[cfg(target_os = "macos")]
    {
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
        // Compile export_pdf.m — the WKWebView → PDF capture helper. Link
        // the WebKit, AppKit, and Foundation frameworks it needs.
        println!("cargo:rerun-if-changed=export_pdf.m");
        cc::Build::new()
            .file("export_pdf.m")
            .flag("-fobjc-arc")
            .compile("export_pdf");
        println!("cargo:rustc-link-lib=framework=WebKit");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }
    tauri_build::build()
}
