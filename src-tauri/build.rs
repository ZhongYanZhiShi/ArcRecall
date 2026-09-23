fn main() {
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build();
    // Native updater integration tests link Tauri's Windows UI dependencies too.
    // Include its Common Controls v6 manifest, which Tauri otherwise adds only to binaries.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        let resource =
            std::path::PathBuf::from(std::env::var_os("OUT_DIR").unwrap()).join("resource.lib");
        println!("cargo:rustc-link-arg-tests={}", resource.display());
    }
}
