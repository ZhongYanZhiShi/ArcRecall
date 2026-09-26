fn main() {
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build();
    // Both library unit tests and integration tests link Tauri's Windows UI dependencies.
    // Include Common Controls v6 for all targets; rustc-link-arg-tests excludes unit tests.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
        // Tauri already embeds the application manifest in each binary's resources.
        println!("cargo:rustc-link-arg-bins=/MANIFEST:NO");
    }
}
