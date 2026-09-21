use std::ffi::OsString;
use std::io::{BufReader, BufWriter, Write};
use std::time::Duration;

use super::*;

const SEVEN_ZIP_START_HEADER_SIZE_FOR_TEST: usize = 32;

/// Read-only timing probe for large archives, including disguised split volumes.
#[test]
#[ignore = "set ARC_RECALL_PROFILE_ARCHIVE to a local archive path"]
fn profile_archive_fingerprint() {
    let archive = std::env::var_os("ARC_RECALL_PROFILE_ARCHIVE").expect("archive path");
    let started = std::time::Instant::now();
    let analysis = analyze_archive(PathBuf::from(archive)).unwrap();
    eprintln!(
        "analysis: {:?}; bytes: {}; volumes: {}",
        started.elapsed(),
        analysis.file_size,
        analysis.volume_count
    );
    let started = std::time::Instant::now();
    fingerprint_archive_sha256(&analysis).unwrap();
    eprintln!("fingerprint: {:?}", started.elapsed());
}

#[test]
fn lz4_decode_budget_limits_ratio_and_absolute_size() {
    assert_eq!(lz4_decoded_byte_limit(1024), 10_240_000);
    assert_eq!(lz4_decoded_byte_limit(u64::MAX), MAX_LZ4_DECODED_BYTES);
}

#[test]
fn parses_seven_zip_entry_and_size_budget() {
    let output = ProcessOutput {
            exit_code: Some(0),
            success: true,
            stdout: "Path = archive.7z\nType = 7z\n----------\nPath = one.txt\nSize = 10\nPath = folder\nSize = 0\nPath = folder/two.bin\nSize = 25\n".into(),
            stderr: String::new(),
            stdout_truncated: false,
            stderr_truncated: false,
        };

    assert_eq!(
        parse_seven_zip_extraction_budget(&output).unwrap(),
        ArchiveExtractionBudget {
            entry_count: 3,
            total_bytes: 35,
        }
    );
}

#[test]
fn rejects_truncated_seven_zip_budget_output() {
    let output = ProcessOutput {
        exit_code: Some(0),
        success: true,
        stdout: "----------\nPath = partial".into(),
        stderr: String::new(),
        stdout_truncated: true,
        stderr_truncated: false,
    };

    assert!(parse_seven_zip_extraction_budget(&output).is_err());
}

#[test]
fn hashcat_plan_only_selects_available_devices() {
    let both = HashcatDeviceAvailability {
        gpu: true,
        cpu: true,
    };
    assert_eq!(
        hashcat_device_plan(RecoveryComputeMode::GpuPreferred, both),
        [HashcatComputeDevice::Gpu, HashcatComputeDevice::Cpu]
    );
    assert_eq!(
        hashcat_device_plan(RecoveryComputeMode::CpuOnly, both),
        [HashcatComputeDevice::Cpu]
    );

    let gpu_only = HashcatDeviceAvailability {
        gpu: true,
        cpu: false,
    };
    assert_eq!(
        hashcat_device_plan(RecoveryComputeMode::GpuPreferred, gpu_only),
        [HashcatComputeDevice::Gpu]
    );
    assert!(hashcat_device_plan(RecoveryComputeMode::CpuOnly, gpu_only).is_empty());

    let cpu_only = HashcatDeviceAvailability {
        gpu: false,
        cpu: true,
    };
    assert_eq!(
        hashcat_device_plan(RecoveryComputeMode::GpuPreferred, cpu_only),
        [HashcatComputeDevice::Cpu]
    );
    assert_eq!(
        hashcat_device_plan(RecoveryComputeMode::CpuOnly, cpu_only),
        [HashcatComputeDevice::Cpu]
    );

    let none = HashcatDeviceAvailability::default();
    assert!(hashcat_device_plan(RecoveryComputeMode::GpuPreferred, none).is_empty());
    assert!(hashcat_device_plan(RecoveryComputeMode::CpuOnly, none).is_empty());
}

#[test]
fn parses_hashcat_device_types_from_backend_info() {
    let output = r#"
Device ID #1
  Type...........: GPU
Device ID #2
  Type...........: CPU
"#;
    assert_eq!(parse_hashcat_device_types(output), (true, true));
    assert_eq!(
        parse_hashcat_device_types("Type...........: GPU"),
        (true, false)
    );
    assert_eq!(parse_hashcat_device_types("no devices"), (false, false));
}

#[test]
fn signature_detection_does_not_depend_on_extension() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("without-extension");
    fs::write(&path, [0u8, 1, 2, 0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]).unwrap();

    assert_eq!(
        detect_archive_format(&path).unwrap(),
        ArchiveFormat::SevenZip
    );
}

#[test]
fn analysis_pairs_disguised_seven_zip_tail_by_header_and_crc() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("F254.JPG");
    let second = dir.path().join("F254.PNG");
    let first_length = 128u64;
    let second_length = 24u64;
    let next_header = b"nexthead";
    let next_header_offset = first_length + second_length - 32 - next_header.len() as u64;

    let mut start_header = [0u8; 32];
    start_header[..SEVEN_ZIP_SIGNATURE.len()].copy_from_slice(SEVEN_ZIP_SIGNATURE);
    start_header[6..8].copy_from_slice(&[0, 4]);
    start_header[12..20].copy_from_slice(&next_header_offset.to_le_bytes());
    start_header[20..28].copy_from_slice(&(next_header.len() as u64).to_le_bytes());
    start_header[28..32].copy_from_slice(&test_crc32(next_header).to_le_bytes());
    let start_header_crc = test_crc32(&start_header[12..32]);
    start_header[8..12].copy_from_slice(&start_header_crc.to_le_bytes());

    let mut first_contents = vec![0x11; first_length as usize];
    first_contents[..start_header.len()].copy_from_slice(&start_header);
    fs::write(&first, first_contents).unwrap();
    let mut second_contents = vec![0x22; second_length as usize];
    let next_header_start = second_contents.len() - next_header.len();
    second_contents[next_header_start..].copy_from_slice(next_header);
    fs::write(&second, second_contents).unwrap();

    let analysis = analyze_archive(&first).unwrap();
    assert_eq!(analysis.file_size, first_length + second_length);
}

#[test]
fn analysis_prefers_numbered_split_sequence_over_duplicate_tail_content() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("archive.7z.001");
    let second = dir.path().join("archive.7z.002");
    let duplicate = dir.path().join("duplicate-tail.bin");
    write_two_part_seven_zip_fixture(&first, &second);
    fs::copy(&second, &duplicate).unwrap();

    let analysis = analyze_archive(&first).unwrap();

    assert_eq!(analysis.volume_count, 2);
    assert_eq!(analysis.volume_paths[0], first.canonicalize().unwrap());
    assert_eq!(analysis.volume_paths[1], second.canonicalize().unwrap());
}

#[test]
fn standard_numbered_split_does_not_need_materialization() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("archive.7z.001");
    let second = dir.path().join("archive.7z.002");
    write_two_part_seven_zip_fixture(&first, &second);
    let analysis = analyze_archive(&first).unwrap();
    let work_directory = dir.path().join("work");
    fs::create_dir_all(&work_directory).unwrap();

    let materialization = materialize_split_archive(
        &analysis,
        &work_directory,
        &CancellationToken::default(),
        &TaskDiskBudget::default(),
    )
    .unwrap();

    assert!(materialization.is_none());
    assert!(fs::read_dir(&work_directory).unwrap().next().is_none());
}

#[test]
fn repaired_split_copy_preserves_every_volume_and_source() {
    let dir = tempfile::tempdir().unwrap();
    let first = dir.path().join("disguised.jpg");
    let second = dir.path().join("disguised.png");
    write_two_part_seven_zip_fixture(&first, &second);
    let repaired = create_repaired_archive_copy(&first, &CancellationToken::default()).unwrap();
    assert!(repaired.is_dir());
    assert_eq!(
        fs::read(repaired.join("archive.7z.001")).unwrap(),
        fs::read(&first).unwrap()
    );
    assert_eq!(
        fs::read(repaired.join("archive.7z.002")).unwrap(),
        fs::read(&second).unwrap()
    );
    assert_eq!(
        analyze_archive(repaired.join("archive.7z.001"))
            .unwrap()
            .volume_count,
        2
    );
}

#[test]
fn split_materialization_copies_when_hard_links_are_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source.bin");
    let destination = dir.path().join("destination.bin");
    fs::write(&source, b"copy-fallback").unwrap();

    materialize_volume_with(
        &source,
        &destination,
        &CancellationToken::default(),
        |_, _| {
            Err(std::io::Error::new(
                std::io::ErrorKind::Unsupported,
                "hard links unavailable",
            ))
        },
    )
    .unwrap();

    assert_eq!(fs::read(&destination).unwrap(), b"copy-fallback");
}

#[test]
fn detects_and_materializes_lz4_wrapped_archive() {
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("inner.rar");
    let wrapped = dir.path().join("renamed.lz4");
    let work_directory = dir.path().join("work");
    let mut contents = RAR5_SIGNATURE.to_vec();
    contents.extend_from_slice(b"arc-recall-lz4-fixture");
    fs::write(&archive, &contents).unwrap();
    write_lz4_frame(&archive, &wrapped);
    fs::create_dir_all(&work_directory).unwrap();

    assert_eq!(
        detect_archive_format(&wrapped).unwrap(),
        ArchiveFormat::Rar5
    );
    let normalized = materialize_lz4_archive(
        &wrapped,
        ArchiveFormat::Rar5,
        &work_directory,
        &CancellationToken::default(),
        &TaskDiskBudget::default(),
    )
    .unwrap()
    .expect("LZ4 wrapper should be materialized");

    assert_eq!(
        normalized.extension().and_then(|value| value.to_str()),
        Some("rar")
    );
    assert_eq!(fs::read(normalized).unwrap(), contents);
}

#[test]
fn cancelled_lz4_materialization_removes_partial_output() {
    let dir = tempfile::tempdir().unwrap();
    let archive = dir.path().join("inner.rar");
    let wrapped = dir.path().join("wrapped.lz4");
    let work_directory = dir.path().join("work");
    fs::write(&archive, RAR5_SIGNATURE).unwrap();
    write_lz4_frame(&archive, &wrapped);
    fs::create_dir_all(&work_directory).unwrap();
    let cancellation = CancellationToken::default();
    cancellation.cancel();

    assert!(matches!(
        materialize_lz4_archive(
            &wrapped,
            ArchiveFormat::Rar5,
            &work_directory,
            &cancellation,
            &TaskDiskBudget::default(),
        ),
        Err(RecoveryError::Cancelled)
    ));
    assert!(!work_directory.join("lz4-decoded.partial").exists());
    assert!(!work_directory.join("lz4-decoded.rar").exists());
}

#[test]
fn content_fingerprint_is_stable_after_rename() {
    let directory = tempfile::tempdir().unwrap();
    let original = directory.path().join("original.bin");
    let renamed = directory.path().join("renamed.jpg");
    fs::write(&original, b"arc-recall fingerprint fixture").unwrap();

    let before = fingerprint_file_sha256(&original).unwrap();
    fs::rename(&original, &renamed).unwrap();
    let after = fingerprint_file_sha256(&renamed).unwrap();

    assert_eq!(before, after);
    assert_eq!(before.len(), 64);
}

#[test]
fn content_fingerprint_matches_standard_sha256() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("known.bin");
    fs::write(&path, b"abc").unwrap();

    assert_eq!(
        fingerprint_file_sha256(path).unwrap(),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
}

#[test]
fn full_fingerprint_changes_when_any_middle_byte_changes() {
    let directory = tempfile::tempdir().unwrap();
    let first = directory.path().join("first.bin");
    let second = directory.path().join("second.bin");
    let mut contents = vec![0u8; (2 * 1024 * 1024) as usize];
    fs::write(&first, &contents).unwrap();
    contents[1_234_567] = 1;
    fs::write(&second, &contents).unwrap();

    assert_ne!(
        fingerprint_file_sha256(&first).unwrap(),
        fingerprint_file_sha256(&second).unwrap()
    );
}

#[test]
fn successful_extraction_does_not_ignore_fingerprint_cancellation() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("archive.7z");
    fs::write(&archive, SEVEN_ZIP_SIGNATURE).unwrap();
    let analysis = analyze_archive(&archive).unwrap();
    let job = RecoveryJob {
        archive_path: archive,
        output_directory: directory.path().join("output"),
        dictionary_path: directory.path().join("unused"),
        dictionary_count: 0,
        known_password: Some("known".into()),
        work_directory: directory.path().join("work"),
    };
    let cancellation = CancellationToken::default();
    cancellation.cancel();

    for precomputed in [None, Some("precomputed")] {
        assert!(matches!(
            attach_recovered_archive(
                success_result(&job, Some("known".into()), "7-Zip", "extracted"),
                &analysis,
                precomputed,
                &cancellation,
            ),
            Err(RecoveryError::Cancelled),
        ));
    }
}

#[test]
fn missing_fingerprint_source_preserves_successful_extraction() {
    let directory = tempfile::tempdir().unwrap();
    let archive = directory.path().join("archive.7z");
    fs::write(&archive, SEVEN_ZIP_SIGNATURE).unwrap();
    let analysis = analyze_archive(&archive).unwrap();
    let job = RecoveryJob {
        archive_path: archive.clone(),
        output_directory: directory.path().join("output"),
        dictionary_path: directory.path().join("unused"),
        dictionary_count: 0,
        known_password: None,
        work_directory: directory.path().join("work"),
    };
    fs::remove_file(archive).unwrap();
    let result = attach_recovered_archive(
        success_result(&job, None, "7-Zip", "extracted"),
        &analysis,
        None,
        &CancellationToken::default(),
    )
    .unwrap();
    assert!(result.success);
    assert!(result.recovered_archive.is_none());
}

#[test]
fn nested_detection_is_content_driven_and_ignores_extensions() {
    let dir = tempfile::tempdir().unwrap();
    let mut carrier = vec![0u8; 256 * 1024];
    carrier[..4].copy_from_slice(b"\xff\xd8\xff\xe0");
    let signature_offset = 128 * 1024;
    carrier[signature_offset..signature_offset + SEVEN_ZIP_SIGNATURE.len()]
        .copy_from_slice(SEVEN_ZIP_SIGNATURE);

    let image_path = dir.path().join("carrier.unexpected-suffix");
    fs::write(&image_path, &carrier).unwrap();
    assert_eq!(
        detect_nested_archive_format(&image_path).unwrap(),
        ArchiveFormat::SevenZip
    );

    let mut arbitrary_prefix = vec![0u8; 64 * 1024];
    arbitrary_prefix[32 * 1024..32 * 1024 + SEVEN_ZIP_SIGNATURE.len()]
        .copy_from_slice(SEVEN_ZIP_SIGNATURE);
    let arbitrary_path = dir.path().join("asset.rpgmvp");
    fs::write(&arbitrary_path, arbitrary_prefix).unwrap();
    assert!(matches!(
        detect_nested_archive_format(&arbitrary_path),
        Err(RecoveryError::UnsupportedFormat)
    ));

    let mut pe = minimal_pe_fixture();
    pe[4 * 1024..4 * 1024 + ZIP_SIGNATURES[0].len()].copy_from_slice(ZIP_SIGNATURES[0]);
    let dll_path = dir.path().join("MonoPosixHelper.dll");
    fs::write(&dll_path, &pe).unwrap();
    assert!(matches!(
        detect_nested_archive_format(&dll_path),
        Err(RecoveryError::UnsupportedFormat)
    ));

    pe.extend_from_slice(SEVEN_ZIP_SIGNATURE);
    let sfx_path = dir.path().join("self-extracting.exe");
    fs::write(&sfx_path, pe).unwrap();
    assert_eq!(
        detect_nested_archive_format(&sfx_path).unwrap(),
        ArchiveFormat::SevenZip
    );

    for file_name in [
        "test.jpg",
        "test.png",
        "test.pdf",
        "test",
        "test.anything",
        "test.7z.jpg",
        "test.7z11",
        "test.7z.1",
    ] {
        let renamed_archive_path = dir.path().join(file_name);
        fs::write(&renamed_archive_path, SEVEN_ZIP_SIGNATURE).unwrap();
        assert_eq!(
            detect_nested_archive_format(&renamed_archive_path).unwrap(),
            ArchiveFormat::SevenZip,
            "failed to detect {file_name}"
        );
    }
}

#[test]
fn nested_output_transaction_publishes_only_after_commit() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("nested-output");
    let mut transaction = NestedOutputTransaction::new(destination.clone());
    fs::create_dir_all(transaction.staging_directory()).unwrap();
    fs::write(transaction.staging_directory().join("payload.txt"), b"ok").unwrap();

    assert!(!destination.exists());
    transaction.commit().unwrap();
    assert_eq!(
        fs::read_to_string(destination.join("payload.txt")).unwrap(),
        "ok"
    );
}

#[test]
fn nested_output_transaction_removes_uncommitted_staging() {
    let dir = tempfile::tempdir().unwrap();
    let destination = dir.path().join("nested-output");
    let staging = {
        let transaction = NestedOutputTransaction::new(destination.clone());
        let staging = transaction.staging_directory().to_path_buf();
        fs::create_dir_all(&staging).unwrap();
        fs::write(staging.join("partial.txt"), b"partial").unwrap();
        staging
    };

    assert!(!staging.exists());
    assert!(!destination.exists());
}

#[test]
fn user_facing_paths_hide_windows_verbatim_prefixes() {
    assert_eq!(
        path_for_display(Path::new(r"\\?\F:\Download\archive.7z")),
        r"F:\Download\archive.7z"
    );
    assert_eq!(
        path_for_display(Path::new(r"\\?\UNC\server\share\archive.7z")),
        r"\\server\share\archive.7z"
    );
    assert_eq!(
        path_for_display(Path::new(r"F:\Download\archive.7z")),
        r"F:\Download\archive.7z"
    );
}

#[test]
fn parses_all_supported_john_hash_families() {
    let output = concat!(
        "a.7z:$7z$0$19$0$abc:meta\n",
        "b.rar:$rar5$16$aaa$15$bbb\n",
        "c.rar:$RAR3$*0*abc:0::::\n",
        "d.zip:$pkzip2$1*2*3$/pkzip2$::::\n",
        "e.zip:$zip2$*0*3*abc$/zip2$:meta\n"
    );

    let records = parse_hash_records(output);

    assert_eq!(records.len(), 5);
    assert_eq!(records[0].hash, "$7z$0$19$0$abc");
    assert_eq!(records[0].john_line, "archive:$7z$0$19$0$abc:meta");
    assert_eq!(records[1].hash, "$rar5$16$aaa$15$bbb");
    assert_eq!(records[1].john_line, "archive:$rar5$16$aaa$15$bbb");
    assert_eq!(records[2].hash, "$RAR3$*0*abc");
    assert_eq!(records[2].john_line, "archive:$RAR3$*0*abc:0::::");
    assert_eq!(records[3].hash, "$pkzip2$1*2*3$/pkzip2$");
    assert_eq!(records[4].hash, "$zip2$*0*3*abc$/zip2$");
}

#[test]
fn normalizes_windows_drive_paths_out_of_john_labels() {
    let line = r"F:\data\sample.rar:$rar5$16$aaa$15$bbb$8$ccc";
    let records = parse_hash_records(line);
    assert_eq!(records.len(), 1);
    assert_eq!(records[0].hash, "$rar5$16$aaa$15$bbb$8$ccc");
    assert_eq!(records[0].john_line, "archive:$rar5$16$aaa$15$bbb$8$ccc");
    assert!(!records[0].john_line.contains(r"F:\"));
}

#[test]
fn fallback_modes_cover_7z_zip_rar3_and_rar5() {
    assert_eq!(fallback_hashcat_modes("$7z$abc"), [11600]);
    assert_eq!(fallback_hashcat_modes("$rar5$abc"), [13000]);
    assert_eq!(fallback_hashcat_modes("$RAR3$*0*abc"), [12500]);
    assert_eq!(fallback_hashcat_modes("$RAR3$*1*abc"), [23700, 23800]);
    assert_eq!(fallback_hashcat_modes("$zip2$abc"), [13600]);
    assert_eq!(
        fallback_hashcat_modes("$pkzip2$abc"),
        [17200, 17210, 17220, 17225, 17230, 17240, 17250]
    );
}

#[test]
fn seven_zip_converter_receives_exact_resolved_split_parts() {
    assert_eq!(
        seven_zip_converter_archive_args(&[
            PathBuf::from(r"\\?\E:\test\.temp\archive.7z.01"),
            PathBuf::from(r"\\?\E:\test\.temp\archive.7z.02"),
        ]),
        [
            OsString::from(r"E:\test\.temp\archive.7z.01"),
            OsString::from(r"E:\test\.temp\archive.7z.02"),
        ]
    );
}

#[test]
fn decodes_hashcat_and_john_hex_passwords() {
    assert_eq!(decode_password("$HEX[70c3a47373]"), Some("päss".to_owned()));
    assert_eq!(decode_password("$HEX$70c3a47373"), Some("päss".to_owned()));
}

#[test]
fn seven_zip_password_arg_embeds_secret_in_single_switch() {
    assert_eq!(
        seven_zip_password_arg("secret123"),
        OsString::from("-psecret123")
    );
    assert_eq!(seven_zip_password_arg(""), OsString::from("-p"));
    assert_eq!(
        seven_zip_password_arg("p@ss word!#%"),
        OsString::from("-pp@ss word!#%")
    );
}

#[test]
fn seven_zip_diagnostics_distinguish_wrong_password_from_broken_archive() {
    let wrong_password = ProcessOutput {
        exit_code: Some(2),
        success: false,
        stdout: String::new(),
        stderr: "Cannot open encrypted archive. Wrong password?".into(),
        stdout_truncated: false,
        stderr_truncated: false,
    };
    let broken_archive = ProcessOutput {
        exit_code: Some(2),
        success: false,
        stdout: String::new(),
        stderr: "Unexpected end of archive".into(),
        stdout_truncated: false,
        stderr_truncated: false,
    };

    assert!(is_password_rejection(&wrong_password));
    assert!(!is_password_rejection(&broken_archive));
}

#[test]
fn seven_zip_type_probe_rejects_pe_and_accepts_supported_archives() {
    let pe = ProcessOutput {
        exit_code: Some(0),
        success: true,
        stdout: "Path = helper.dll\nType = PE\nPhysical Size = 780288\n".into(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    };
    let archives = ProcessOutput {
        exit_code: Some(0),
        success: true,
        stdout: "Type = 7z\nType = zip\nType = Rar5\n".into(),
        stderr: String::new(),
        stdout_truncated: false,
        stderr_truncated: false,
    };

    assert_eq!(seven_zip_archive_types(&pe), ["PE"]);
    assert!(!archive_type_matches(ArchiveFormat::Zip, "PE"));
    assert!(archive_type_matches(ArchiveFormat::SevenZip, "7z"));
    assert!(archive_type_matches(ArchiveFormat::Zip, "zip"));
    assert!(archive_type_matches(ArchiveFormat::Rar5, "Rar5"));
    assert_eq!(seven_zip_archive_types(&archives), ["7z", "zip", "Rar5"]);
}

/// Real 7-Zip CLI checks. Skipped when no 7z.exe is available.
#[test]
fn seven_zip_verifies_and_extracts_encrypted_7z_and_zip() {
    let Some(seven_zip) = locate_seven_zip() else {
        eprintln!("skip: 7z.exe not found");
        return;
    };

    let dir = tempfile::tempdir().unwrap();
    let payload = dir.path().join("payload.txt");
    fs::write(&payload, b"arc-recall-payload").unwrap();
    let password = "s3cret-pass!";
    let tools = RecoveryToolPaths {
        seven_zip: seven_zip.clone(),
        hashcat: PathBuf::from("hashcat-not-required"),
        john_tools_directory: PathBuf::from("john-not-required"),
        perl: PathBuf::from("perl-not-required"),
    };
    let cancellation = CancellationToken::default();

    for (name, format_flag) in [("enc.7z", "-t7z"), ("enc.zip", "-tzip")] {
        let archive = dir.path().join(name);
        create_encrypted_archive(&seven_zip, format_flag, password, &archive, &payload);

        assert!(
            verify_password(&archive, password, &tools, &cancellation).unwrap(),
            "{name}: correct password should verify"
        );
        assert!(
            !verify_password(&archive, "wrong-password", &tools, &cancellation).unwrap(),
            "{name}: wrong password must fail"
        );

        let output_directory = dir.path().join(format!("{name}-out"));
        let job = RecoveryJob {
            archive_path: archive.clone(),
            output_directory: output_directory.clone(),
            dictionary_path: dir.path().join("empty.dict"),
            dictionary_count: 0,
            known_password: Some(password.into()),
            work_directory: dir.path().join(format!("{name}-work")),
        };
        fs::create_dir_all(&job.work_directory).unwrap();

        let result = recover_and_extract_lazy(
            &job,
            &tools,
            &cancellation,
            || panic!("known-password recovery must not prepare the dictionary"),
            |_| {},
        )
        .expect("recover");
        assert!(result.success, "{name}: {}", result.message);
        assert_eq!(result.password.as_deref(), Some(password));
        assert_eq!(
            fs::read_to_string(output_directory.join("payload.txt")).unwrap(),
            "arc-recall-payload"
        );
    }
}

#[test]
fn recovery_decodes_lz4_before_known_password_extraction() {
    let Some(seven_zip) = locate_seven_zip() else {
        eprintln!("skip: 7z.exe not found");
        return;
    };

    let dir = tempfile::tempdir().unwrap();
    let payload = dir.path().join("payload.txt");
    let archive = dir.path().join("encrypted.7z");
    let wrapped = dir.path().join("encrypted.7z.lz4");
    let output_directory = dir.path().join("out");
    let work_directory = dir.path().join("work");
    let password = "lz4-known-password";
    fs::write(&payload, b"lz4-recovery-ok").unwrap();
    create_encrypted_archive(&seven_zip, "-t7z", password, &archive, &payload);
    write_lz4_frame(&archive, &wrapped);

    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: PathBuf::from("hashcat-not-required"),
        john_tools_directory: PathBuf::from("john-not-required"),
        perl: PathBuf::from("perl-not-required"),
    };
    let job = RecoveryJob {
        archive_path: wrapped,
        output_directory: output_directory.clone(),
        dictionary_path: dir.path().join("unused.dict"),
        dictionary_count: 0,
        known_password: Some(password.into()),
        work_directory,
    };
    let mut updates = Vec::new();
    let result = recover_and_extract_lazy(
        &job,
        &tools,
        &CancellationToken::default(),
        || panic!("known-password recovery must not prepare the dictionary"),
        |update| updates.push(update),
    )
    .expect("recover LZ4-wrapped archive");

    assert!(result.success, "{}", result.message);
    assert_eq!(
        fs::read_to_string(output_directory.join("payload.txt")).unwrap(),
        "lz4-recovery-ok"
    );
    assert!(updates.iter().any(|update| {
        update.phase == RecoveryPhase::Preparing && update.engine.as_deref() == Some("LZ4")
    }));
}

#[test]
fn seven_zip_extracts_unencrypted_archive_without_password() {
    let Some(seven_zip) = locate_seven_zip() else {
        eprintln!("skip: 7z.exe not found");
        return;
    };

    let dir = tempfile::tempdir().unwrap();
    let payload = dir.path().join("plain.txt");
    fs::write(&payload, b"no-password").unwrap();
    let archive = dir.path().join("plain.7z");
    run_seven_zip(
        &seven_zip,
        &[
            "a",
            "-t7z",
            "-y",
            archive.to_str().unwrap(),
            payload.to_str().unwrap(),
        ],
    );

    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: PathBuf::from("hashcat-not-required"),
        john_tools_directory: PathBuf::from("john-not-required"),
        perl: PathBuf::from("perl-not-required"),
    };
    let cancellation = CancellationToken::default();
    let output_directory = dir.path().join("plain-out");
    let job = RecoveryJob {
        archive_path: archive,
        output_directory: output_directory.clone(),
        dictionary_path: dir.path().join("empty.dict"),
        dictionary_count: 0,
        known_password: None,
        work_directory: dir.path().join("plain-work"),
    };
    fs::create_dir_all(&job.work_directory).unwrap();

    let result = recover_and_extract_lazy(
        &job,
        &tools,
        &cancellation,
        || panic!("unencrypted recovery must not prepare the dictionary"),
        |_| {},
    )
    .expect("recover");
    assert!(result.success, "{}", result.message);
    assert!(result.password.is_none());
    assert_eq!(
        fs::read_to_string(output_directory.join("plain.txt")).unwrap(),
        "no-password"
    );
}

#[test]
fn seven_zip_recovers_disguised_two_part_archive_from_task_workspace() {
    let Some(seven_zip) = locate_seven_zip() else {
        eprintln!("skip: 7z.exe not found");
        return;
    };

    let dir = tempfile::tempdir().unwrap();
    let payload = dir.path().join("split-payload.txt");
    fs::write(&payload, b"disguised-split-ok").unwrap();
    let password = "split-pass-42";
    let original = dir.path().join("original.7z");
    create_encrypted_archive(&seven_zip, "-t7z", password, &original, &payload);
    let archive_bytes = fs::read(&original).unwrap();
    let split_at = (archive_bytes.len() / 2).max(SEVEN_ZIP_START_HEADER_SIZE_FOR_TEST);
    assert!(split_at < archive_bytes.len());
    let first = dir.path().join("F254.JPG");
    let second = dir.path().join("F254.PNG");
    fs::write(&first, &archive_bytes[..split_at]).unwrap();
    fs::write(&second, &archive_bytes[split_at..]).unwrap();
    fs::remove_file(original).unwrap();

    let output_directory = dir.path().join("split-out");
    let job = RecoveryJob {
        archive_path: first,
        output_directory: output_directory.clone(),
        dictionary_path: dir.path().join("unused.dict"),
        dictionary_count: 0,
        known_password: Some(password.into()),
        work_directory: dir.path().join("split-work"),
    };
    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: dir.path().join("missing-hashcat"),
        john_tools_directory: dir.path().join("missing-john"),
        perl: dir.path().join("missing-perl"),
    };

    let result = recover_and_extract_lazy(
        &job,
        &tools,
        &CancellationToken::default(),
        || panic!("known password must avoid dictionary preparation"),
        |_| {},
    )
    .expect("recover disguised split archive");

    assert!(result.success, "{}", result.message);
    assert_eq!(
        fs::read_to_string(output_directory.join("split-payload.txt")).unwrap(),
        "disguised-split-ok"
    );
    assert_eq!(
        result
            .recovered_archive
            .as_ref()
            .map(|archive| archive.volume_count),
        Some(2)
    );
    assert!(!fs::read_dir(dir.path()).unwrap().any(|entry| {
        entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".arcrecall-volumes-")
    }));
}

#[test]
fn split_extraction_budget_counts_every_volume() {
    let Some(seven_zip) = locate_seven_zip() else {
        eprintln!("skip: 7z.exe not found");
        return;
    };
    let directory = tempfile::tempdir().unwrap();
    let payload = directory.path().join("payload.bin");
    let payload_bytes = vec![0u8; 2 * 1024 * 1024];
    fs::write(&payload, &payload_bytes).unwrap();
    let archive_base = directory.path().join("small-volumes.7z");
    run_seven_zip(
        &seven_zip,
        &[
            "a",
            "-t7z",
            "-y",
            "-v128b",
            archive_base.to_str().unwrap(),
            payload.to_str().unwrap(),
        ],
    );
    let first_volume = directory.path().join("small-volumes.7z.001");
    let analysis = analyze_archive(&first_volume).unwrap();
    assert!(analysis.volume_count > 1);
    assert!((payload_bytes.len() as u64) > fs::metadata(&first_volume).unwrap().len() * 10_000);
    assert!((payload_bytes.len() as u64) <= analysis.file_size * 10_000);

    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: directory.path().join("unused-hashcat"),
        john_tools_directory: directory.path().join("unused-john"),
        perl: directory.path().join("unused-perl"),
    };
    let job = RecoveryJob {
        archive_path: first_volume,
        output_directory: directory.path().join("output"),
        dictionary_path: directory.path().join("unused-dictionary"),
        dictionary_count: 0,
        known_password: None,
        work_directory: directory.path().join("work"),
    };
    let result = recover_and_extract_lazy(
        &job,
        &tools,
        &CancellationToken::default(),
        || panic!("plain split archive must not need a dictionary"),
        |_| {},
    )
    .unwrap();
    assert!(result.success);
    assert_eq!(
        fs::read(job.output_directory.join("payload.bin")).unwrap(),
        payload_bytes
    );
}

#[test]
fn seven_zip_container_validation_rejects_pe_with_zip_bytes() {
    let Some(seven_zip) = locate_seven_zip() else {
        eprintln!("skip: 7z.exe not found");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let dll_path = dir.path().join("MonoPosixHelper.dll");
    let mut pe = minimal_pe_fixture();
    pe[4 * 1024..4 * 1024 + ZIP_SIGNATURES[0].len()].copy_from_slice(ZIP_SIGNATURES[0]);
    fs::write(&dll_path, pe).unwrap();
    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: PathBuf::from("hashcat-not-required"),
        john_tools_directory: PathBuf::from("john-not-required"),
        perl: PathBuf::from("perl-not-required"),
    };

    assert!(matches!(
        validate_archive_container(
            &dll_path,
            ArchiveFormat::Zip,
            &tools,
            &CancellationToken::default(),
        ),
        Err(RecoveryError::InvalidArchive(message)) if message.contains("PE")
    ));
}

#[test]
fn recursive_cancellation_preserves_published_outputs_and_history_records() {
    let Some(seven_zip) = locate_seven_zip() else {
        eprintln!("skip: 7z.exe not found");
        return;
    };
    let directory = tempfile::tempdir().unwrap();
    let inputs = directory.path().join("inputs");
    fs::create_dir(&inputs).unwrap();
    let password = "partial-results-fixture";
    for index in 0..3 {
        let payload = directory.path().join(format!("payload-{index}.txt"));
        fs::write(&payload, format!("payload {index}")).unwrap();
        create_encrypted_archive(
            &seven_zip,
            "-t7z",
            password,
            &inputs.join(format!("inner-{index}.7z")),
            &payload,
        );
    }
    let archive = directory.path().join("outer.7z");
    create_encrypted_archive(&seven_zip, "-t7z", password, &archive, &inputs);
    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: directory.path().join("missing-hashcat"),
        john_tools_directory: directory.path().join("missing-john"),
        perl: directory.path().join("missing-perl"),
    };
    // Exercise cancellation during the initial scan, a child scan, and the next
    // child verification. Every published archive must survive each boundary.
    for boundary in ["root-scan", "child-scan", "child-verification"] {
        let job = RecoveryJob {
            archive_path: archive.clone(),
            output_directory: directory.path().join(boundary),
            dictionary_path: directory.path().join("unused.dict"),
            dictionary_count: 0,
            known_password: Some(password.into()),
            work_directory: directory.path().join(format!("work-{boundary}")),
        };
        let cancellation = CancellationToken::default();
        let result = recover_and_extract_recursive_lazy(
            &job,
            &tools,
            &cancellation,
            RecursiveRecoveryOptions::default(),
            None,
            || panic!("known password must avoid dictionary preparation"),
            |update| {
                let cancel = match boundary {
                    "root-scan" => update.root_extraction_completed == Some(true),
                    "child-scan" => {
                        update.extracted_nested_archive_count == Some(2)
                            && update.phase == RecoveryPhase::Recursive
                    }
                    _ => {
                        update.extracted_nested_archive_count == Some(2)
                            && update.phase == RecoveryPhase::Verifying
                    }
                };
                if cancel {
                    cancellation.cancel();
                }
            },
        )
        .unwrap();
        assert!(result.root.success, "root output was already published");
        assert!(result.root.cancelled, "{boundary}");
        let completed_children = if boundary == "root-scan" { 0 } else { 2 };
        assert_eq!(result.extracted_nested_archives, completed_children);
        assert_eq!(
            result.completed_archive_paths.len(),
            completed_children as usize + 1
        );
        assert_eq!(
            result.recovered_archives.len(),
            completed_children as usize + 1
        );
        assert!(
            result
                .recovered_archives
                .iter()
                .all(|record| record.password.as_deref() == Some(password))
        );
        assert_eq!(result.scan_interrupted, boundary != "child-verification");
        if completed_children > 0 {
            assert_eq!(result.pending_archive_paths.len(), 1);
            for path in &result.completed_archive_paths[1..] {
                let output = path.with_extension("");
                assert!(output.is_dir(), "published output {}", output.display());
                assert_eq!(fs::read_dir(output).unwrap().count(), 1);
            }
        }
        assert!(
            fs::read_dir(job.output_directory.join("inputs"))
                .unwrap()
                .all(|entry| !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".partial"))
        );
    }
}

#[test]
fn recursive_cumulative_budget_preserves_completed_archives_and_stops_siblings() {
    let Some(seven_zip) = locate_seven_zip() else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let inputs = dir.path().join("inputs");
    fs::create_dir(&inputs).unwrap();
    let payload = dir.path().join("payload.txt");
    fs::write(&payload, [b'x'; 1024]).unwrap();
    for index in 0..3 {
        create_plain_archive(
            &seven_zip,
            &inputs.join(format!("inner-{index}.7z")),
            &payload,
        );
    }
    let root_bytes: u64 = fs::read_dir(&inputs)
        .unwrap()
        .map(|entry| entry.unwrap().metadata().unwrap().len())
        .sum();
    let archive = dir.path().join("outer.7z");
    create_plain_archive(&seven_zip, &archive, &inputs);
    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: dir.path().join("missing"),
        john_tools_directory: dir.path().join("missing"),
        perl: dir.path().join("missing"),
    };
    for (name, bytes, entries) in [("bytes", root_bytes + 1024, 1000), ("entries", u64::MAX, 5)] {
        let job = RecoveryJob {
            archive_path: archive.clone(),
            output_directory: dir.path().join(name),
            dictionary_path: dir.path().join("unused"),
            dictionary_count: 0,
            known_password: None,
            work_directory: dir.path().join(format!("work-{name}")),
        };
        let result = recover_and_extract_recursive_lazy(
            &job,
            &tools,
            &CancellationToken::default(),
            RecursiveRecoveryOptions {
                max_total_bytes: bytes,
                max_total_entries: entries,
                ..RecursiveRecoveryOptions::default()
            },
            None,
            || panic!("plain archive"),
            |_| {},
        )
        .unwrap();
        assert!(result.root.success);
        assert!(
            result.budget_limit_reached,
            "{name}: {}",
            result.root.message
        );
        assert_eq!(result.extracted_nested_archives, 1, "{name}");
        assert_eq!(result.pending_archive_paths.len(), 2);
        assert_eq!(result.recovered_archives.len(), 2);
        assert!(job.output_directory.join("inputs").is_dir());
        assert!(
            !fs::read_dir(job.output_directory.join("inputs"))
                .unwrap()
                .any(|entry| entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .contains(".partial"))
        );
    }
}

#[test]
fn recursively_extracts_misleading_suffix_archive_with_inherited_password() {
    let Some(seven_zip) = locate_seven_zip() else {
        eprintln!("skip: 7z.exe not found");
        return;
    };

    let dir = tempfile::tempdir().unwrap();
    let payload = dir.path().join("nested-payload.txt");
    fs::write(&payload, b"recursive-password-ok").unwrap();
    let password = "shared-nested-pass";
    let inner_archive = dir.path().join("inner.7z11");
    create_encrypted_archive(&seven_zip, "-t7z", password, &inner_archive, &payload);
    let outer_archive = dir.path().join("outer.7z");
    create_encrypted_archive(&seven_zip, "-t7z", password, &outer_archive, &inner_archive);
    let output_directory = dir.path().join("recursive-out");
    let job = RecoveryJob {
        archive_path: outer_archive,
        output_directory: output_directory.clone(),
        dictionary_path: dir.path().join("unused.dict"),
        dictionary_count: 0,
        known_password: Some(password.into()),
        work_directory: dir.path().join("recursive-work"),
    };
    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: dir.path().join("missing-hashcat"),
        john_tools_directory: dir.path().join("missing-john"),
        perl: dir.path().join("missing-perl"),
    };

    let mut updates = Vec::new();
    let result = recover_and_extract_recursive_lazy(
        &job,
        &tools,
        &CancellationToken::default(),
        RecursiveRecoveryOptions::default(),
        None,
        || panic!("inherited password must avoid dictionary preparation"),
        |update| updates.push(update),
    )
    .expect("recursive recovery");

    assert!(result.root.success, "{}", result.root.message);
    assert_eq!(result.discovered_nested_archives, 1);
    assert_eq!(result.extracted_nested_archives, 1);
    assert_eq!(result.skipped_nested_archives, 0);
    assert!(result.scanned_files > 0);
    assert!(updates.iter().any(|update| {
        update.phase == RecoveryPhase::Recursive
            && update.scanned_file_count.is_some_and(|count| count > 0)
    }));
    assert_eq!(
        fs::read_to_string(output_directory.join("inner").join("nested-payload.txt")).unwrap(),
        "recursive-password-ok"
    );
}

#[test]
fn recursive_scan_file_limit_preserves_output_and_can_resume_with_a_higher_limit() {
    let Some(seven_zip) = locate_seven_zip() else {
        eprintln!("skip: 7z.exe not found");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let content = dir.path().join("content");
    fs::create_dir(&content).unwrap();
    let payload = dir.path().join("payload.txt");
    fs::write(&payload, b"nested-content").unwrap();
    create_encrypted_archive(
        &seven_zip,
        "-t7z",
        "shared-test-password",
        &content.join("nested.jpg"),
        &payload,
    );
    for index in 0..10 {
        fs::write(content.join(format!("{index}.txt")), b"ordinary-file").unwrap();
    }
    let archive = dir.path().join("outer.7z");
    create_encrypted_archive(
        &seven_zip,
        "-t7z",
        "shared-test-password",
        &archive,
        &content,
    );
    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: dir.path().join("unused-hashcat"),
        john_tools_directory: dir.path().join("unused-john"),
        perl: dir.path().join("unused-perl"),
    };
    for limit in [10, 11, 0] {
        let job = RecoveryJob {
            archive_path: archive.clone(),
            output_directory: dir.path().join(format!("out-{limit}")),
            work_directory: dir.path().join(format!("work-{limit}")),
            dictionary_path: dir.path().join("unused.dict"),
            dictionary_count: 0,
            known_password: Some("shared-test-password".into()),
        };
        let mut updates = Vec::new();
        let result = recover_and_extract_recursive_lazy(
            &job,
            &tools,
            &CancellationToken::default(),
            RecursiveRecoveryOptions {
                max_files_per_directory: limit,
                ..RecursiveRecoveryOptions::default()
            },
            None,
            || panic!("known passwords must avoid dictionary loading"),
            |update| updates.push(update),
        )
        .unwrap();
        assert!(result.root.success);
        let output = job.output_directory.join("content");
        for index in 0..10 {
            assert_eq!(
                fs::read(output.join(format!("{index}.txt"))).unwrap(),
                b"ordinary-file"
            );
        }
        assert!(output.join("nested.jpg").is_file());
        if limit == 10 {
            assert_eq!(result.extracted_nested_archives, 0);
            assert_eq!(result.scanned_files, 0);
            assert!(!output.join("nested").exists());
            assert!(result.root.message.contains("按文件数上限跳过 1 个目录"));
            assert!(
                updates
                    .iter()
                    .any(|update| update.message.contains("直属文件超过 10 个"))
            );
        } else {
            assert_eq!(result.extracted_nested_archives, 1);
            assert_eq!(
                fs::read(output.join("nested/payload.txt")).unwrap(),
                b"nested-content"
            );
        }
    }
}

#[test]
fn real_seven_zip_recovers_a_large_pe_overlay_recursively() {
    let Some(seven_zip) = locate_seven_zip() else {
        eprintln!("skip: 7z.exe not found");
        return;
    };
    let directory = tempfile::tempdir().unwrap();
    let payload = directory.path().join("payload.txt");
    fs::write(&payload, b"large-sfx-payload").unwrap();
    let inner = directory.path().join("inner.7z");
    let password = "synthetic-sfx-password";
    create_encrypted_archive(&seven_zip, "-t7z", password, &inner, &payload);
    let mut bytes = minimal_pe_fixture();
    let raw_size = 5 * 1024 * 1024u32;
    let section_table = 0x80 + 24 + 0xf0;
    bytes[section_table + 16..section_table + 20].copy_from_slice(&raw_size.to_le_bytes());
    bytes.resize(0x400 + raw_size as usize, 0);
    bytes.extend_from_slice(&fs::read(inner).unwrap());
    let sfx = directory.path().join("large-sfx.exe");
    fs::write(&sfx, bytes).unwrap();
    let outer = directory.path().join("outer.7z");
    create_encrypted_archive(&seven_zip, "-t7z", password, &outer, &sfx);
    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: directory.path().join("unused-hashcat"),
        john_tools_directory: directory.path().join("unused-john"),
        perl: directory.path().join("unused-perl"),
    };
    for (name, archive, nested) in [("direct", sfx, 0), ("recursive", outer, 1)] {
        let job = RecoveryJob {
            archive_path: archive,
            output_directory: directory.path().join(name),
            dictionary_path: directory.path().join("unused.dict"),
            dictionary_count: 0,
            known_password: Some(password.into()),
            work_directory: directory.path().join(format!("{name}-work")),
        };
        let result = recover_and_extract_recursive_lazy(
            &job,
            &tools,
            &CancellationToken::default(),
            RecursiveRecoveryOptions::default(),
            None,
            || panic!("known password must avoid dictionary preparation"),
            |_| {},
        )
        .unwrap();
        assert!(result.root.success, "{}", result.root.message);
        assert_eq!(result.extracted_nested_archives, nested);
        let output = if nested == 0 {
            job.output_directory
        } else {
            job.output_directory.join("large-sfx")
        };
        assert_eq!(
            fs::read(output.join("payload.txt")).unwrap(),
            b"large-sfx-payload"
        );
    }
}

#[test]
fn recursively_uses_dictionary_once_for_different_nested_password() {
    let Some(seven_zip) = locate_seven_zip() else {
        eprintln!("skip: 7z.exe not found");
        return;
    };

    let dir = tempfile::tempdir().unwrap();
    let payload = dir.path().join("different-password.txt");
    fs::write(&payload, b"nested-dictionary-ok").unwrap();
    let nested_password = "nested-only-pass";
    let inner_archive = dir.path().join("dictionary-inner.7z");
    create_encrypted_archive(
        &seven_zip,
        "-t7z",
        nested_password,
        &inner_archive,
        &payload,
    );
    let outer_archive = dir.path().join("plain-outer.7z");
    create_plain_archive(&seven_zip, &outer_archive, &inner_archive);
    let dictionary_path = dir.path().join("nested.dict");
    fs::write(
        &dictionary_path,
        format!("wrong-one\n{nested_password}\nwrong-two\n"),
    )
    .unwrap();
    let output_directory = dir.path().join("dictionary-recursive-out");
    let job = RecoveryJob {
        archive_path: outer_archive,
        output_directory: output_directory.clone(),
        dictionary_path: dictionary_path.clone(),
        dictionary_count: 3,
        known_password: None,
        work_directory: dir.path().join("dictionary-recursive-work"),
    };
    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: dir.path().join("missing-hashcat"),
        john_tools_directory: dir.path().join("missing-john"),
        perl: dir.path().join("missing-perl"),
    };
    let preparation_count = std::cell::Cell::new(0);

    let result = recover_and_extract_recursive_lazy(
        &job,
        &tools,
        &CancellationToken::default(),
        RecursiveRecoveryOptions::default(),
        None,
        || {
            preparation_count.set(preparation_count.get() + 1);
            Ok(RecoveryDictionary {
                path: dictionary_path,
                candidate_count: 3,
            })
        },
        |_| {},
    )
    .expect("recursive dictionary recovery");

    assert!(result.root.success, "{}", result.root.message);
    assert_eq!(preparation_count.get(), 1);
    assert_eq!(result.extracted_nested_archives, 1);
    assert!(
        result
            .recovered_passwords
            .iter()
            .any(|password| password == nested_password)
    );
    assert_eq!(
        fs::read_to_string(
            output_directory
                .join("dictionary-inner")
                .join("different-password.txt")
        )
        .unwrap(),
        "nested-dictionary-ok"
    );
}

#[test]
fn recursively_uses_dictionary_after_inherited_password_fails_for_split_archive() {
    let Some(seven_zip) = locate_seven_zip() else {
        eprintln!("skip: 7z.exe not found");
        return;
    };

    let dir = tempfile::tempdir().unwrap();
    let payload = dir.path().join("split-nested-payload.bin");
    let payload_bytes: Vec<u8> = (0..4096).map(|index| (index % 251) as u8).collect();
    fs::write(&payload, &payload_bytes).unwrap();
    let outer_password = "outer-split-pass";
    let inner_password = "inner-split-pass";
    let split_base = dir.path().join("nested-secret.7z");
    let split_password_arg = format!("-p{inner_password}");
    run_seven_zip(
        &seven_zip,
        &[
            "a",
            "-t7z",
            "-y",
            &split_password_arg,
            "-mhe=on",
            "-mx=0",
            "-v2048b",
            split_base.to_str().unwrap(),
            payload.to_str().unwrap(),
        ],
    );
    let mut split_parts: Vec<PathBuf> = fs::read_dir(dir.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.starts_with("nested-secret.7z."))
        })
        .collect();
    split_parts.sort();
    assert_eq!(split_parts.len(), 3, "fixture must have exactly 3 volumes");
    let anonymous_names = ["cover.jpg", "middle.bin", "trailer.dat"];
    for (part, anonymous_name) in split_parts.iter_mut().zip(anonymous_names) {
        let anonymous_path = dir.path().join(anonymous_name);
        fs::rename(&*part, &anonymous_path).unwrap();
        *part = anonymous_path;
    }

    let outer_archive = dir.path().join("outer-with-split.7z");
    let outer_password_arg = format!("-p{outer_password}");
    let mut outer_args = vec![
        "a".to_owned(),
        "-t7z".to_owned(),
        "-y".to_owned(),
        outer_password_arg,
        "-mhe=on".to_owned(),
        outer_archive.display().to_string(),
    ];
    outer_args.extend(split_parts.iter().map(|part| part.display().to_string()));
    let outer_arg_refs: Vec<&str> = outer_args.iter().map(String::as_str).collect();
    run_seven_zip(&seven_zip, &outer_arg_refs);
    for part in &split_parts {
        fs::remove_file(part).unwrap();
    }

    let dictionary_path = dir.path().join("nested-split.dict");
    fs::write(&dictionary_path, format!("{inner_password}\n")).unwrap();
    let output_directory = dir.path().join("nested-split-out");
    let job = RecoveryJob {
        archive_path: outer_archive,
        output_directory,
        dictionary_path: dictionary_path.clone(),
        dictionary_count: 1,
        known_password: Some(outer_password.into()),
        work_directory: dir.path().join("nested-split-work"),
    };
    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: dir.path().join("missing-hashcat"),
        john_tools_directory: dir.path().join("missing-john"),
        perl: dir.path().join("missing-perl"),
    };
    let preparation_count = std::cell::Cell::new(0);

    let result = recover_and_extract_recursive_lazy(
        &job,
        &tools,
        &CancellationToken::default(),
        RecursiveRecoveryOptions::default(),
        None,
        || {
            preparation_count.set(preparation_count.get() + 1);
            Ok(RecoveryDictionary {
                path: dictionary_path,
                candidate_count: 1,
            })
        },
        |_| {},
    )
    .expect("recursive split recovery");

    assert!(result.root.success, "{}", result.root.message);
    assert_eq!(preparation_count.get(), 1);
    assert_eq!(result.discovered_nested_archives, 1);
    assert_eq!(result.extracted_nested_archives, 1);
    assert_eq!(result.skipped_nested_archives, 0);
}

#[test]
fn recursive_extraction_enforces_depth_limit() {
    let Some(seven_zip) = locate_seven_zip() else {
        eprintln!("skip: 7z.exe not found");
        return;
    };

    let dir = tempfile::tempdir().unwrap();
    let payload = dir.path().join("depth-payload.txt");
    fs::write(&payload, b"depth-limit").unwrap();
    let level_two = dir.path().join("level-two.7z");
    create_plain_archive(&seven_zip, &level_two, &payload);
    let level_one = dir.path().join("level-one.7z");
    create_plain_archive(&seven_zip, &level_one, &level_two);
    let outer_archive = dir.path().join("depth-outer.7z");
    create_plain_archive(&seven_zip, &outer_archive, &level_one);
    let output_directory = dir.path().join("depth-out");
    let job = RecoveryJob {
        archive_path: outer_archive,
        output_directory: output_directory.clone(),
        dictionary_path: dir.path().join("unused.dict"),
        dictionary_count: 0,
        known_password: None,
        work_directory: dir.path().join("depth-work"),
    };
    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: dir.path().join("missing-hashcat"),
        john_tools_directory: dir.path().join("missing-john"),
        perl: dir.path().join("missing-perl"),
    };

    let result = recover_and_extract_recursive_lazy(
        &job,
        &tools,
        &CancellationToken::default(),
        RecursiveRecoveryOptions {
            enabled: true,
            max_depth: 1,
            max_nested_archives: 100,
            compute_mode: RecoveryComputeMode::GpuPreferred,
            ..RecursiveRecoveryOptions::default()
        },
        None,
        || panic!("plain archives must avoid dictionary preparation"),
        |_| {},
    )
    .expect("depth-limited recursive recovery");

    assert!(result.root.success, "{}", result.root.message);
    assert_eq!(result.discovered_nested_archives, 2);
    assert_eq!(result.extracted_nested_archives, 1);
    assert_eq!(result.skipped_nested_archives, 1);
    assert!(result.depth_limit_reached);
    assert!(
        output_directory
            .join("level-one")
            .join("level-two.7z")
            .is_file()
    );
    assert!(
        !output_directory
            .join("level-one")
            .join("level-two")
            .exists()
    );
}

#[test]
fn recursive_extraction_ignores_preexisting_output_archives() {
    let Some(seven_zip) = locate_seven_zip() else {
        eprintln!("skip: 7z.exe not found");
        return;
    };

    let dir = tempfile::tempdir().unwrap();
    let old_payload = dir.path().join("old-payload.txt");
    fs::write(&old_payload, b"must-not-be-recursed").unwrap();
    let old_archive = dir.path().join("old.7z");
    create_plain_archive(&seven_zip, &old_archive, &old_payload);
    let root_payload = dir.path().join("root-payload.txt");
    fs::write(&root_payload, b"root-only").unwrap();
    let outer_archive = dir.path().join("snapshot-outer.7z");
    create_plain_archive(&seven_zip, &outer_archive, &root_payload);
    let output_directory = dir.path().join("existing-output");
    fs::create_dir_all(&output_directory).unwrap();
    fs::copy(&old_archive, output_directory.join("old.7z")).unwrap();
    let job = RecoveryJob {
        archive_path: outer_archive,
        output_directory: output_directory.clone(),
        dictionary_path: dir.path().join("unused.dict"),
        dictionary_count: 0,
        known_password: None,
        work_directory: dir.path().join("snapshot-work"),
    };
    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: dir.path().join("missing-hashcat"),
        john_tools_directory: dir.path().join("missing-john"),
        perl: dir.path().join("missing-perl"),
    };

    let result = recover_and_extract_recursive_lazy(
        &job,
        &tools,
        &CancellationToken::default(),
        RecursiveRecoveryOptions::default(),
        None,
        || panic!("plain archive must avoid dictionary preparation"),
        |_| {},
    )
    .expect("snapshot-aware recursive recovery");

    assert!(result.root.success, "{}", result.root.message);
    assert_eq!(result.discovered_nested_archives, 0);
    assert!(!output_directory.join("old").exists());
    assert_eq!(
        fs::read_to_string(output_directory.join("root-payload.txt")).unwrap(),
        "root-only"
    );
}

#[test]
fn dictionary_recovery_falls_back_to_seven_zip_when_external_tools_are_missing() {
    let Some(seven_zip) = locate_seven_zip() else {
        eprintln!("skip: 7z.exe not found");
        return;
    };

    let dir = tempfile::tempdir().unwrap();
    let payload = dir.path().join("fallback.txt");
    fs::write(&payload, b"internal-fallback-ok").unwrap();
    let password = "fallback-pass-42";
    let archive = dir.path().join("fallback.7z");
    create_encrypted_archive(&seven_zip, "-t7z", password, &archive, &payload);
    let dictionary_path = dir.path().join("fallback.dict");
    let mut candidates = vec!["wrong-one".to_owned(), "wrong-two".to_owned()];
    if cfg!(windows) {
        candidates.push("x".repeat(40_000));
        // Shorter input can still exceed the limit after Windows quotes argv.
        candidates.push("\"".repeat(20_000));
    }
    candidates.push(password.to_owned());
    fs::write(&dictionary_path, candidates.join("\n")).unwrap();

    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: dir.path().join("missing-hashcat"),
        john_tools_directory: dir.path().join("missing-john"),
        perl: dir.path().join("missing-perl"),
    };
    let output_directory = dir.path().join("fallback-out");
    let job = RecoveryJob {
        archive_path: archive,
        output_directory: output_directory.clone(),
        dictionary_path,
        dictionary_count: candidates.len() as u64,
        known_password: None,
        work_directory: dir.path().join("fallback-work"),
    };
    let mut updates = Vec::new();

    let result = recover_and_extract(&job, &tools, &CancellationToken::default(), |update| {
        updates.push(update)
    })
    .expect("fallback recovery");

    assert!(result.success, "{}", result.message);
    assert_eq!(result.password.as_deref(), Some(password));
    assert_eq!(result.engine.as_deref(), Some("7-Zip CPU"));
    if cfg!(windows) {
        assert!(
            updates
                .iter()
                .any(|update| update.message.contains("命令行长度限制"))
        );
    }
    assert!(
        updates
            .iter()
            .any(|update| update.phase == RecoveryPhase::Internal)
    );
    assert!(
        updates
            .iter()
            .any(|update| update.attempted_count.is_some())
    );
    assert_eq!(
        fs::read_to_string(output_directory.join("fallback.txt")).unwrap(),
        "internal-fallback-ok"
    );
}

#[test]
fn cancellation_stops_before_external_engines() {
    let cancellation = CancellationToken::default();
    cancellation.cancel();
    assert!(matches!(
        ensure_not_cancelled(&cancellation),
        Err(RecoveryError::Cancelled)
    ));
}

#[test]
fn completed_external_engine_rechecks_long_candidates_with_seven_zip() {
    let Some(seven_zip) = locate_seven_zip() else {
        eprintln!("skip: 7z.exe not found");
        return;
    };

    // Simulate the exhausted engine boundary without requiring Hashcat/OpenCL
    // or John. Real 7-Zip must still recover candidates past each engine limit.
    for (format, limit, password) in [
        ("-t7z", 256, "a".repeat(257)),
        ("-t7z", 28, "密".repeat(11)),
        ("-tzip", 31, "a".repeat(32)),
    ] {
        let directory = tempfile::tempdir().unwrap();
        let payload = directory.path().join("payload.txt");
        fs::write(&payload, b"long-candidate-ok").unwrap();
        let archive = directory.path().join(if format == "-t7z" {
            "long.7z"
        } else {
            "long.zip"
        });
        create_encrypted_archive(&seven_zip, format, &password, &archive, &payload);
        let dictionary_path = directory.path().join("dictionary");
        fs::write(&dictionary_path, format!("wrong-short\r\n{password}\r\n")).unwrap();
        let job = RecoveryJob {
            archive_path: archive,
            output_directory: directory.path().join("output"),
            dictionary_path,
            dictionary_count: 2,
            known_password: None,
            work_directory: directory.path().join("work"),
        };
        fs::create_dir(&job.work_directory).unwrap();
        let tools = RecoveryToolPaths {
            seven_zip: seven_zip.clone(),
            hashcat: directory.path().join("missing-hashcat"),
            john_tools_directory: directory.path().join("missing-john"),
            perl: directory.path().join("missing-perl"),
        };
        let input = RecoveryInput {
            job: &job,
            archive_bytes: fs::metadata(&job.archive_path).unwrap().len(),
            disk_budget: &TaskDiskBudget::default(),
        };
        let result = cracking::finish_external_dictionary(
            &input,
            &tools,
            &CancellationToken::default(),
            &mut |_| {},
            &std::collections::HashSet::new(),
            limit,
            "external test engine",
        )
        .expect("long candidate fallback");

        assert!(result.success, "{}", result.message);
        assert_eq!(result.password.as_deref(), Some(password.as_str()));
        assert_eq!(
            fs::read(job.output_directory.join("payload.txt")).unwrap(),
            b"long-candidate-ok"
        );
    }
}

/// openwall/john-samples RAR fixtures (password = `password`).
#[test]
fn recovers_openwall_rar3_and_rar5_with_known_password() {
    let Some(seven_zip) = locate_seven_zip() else {
        eprintln!("skip: 7z.exe not found");
        return;
    };
    let fixtures = rar_fixture_dir();
    if !fixtures.is_dir() {
        eprintln!("skip: RAR fixtures missing at {}", fixtures.display());
        return;
    }

    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: PathBuf::from("hashcat-not-required"),
        john_tools_directory: PathBuf::from("john-not-required"),
        perl: PathBuf::from("perl-not-required"),
    };
    let password = "password";
    let cases = [
        ("rar3-p0.rar", ArchiveFormat::Rar3),
        ("rar3-hp0.rar", ArchiveFormat::Rar3),
        ("rar5-p0-password.rar", ArchiveFormat::Rar5),
        ("rar5-hp0-password.rar", ArchiveFormat::Rar5),
    ];

    let dir = tempfile::tempdir().unwrap();
    for (name, expected_format) in cases {
        let archive = fixtures.join(name);
        assert!(archive.is_file(), "missing fixture {name}");
        assert_eq!(
            detect_archive_format(&archive).unwrap(),
            expected_format,
            "{name} format"
        );

        let output_directory = dir.path().join(format!("{name}-out"));
        let job = RecoveryJob {
            archive_path: archive,
            output_directory: output_directory.clone(),
            dictionary_path: dir.path().join("empty.dict"),
            dictionary_count: 0,
            known_password: Some(password.into()),
            work_directory: dir.path().join(format!("{name}-work")),
        };
        fs::write(&job.dictionary_path, b"").unwrap();
        fs::create_dir_all(&job.work_directory).unwrap();

        let result =
            recover_and_extract(&job, &tools, &CancellationToken::default(), |_| {}).expect(name);
        assert!(result.success, "{name}: {}", result.message);
        assert_eq!(result.password.as_deref(), Some(password));
        assert!(
            output_directory.read_dir().unwrap().next().is_some(),
            "{name}: expected extracted files in {}",
            output_directory.display()
        );
    }
}

/// Full dictionary path: *2john → Hashcat/John → 7-Zip re-verify + extract.
///
/// Requires the prepared Windows engine bundle (see `engine-bundle:prepare`).
#[test]
#[ignore = "expands the large real tool bundle and runs Hashcat/John"]
fn dictionary_recovery_cracks_encrypted_7z_and_zip() {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return;
    }

    let resource_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("src-tauri")
        .join("resources");
    let tools_root = tempfile::tempdir().unwrap();
    let manager = super::super::FullEngineBundleManager::new(&resource_dir, tools_root.path());
    assert!(
        manager.status().bundled,
        "run `pnpm engine-bundle:prepare` first"
    );
    manager.install().expect("install engine bundle");

    let tools = RecoveryToolPaths {
        seven_zip: manager.seven_zip_executable(),
        hashcat: manager.hashcat_executable(),
        john_tools_directory: manager.john_tools_directory(),
        perl: manager.perl_executable(),
    };
    assert!(tools.john_tools_directory.join("rar2john.exe").is_file());
    assert!(tools.john_tools_directory.join("zip2john.exe").is_file());
    assert!(tools.john_tools_directory.join("7z2john.pl").is_file());

    let dir = tempfile::tempdir().unwrap();
    let payload = dir.path().join("payload.txt");
    fs::write(&payload, b"dictionary-recovery-ok").unwrap();
    let password = "dict-pass-42";
    let dictionary_path = dir.path().join("wordlist.txt");
    fs::write(&dictionary_path, "wrong1\nwrong2\ndict-pass-42\nwrong3\n").unwrap();
    let mut john_only_tools = tools.clone();
    john_only_tools.hashcat = tools_root
        .path()
        .join("intentionally-unavailable-hashcat.exe");

    for (name, format_flag) in [("dict.7z", "-t7z"), ("dict.zip", "-tzip")] {
        let archive = dir.path().join(name);
        create_encrypted_archive(&tools.seven_zip, format_flag, password, &archive, &payload);

        // Converter smoke check before the full recovery pipeline.
        let format = detect_archive_format(&archive).unwrap();
        let convert_job = RecoveryJob {
            archive_path: archive.clone(),
            output_directory: dir.path().join(format!("{name}-unused-out")),
            dictionary_path: dictionary_path.clone(),
            dictionary_count: 4,
            known_password: None,
            work_directory: dir.path().join(format!("{name}-convert-work")),
        };
        fs::create_dir_all(&convert_job.work_directory).unwrap();
        let records = extract_hashes(
            &convert_job,
            &tools,
            format,
            std::slice::from_ref(&convert_job.archive_path),
            &CancellationToken::default(),
        )
        .expect("converter should emit hash lines");
        assert!(
            !records.is_empty(),
            "{name}: converter produced no hash records"
        );

        for (engine_path, active_tools) in [("auto", &tools), ("john", &john_only_tools)] {
            let output_directory = dir.path().join(format!("{name}-{engine_path}-out"));
            let job = RecoveryJob {
                archive_path: archive.clone(),
                output_directory: output_directory.clone(),
                dictionary_path: dictionary_path.clone(),
                dictionary_count: 4,
                known_password: None,
                work_directory: dir.path().join(format!("{name}-{engine_path}-work")),
            };
            fs::create_dir_all(&job.work_directory).unwrap();
            let cancellation = CancellationToken::default();
            let mut phases = Vec::new();
            let result = recover_and_extract(&job, active_tools, &cancellation, |update| {
                phases.push(update.phase);
            })
            .expect("dictionary recovery");

            assert!(result.success, "{name} ({engine_path}): {}", result.message);
            let engine = result.engine.as_deref();
            eprintln!("native recovery {name} ({engine_path}): {engine:?}");
            if engine_path == "john" {
                assert_eq!(
                    engine,
                    Some("John CPU"),
                    "{name}: expected real John recovery"
                );
            } else {
                assert!(
                    matches!(engine, Some("Hashcat GPU" | "Hashcat CPU" | "John CPU")),
                    "{name}: expected external-engine recovery, got {engine:?}"
                );
            }
            assert_eq!(result.password.as_deref(), Some(password));
            assert_eq!(
                fs::read_to_string(output_directory.join("payload.txt")).unwrap(),
                "dictionary-recovery-ok"
            );
            assert!(
                phases.contains(&RecoveryPhase::Converting),
                "{name}: expected converting phase, got {phases:?}"
            );
        }
    }
}

/// RAR dictionary recovery using openwall fixtures + rar2john.
#[test]
#[ignore = "expands the large real tool bundle and runs Hashcat/John"]
fn dictionary_recovery_cracks_openwall_rar_samples() {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return;
    }
    let fixtures = rar_fixture_dir();
    assert!(fixtures.is_dir(), "RAR fixtures missing");

    let resource_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("src-tauri")
        .join("resources");
    let tools_root = tempfile::tempdir().unwrap();
    let manager = super::super::FullEngineBundleManager::new(&resource_dir, tools_root.path());
    assert!(manager.status().bundled, "run engine-bundle:prepare first");
    manager.install().expect("install engine bundle");

    let tools = RecoveryToolPaths {
        seven_zip: manager.seven_zip_executable(),
        hashcat: manager.hashcat_executable(),
        john_tools_directory: manager.john_tools_directory(),
        perl: manager.perl_executable(),
    };

    let dir = tempfile::tempdir().unwrap();
    let dictionary_path = dir.path().join("wordlist.txt");
    fs::write(&dictionary_path, "wrong\npassword\nnope\n").unwrap();
    let password = "password";

    // rar3-p0.rar is intentionally excluded: rar2john emits a "too small"
    // $RAR3$*1* candidate that this John build will not load. Known-password
    // extraction via 7-Zip still covers that fixture.
    for name in [
        "rar3-hp0.rar",
        "rar5-p0-password.rar",
        "rar5-hp0-password.rar",
    ] {
        let archive = fixtures.join(name);
        let format = detect_archive_format(&archive).unwrap();
        let convert_job = RecoveryJob {
            archive_path: archive.clone(),
            output_directory: dir.path().join(format!("{name}-unused")),
            dictionary_path: dictionary_path.clone(),
            dictionary_count: 3,
            known_password: None,
            work_directory: dir.path().join(format!("{name}-convert")),
        };
        fs::create_dir_all(&convert_job.work_directory).unwrap();
        let records = extract_hashes(
            &convert_job,
            &tools,
            format,
            std::slice::from_ref(&convert_job.archive_path),
            &CancellationToken::default(),
        )
        .unwrap_or_else(|error| panic!("{name} rar2john failed: {error}"));
        assert!(!records.is_empty(), "{name}: rar2john produced no hashes");

        let output_directory = dir.path().join(format!("{name}-out"));
        let job = RecoveryJob {
            archive_path: archive,
            output_directory: output_directory.clone(),
            dictionary_path: dictionary_path.clone(),
            dictionary_count: 3,
            known_password: None,
            work_directory: dir.path().join(format!("{name}-work")),
        };
        fs::create_dir_all(&job.work_directory).unwrap();
        let result = recover_and_extract(&job, &tools, &CancellationToken::default(), |_| {})
            .unwrap_or_else(|error| panic!("{name} recovery failed: {error}"));
        assert!(result.success, "{name}: {}", result.message);
        let engine = result.engine.as_deref();
        eprintln!("native recovery {name}: {engine:?}");
        assert!(
            matches!(engine, Some("Hashcat GPU" | "Hashcat CPU" | "John CPU")),
            "{name}: expected external-engine recovery, got {engine:?}"
        );
        assert_eq!(result.password.as_deref(), Some(password));
        assert!(
            output_directory.read_dir().unwrap().next().is_some(),
            "{name}: empty extract dir"
        );
    }
}

#[test]
#[ignore = "requires a usable Hashcat backend and expands the large real tool bundle"]
fn cancel_token_kills_long_running_hashcat_attempt() {
    if !cfg!(all(windows, target_arch = "x86_64")) {
        return;
    }

    let resource_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("src-tauri")
        .join("resources");
    let tools_root = tempfile::tempdir().unwrap();
    let manager = super::super::FullEngineBundleManager::new(&resource_dir, tools_root.path());
    assert!(manager.status().bundled, "run engine-bundle:prepare first");
    manager.install().expect("install engine bundle");

    let tools = RecoveryToolPaths {
        seven_zip: manager.seven_zip_executable(),
        hashcat: manager.hashcat_executable(),
        john_tools_directory: manager.john_tools_directory(),
        perl: manager.perl_executable(),
    };

    let dir = tempfile::tempdir().unwrap();
    let payload = dir.path().join("payload.txt");
    fs::write(&payload, b"cancel-me").unwrap();
    // Strong password unlikely to appear early in a tiny wrong wordlist.
    let password = "cancel-target-password-zz9";
    let archive = dir.path().join("cancel.7z");
    create_encrypted_archive(&tools.seven_zip, "-t7z", password, &archive, &payload);

    // Keep enough work pending to cancel after real Hashcat progress, including
    // on fast GPUs where a small wordlist can finish before the first update.
    let dictionary_path = dir.path().join("wrong.txt");
    let mut dict = String::new();
    for index in 0..100_000 {
        dict.push_str(&format!("not-the-password-{index}\n"));
    }
    fs::write(&dictionary_path, dict).unwrap();

    let job = RecoveryJob {
        archive_path: archive,
        output_directory: dir.path().join("cancel-out"),
        dictionary_path,
        dictionary_count: 100_000,
        known_password: None,
        work_directory: dir.path().join("cancel-work"),
    };
    fs::create_dir_all(&job.work_directory).unwrap();

    let cancellation = CancellationToken::default();
    let cancel_flag = cancellation.clone();
    let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
    let worker = std::thread::spawn(move || {
        recover_and_extract(&job, &tools, &cancellation, |update| {
            if update.phase == RecoveryPhase::Hashcat
                && update
                    .hashcat_progress
                    .as_ref()
                    .is_some_and(|progress| progress.completed < progress.total)
            {
                // This callback receives the running process's numeric status,
                // not just the stage announced before the process is spawned.
                let _ = started_tx.try_send(());
                cancellation.cancel();
            }
        })
    });
    let started = started_rx.recv_timeout(Duration::from_secs(120));
    // Bound failure paths as well: a missing backend or failed launch must not
    // leave John or the compatibility fallback processing the large wordlist.
    cancel_flag.cancel();
    let outcome = worker.join().expect("worker panicked");
    assert!(
        started.is_ok(),
        "Hashcat never reported active work before cancellation: {started:?}; {outcome:?}"
    );
    eprintln!("native cancellation: observed active Hashcat progress before cancelling");
    assert!(
        matches!(outcome, Err(RecoveryError::Cancelled))
            || matches!(
                outcome,
                Ok(RecoveryResult {
                    cancelled: true,
                    ..
                })
            ),
        "expected cancel, got {outcome:?}"
    );
}

fn test_crc32(bytes: &[u8]) -> u32 {
    let mut crc = u32::MAX;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

fn write_two_part_seven_zip_fixture(first: &Path, second: &Path) {
    let first_length = 128u64;
    let second_length = 24u64;
    let next_header = b"nexthead";
    let next_header_offset = first_length + second_length
        - SEVEN_ZIP_START_HEADER_SIZE_FOR_TEST as u64
        - next_header.len() as u64;

    let mut start_header = [0u8; SEVEN_ZIP_START_HEADER_SIZE_FOR_TEST];
    start_header[..SEVEN_ZIP_SIGNATURE.len()].copy_from_slice(SEVEN_ZIP_SIGNATURE);
    start_header[6..8].copy_from_slice(&[0, 4]);
    start_header[12..20].copy_from_slice(&next_header_offset.to_le_bytes());
    start_header[20..28].copy_from_slice(&(next_header.len() as u64).to_le_bytes());
    start_header[28..32].copy_from_slice(&test_crc32(next_header).to_le_bytes());
    let start_header_crc = test_crc32(&start_header[12..32]);
    start_header[8..12].copy_from_slice(&start_header_crc.to_le_bytes());

    let mut first_contents = vec![0x11; first_length as usize];
    first_contents[..start_header.len()].copy_from_slice(&start_header);
    fs::write(first, first_contents).unwrap();
    let mut second_contents = vec![0x22; second_length as usize];
    let next_header_start = second_contents.len() - next_header.len();
    second_contents[next_header_start..].copy_from_slice(next_header);
    fs::write(second, second_contents).unwrap();
}

fn rar_fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("fixtures")
        .join("rar")
}

fn write_lz4_frame(source: &Path, destination: &Path) {
    let mut input = BufReader::new(fs::File::open(source).unwrap());
    let output = BufWriter::new(fs::File::create(destination).unwrap());
    let mut encoder = lz4::EncoderBuilder::new().build(output).unwrap();
    std::io::copy(&mut input, &mut encoder).unwrap();
    let (mut output, result) = encoder.finish();
    result.unwrap();
    output.flush().unwrap();
}

#[test]
fn large_pe_overlay_is_detected_identically_on_reanalysis() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("large-sfx.exe");
    let mut bytes = minimal_pe_fixture();
    let raw_size = 5 * 1024 * 1024u32;
    let section_table = 0x80 + 24 + 0xf0;
    bytes[section_table + 16..section_table + 20].copy_from_slice(&raw_size.to_le_bytes());
    bytes.resize(0x400 + raw_size as usize, 0);
    bytes[4096..4096 + ZIP_SIGNATURES[0].len()].copy_from_slice(ZIP_SIGNATURES[0]);
    bytes.extend_from_slice(SEVEN_ZIP_SIGNATURE);
    fs::write(&path, bytes).unwrap();
    assert_eq!(
        detect_nested_archive_format(&path).unwrap(),
        ArchiveFormat::SevenZip
    );
    assert_eq!(
        detect_archive_format(&path).unwrap(),
        ArchiveFormat::SevenZip
    );
    assert_eq!(
        analyze_archive(&path).unwrap().format,
        ArchiveFormat::SevenZip
    );
}

fn minimal_pe_fixture() -> Vec<u8> {
    const PE_OFFSET: usize = 0x80;
    const OPTIONAL_HEADER_SIZE: usize = 0xf0;
    const SECTION_RAW_OFFSET: usize = 0x400;
    const SECTION_RAW_SIZE: usize = 0x2000;
    let section_table_offset = PE_OFFSET + 24 + OPTIONAL_HEADER_SIZE;
    let mut bytes = vec![0u8; SECTION_RAW_OFFSET + SECTION_RAW_SIZE];
    bytes[..2].copy_from_slice(b"MZ");
    bytes[0x3c..0x40].copy_from_slice(&(PE_OFFSET as u32).to_le_bytes());
    bytes[PE_OFFSET..PE_OFFSET + 4].copy_from_slice(b"PE\0\0");
    bytes[PE_OFFSET + 4..PE_OFFSET + 6].copy_from_slice(&0x8664u16.to_le_bytes());
    bytes[PE_OFFSET + 6..PE_OFFSET + 8].copy_from_slice(&1u16.to_le_bytes());
    bytes[PE_OFFSET + 20..PE_OFFSET + 22]
        .copy_from_slice(&(OPTIONAL_HEADER_SIZE as u16).to_le_bytes());
    bytes[PE_OFFSET + 22..PE_OFFSET + 24].copy_from_slice(&0x2022u16.to_le_bytes());
    bytes[PE_OFFSET + 24..PE_OFFSET + 26].copy_from_slice(&0x20bu16.to_le_bytes());
    bytes[section_table_offset + 16..section_table_offset + 20]
        .copy_from_slice(&(SECTION_RAW_SIZE as u32).to_le_bytes());
    bytes[section_table_offset + 20..section_table_offset + 24]
        .copy_from_slice(&(SECTION_RAW_OFFSET as u32).to_le_bytes());
    bytes
}

fn locate_seven_zip() -> Option<PathBuf> {
    let candidates = [
        PathBuf::from(r"C:\Program Files\7-Zip\7z.exe"),
        PathBuf::from(r"C:\Program Files (x86)\7-Zip\7z.exe"),
    ];
    for candidate in candidates {
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    std::env::var_os("PATH").and_then(|paths| {
        for dir in std::env::split_paths(&paths) {
            let candidate = dir.join(if cfg!(windows) { "7z.exe" } else { "7z" });
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    })
}

fn create_encrypted_archive(
    seven_zip: &Path,
    format_flag: &str,
    password: &str,
    archive: &Path,
    payload: &Path,
) {
    let password_arg = format!("-p{password}");
    let mut args = vec![
        "a".to_owned(),
        format_flag.to_owned(),
        "-y".to_owned(),
        password_arg,
    ];
    if format_flag == "-t7z" {
        args.push("-mhe=on".into());
    }
    args.push(archive.display().to_string());
    args.push(payload.display().to_string());
    let owned: Vec<&str> = args.iter().map(String::as_str).collect();
    run_seven_zip(seven_zip, &owned);
}

fn create_plain_archive(seven_zip: &Path, archive: &Path, payload: &Path) {
    run_seven_zip(
        seven_zip,
        &[
            "a",
            "-t7z",
            "-y",
            archive.to_str().unwrap(),
            payload.to_str().unwrap(),
        ],
    );
}

fn run_seven_zip(seven_zip: &Path, args: &[&str]) {
    let mut request = ProcessRequest::new(seven_zip);
    request.args = args.iter().map(OsString::from).collect();
    request.timeout = Duration::from_secs(60);
    let output = run_process(&request, None).expect("spawn 7z");
    assert!(
        output.success,
        "7z {:?} failed: stdout={} stderr={}",
        args, output.stdout, output.stderr
    );
}
