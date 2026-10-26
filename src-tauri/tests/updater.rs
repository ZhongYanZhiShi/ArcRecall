use std::io::{Read, Write};
use std::net::TcpListener;
use std::time::Duration;
use std::time::Instant;
use tauri_plugin_updater::UpdaterExt;

const PAYLOAD: &[u8] = include_bytes!("fixtures/updater/payload.txt");
const PUBLIC_KEY: &str = include_str!("fixtures/updater/public-key.txt");
const SIGNATURE: &str = include_str!("fixtures/updater/payload.txt.sig");

#[path = "../src/update_cache.rs"]
mod update_cache;

// Public test vectors from tauri-plugin-updater 2.14.0 offline_tests (payload: `test`).
const VERSIONED_KEY: &str = include_str!("fixtures/updater/versioned-public-key.txt");
const VERSIONED_SIGNATURE: &str = include_str!("fixtures/updater/versioned-payload.sig");

fn cached_manifest() -> serde_json::Value {
    serde_json::json!({ "version": "2.0.0", "notes": "离线更新说明", "platforms": {
        "test-target": { "url": "https://example.invalid/package", "signature": VERSIONED_SIGNATURE }
    }})
}

#[test]
fn cached_package_survives_restart_and_rejects_changed_bytes_or_version() {
    for changed in ["none", "bytes", "version", "missing", "obsolete"] {
        let directory = tempfile::tempdir().unwrap();
        let manifest = cached_manifest();
        update_cache::save_cached(directory.path(), &manifest, b"test").unwrap();
        // Exercise replacement too, including Windows atomic-file behavior.
        update_cache::save_cached(directory.path(), &manifest, b"test").unwrap();
        match changed {
            "bytes" => std::fs::write(directory.path().join("package.bin"), b"changed").unwrap(),
            "missing" => std::fs::remove_file(directory.path().join("package.bin")).unwrap(),
            "version" | "obsolete" => {
                let mut manifest = manifest.clone();
                manifest["version"] = serde_json::json!(if changed == "version" {
                    "9.0.0"
                } else {
                    "0.0.1"
                });
                std::fs::write(
                    directory.path().join("release.json"),
                    serde_json::to_vec(&manifest).unwrap(),
                )
                .unwrap();
            }
            _ => {}
        }
        let (_app, native) = native_updater_with_key("https://example.invalid", VERSIONED_KEY);
        let result = update_cache::restore_cached(&native, directory.path());
        if changed == "none" {
            let (update, bytes) = result.unwrap().unwrap();
            assert_eq!(bytes, b"test");
            assert_eq!(update.version, "2.0.0");
        } else {
            if changed == "obsolete" {
                assert!(result.unwrap().is_none());
            } else {
                assert!(result.is_err());
            }
            assert!(!directory.path().join("release.json").exists());
            assert!(!directory.path().join("package.bin").exists());
        }
    }
}

// Real loopback HTTP and signature verification; only the window runtime is mocked.
// Never execute an installer or use the production signing key in these tests.
fn server(
    version: &str,
    payload: Vec<u8>,
    requests: usize,
) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    let manifest = serde_json::json!({
        "version": version,
        "notes": "Native updater fixture",
        "platforms": { "test-target": {
            "url": format!("{address}/installer"), "signature": SIGNATURE.trim()
        }}
    })
    .to_string();
    let worker = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(10);
        let mut served = 0;
        while served < requests && Instant::now() < deadline {
            let (mut stream, _) = match listener.accept() {
                Ok(client) => client,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(5));
                    continue;
                }
                Err(error) => panic!("{error}"),
            };
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0; 4096];
            let length = stream.read(&mut request).unwrap();
            let body = if request[..length].starts_with(b"GET /installer ") {
                payload.as_slice()
            } else {
                manifest.as_bytes()
            };
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
            served += 1;
        }
        assert_eq!(served, requests);
    });
    (address, worker)
}

fn native_updater(
    endpoint: &str,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    tauri_plugin_updater::Updater,
) {
    native_updater_with_key(endpoint, PUBLIC_KEY)
}

fn native_updater_with_key(
    endpoint: &str,
    public_key: &str,
) -> (
    tauri::App<tauri::test::MockRuntime>,
    tauri_plugin_updater::Updater,
) {
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    context.config_mut().plugins.0.insert(
        "updater".into(),
        serde_json::json!({
            "pubkey": public_key.trim(),
            "endpoints": [endpoint],
            "dangerousInsecureTransportProtocol": true
        }),
    );
    let app = tauri::test::mock_builder()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .build(context)
        .unwrap();
    let updater = app
        .updater_builder()
        .target("test-target")
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap();
    (app, updater)
}

#[test]
fn native_download_accepts_signed_payload_and_rejects_tampering() {
    for tampered in [false, true] {
        let mut payload = PAYLOAD.to_vec();
        if tampered {
            payload[0] ^= 1;
        }
        let (endpoint, worker) = server("99.0.0", payload, 2);
        let (_app, native) = native_updater(&endpoint);
        let update = tauri::async_runtime::block_on(native.check())
            .unwrap()
            .unwrap();
        let mut downloaded = 0;
        let result =
            tauri::async_runtime::block_on(update.download(|chunk, _| downloaded += chunk, || {}));
        if tampered {
            assert!(result.is_err());
        } else {
            assert_eq!(result.unwrap(), PAYLOAD);
            assert_eq!(downloaded, PAYLOAD.len());
        }
        worker.join().unwrap();
    }
}

#[test]
fn native_version_check_rejects_current_and_older_releases() {
    for version in ["0.1.0", "0.0.1"] {
        let (endpoint, worker) = server(version, PAYLOAD.to_vec(), 1);
        let (_app, native) = native_updater(&endpoint);
        assert!(
            tauri::async_runtime::block_on(native.check())
                .unwrap()
                .is_none()
        );
        worker.join().unwrap();
    }
}
