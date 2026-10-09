use super::*;

// A real stored ZIP, split through file data. The incidental local-header
// signature in the payload must never make that middle disk a separate archive.
fn split_zip(directory: &Path, stem: &str, zip64: bool) -> (Vec<PathBuf>, Vec<u8>) {
    let name = b"payload.bin";
    let mut payload = vec![0x61; 300];
    payload[170..174].copy_from_slice(b"PK\x03\x04");
    let mut local = vec![0; 30];
    local[..4].copy_from_slice(b"PK\x03\x04");
    local[4..6].copy_from_slice(&20u16.to_le_bytes());
    local[14..18].copy_from_slice(&test_crc32(&payload).to_le_bytes());
    local[18..22].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    local[22..26].copy_from_slice(&(payload.len() as u32).to_le_bytes());
    local[26..28].copy_from_slice(&(name.len() as u16).to_le_bytes());
    local.extend_from_slice(name);
    local.extend_from_slice(&payload);
    let mut bytes = b"PK\x07\x08".to_vec();
    bytes.extend_from_slice(&local);
    let mut central = vec![0; 46];
    central[..4].copy_from_slice(b"PK\x01\x02");
    central[4..6].copy_from_slice(&20u16.to_le_bytes());
    central[6..8].copy_from_slice(&20u16.to_le_bytes());
    central[16..28].copy_from_slice(&local[14..26]);
    central[28..30].copy_from_slice(&(name.len() as u16).to_le_bytes());
    central[42..46].copy_from_slice(&4u32.to_le_bytes());
    central.extend_from_slice(name);
    let central_offset = bytes.len() - 300;
    bytes.extend_from_slice(&central);
    if zip64 {
        let offset = bytes.len() - 300;
        let mut end64 = vec![0; 56];
        end64[..4].copy_from_slice(b"PK\x06\x06");
        end64[4..12].copy_from_slice(&44u64.to_le_bytes());
        end64[12..14].copy_from_slice(&45u16.to_le_bytes());
        end64[14..16].copy_from_slice(&45u16.to_le_bytes());
        end64[16..20].copy_from_slice(&3u32.to_le_bytes());
        end64[20..24].copy_from_slice(&3u32.to_le_bytes());
        end64[24..32].copy_from_slice(&1u64.to_le_bytes());
        end64[32..40].copy_from_slice(&1u64.to_le_bytes());
        end64[40..48].copy_from_slice(&(central.len() as u64).to_le_bytes());
        end64[48..56].copy_from_slice(&(central_offset as u64).to_le_bytes());
        bytes.extend_from_slice(&end64);
        bytes.extend_from_slice(b"PK\x06\x07");
        bytes.extend_from_slice(&3u32.to_le_bytes());
        bytes.extend_from_slice(&(offset as u64).to_le_bytes());
        bytes.extend_from_slice(&4u32.to_le_bytes());
    }
    let mut end = vec![0; 22];
    end[..4].copy_from_slice(b"PK\x05\x06");
    end[4..6].copy_from_slice(&3u16.to_le_bytes());
    end[6..8].copy_from_slice(&3u16.to_le_bytes());
    end[8..10].copy_from_slice(&1u16.to_le_bytes());
    end[10..12].copy_from_slice(&1u16.to_le_bytes());
    end[12..16].copy_from_slice(&(central.len() as u32).to_le_bytes());
    end[16..20].copy_from_slice(&(central_offset as u32).to_le_bytes());
    if zip64 {
        end[4..20].fill(0xff);
    }
    bytes.extend_from_slice(&end);
    let mut volumes = Vec::new();
    for i in 0..4 {
        let extension = if i == 3 {
            "zip".into()
        } else {
            format!("z{:02}", i + 1)
        };
        let path = directory.join(format!("{stem}.{extension}"));
        fs::write(
            &path,
            &bytes[i * 100..if i == 3 { bytes.len() } else { (i + 1) * 100 }],
        )
        .unwrap();
        volumes.push(path);
    }
    (volumes, payload)
}

#[test]
fn zip_volumes_any_selection_has_same_entry_size_and_fingerprint() {
    let dir = tempfile::tempdir().unwrap();
    for zip64 in [false, true] {
        let (volumes, _) = split_zip(dir.path(), if zip64 { "large" } else { "普通.备份" }, zip64);
        let expected: Vec<_> = volumes.iter().map(|p| p.canonicalize().unwrap()).collect();
        let size: u64 = volumes.iter().map(|p| p.metadata().unwrap().len()).sum();
        let mut fingerprint = None;
        for path in &volumes {
            let analysis = analyze_archive(path).unwrap();
            assert_eq!(analysis.format, ArchiveFormat::Zip);
            assert_eq!(analysis.volume_paths, expected);
            assert_eq!(analysis.file_size, size);
            assert_eq!(analysis.volume_count, 4);
            assert_eq!(analysis.archive_path, path_for_display(&expected[3]));
            let value = fingerprint_archive_sha256(&analysis).unwrap();
            assert_eq!(fingerprint.get_or_insert(value.clone()), &value);
        }
    }
}

#[test]
fn zip_volumes_missing_middle_or_tail_is_reported_before_signature_detection() {
    for missing in [0, 1, 3] {
        let dir = tempfile::tempdir().unwrap();
        let (volumes, _) = split_zip(dir.path(), "incomplete", false);
        fs::remove_file(&volumes[missing]).unwrap();
        let error = analyze_archive(&volumes[2]).unwrap_err().to_string();
        assert!(
            error.contains("ZIP 分卷") && error.contains("缺少"),
            "{error}"
        );
    }
}

#[test]
fn zip_volumes_repair_preserves_disk_layout() {
    let dir = tempfile::tempdir().unwrap();
    let (volumes, _) = split_zip(dir.path(), "repair", false);
    let repaired =
        create_repaired_archive_copy(&volumes[2], &CancellationToken::default()).unwrap();
    assert!(repaired.is_dir());
    let analysis = analyze_archive(repaired.join("archive.zip")).unwrap();
    assert_eq!(analysis.volume_count, 4);
    for (source, copy) in volumes.iter().zip(analysis.volume_paths) {
        assert_eq!(fs::read(source).unwrap(), fs::read(&copy).unwrap());
        fs::write(copy, b"independent").unwrap();
        assert_ne!(fs::read(source).unwrap(), b"independent");
    }
}

#[test]
fn zip_volumes_names_comments_and_invalid_sets() {
    let dir = tempfile::tempdir().unwrap();
    let (mut volumes, _) = split_zip(dir.path(), "中文.backup", false);
    // Case and padding variations are normalized for external tools.
    for (i, path) in volumes.iter_mut().enumerate() {
        let renamed = path.with_extension(if i == 3 {
            "ZIP".into()
        } else {
            format!("Z{:03}", i + 1)
        });
        fs::rename(&*path, &renamed).unwrap();
        *path = renamed;
    }
    let mut tail = fs::read(&volumes[3]).unwrap();
    let comment = b"comment with PK\x05\x06 and PK\x03\x04";
    let length_at = tail.len() - 2;
    tail[length_at..].copy_from_slice(&(comment.len() as u16).to_le_bytes());
    tail.extend_from_slice(comment);
    fs::write(&volumes[3], &tail).unwrap();
    let analysis = analyze_archive(&volumes[1]).unwrap();
    assert_eq!(analysis.volume_count, 4);
    let work = dir.path().join("work");
    fs::create_dir(&work).unwrap();
    let materialization = materialize_split_archive(
        &analysis,
        &work,
        &CancellationToken::default(),
        &TaskDiskBudget::default(),
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        materialization.primary_path().file_name().unwrap(),
        "archive.zip"
    );
    assert_eq!(
        materialization.volume_paths()[0].file_name().unwrap(),
        "archive.z01"
    );
    let duplicate = dir.path().join("中文.backup.z01");
    fs::write(&duplicate, b"duplicate").unwrap();
    assert!(
        analyze_archive(&volumes[1])
            .unwrap_err()
            .to_string()
            .contains("重复")
    );
    fs::remove_file(duplicate).unwrap();
    fs::write(&volumes[1], b"").unwrap();
    assert!(
        analyze_archive(&volumes[0])
            .unwrap_err()
            .to_string()
            .contains("为空")
    );
}

#[test]
fn zip_volumes_reject_truncated_or_inconsistent_directory() {
    for corruption in [0, 1, 2, 3, 4] {
        let dir = tempfile::tempdir().unwrap();
        let (volumes, _) = split_zip(dir.path(), "invalid", false);
        let mut tail = fs::read(&volumes[3]).unwrap();
        let end = tail.len() - 22;
        match corruption {
            0 => {
                tail.pop();
            }
            1 => {
                tail[end + 6..end + 8].copy_from_slice(&9u16.to_le_bytes());
            }
            2 => {
                tail[end + 16..end + 20].copy_from_slice(&u32::MAX.to_le_bytes());
            }
            3 => {
                tail[45..49].copy_from_slice(b"fake");
            }
            _ => {
                fs::write(dir.path().join("invalid.z04"), b"stale").unwrap();
            }
        }
        fs::write(&volumes[3], tail).unwrap();
        assert!(
            analyze_archive(&volumes[2])
                .unwrap_err()
                .to_string()
                .contains("ZIP 分卷")
        );
    }
}

#[test]
fn zip_volumes_large_tail_is_identified_without_a_prefix_signature() {
    use std::io::{Seek, SeekFrom};
    let dir = tempfile::tempdir().unwrap();
    let (volumes, _) = split_zip(dir.path(), "large-tail", false);
    let mut tail = fs::read(&volumes[3]).unwrap();
    let shift = 5 * 1024 * 1024;
    let offset_at = tail.len() - 6;
    tail[offset_at..offset_at + 4].copy_from_slice(&(45u32 + shift).to_le_bytes());
    let mut file = fs::File::create(&volumes[3]).unwrap();
    file.seek(SeekFrom::Start(u64::from(shift))).unwrap();
    file.write_all(&tail).unwrap();
    assert_eq!(analyze_archive(&volumes[3]).unwrap().volume_count, 4);
}

fn ordinary_zip_bytes(directory: &Path) -> Vec<u8> {
    let (volumes, _) = split_zip(directory, "source", false);
    let mut bytes: Vec<_> = volumes.iter().flat_map(|p| fs::read(p).unwrap()).collect();
    let end = bytes.len() - 22;
    bytes[end + 4..end + 8].fill(0);
    bytes[end + 16..end + 20].copy_from_slice(&345u32.to_le_bytes());
    bytes
}

#[test]
fn zip_volumes_numbered_parts_allow_directory_records_across_boundaries() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = ordinary_zip_bytes(dir.path());
    let boundary = bytes.len() - 10; // Split the EOCD itself.
    let first = dir.path().join("bytes.ZIP.001");
    let last = dir.path().join("bytes.ZIP.002");
    fs::write(&first, &bytes[..boundary]).unwrap();
    fs::write(&last, &bytes[boundary..]).unwrap();
    let a = analyze_archive(&first).unwrap();
    let b = analyze_archive(&last).unwrap();
    assert_eq!(a, b);
    assert_eq!(a.volume_count, 2);
    assert_eq!(
        a.archive_path,
        path_for_display(&first.canonicalize().unwrap())
    );
    fs::rename(&last, last.with_extension("003")).unwrap();
    assert!(
        analyze_archive(&first)
            .unwrap_err()
            .to_string()
            .contains("缺少卷号 2")
    );
}

#[test]
fn zip_volumes_zip64_numbered_and_standalone_and_invalid_locator() {
    let dir = tempfile::tempdir().unwrap();
    let (volumes, _) = split_zip(dir.path(), "zip64", true);
    let mut bytes: Vec<_> = volumes.iter().flat_map(|p| fs::read(p).unwrap()).collect();
    let locator = bytes.len() - 42;
    let record = locator - 56;
    bytes[record + 16..record + 24].fill(0);
    bytes[record + 48..record + 56].copy_from_slice(&345u64.to_le_bytes());
    bytes[locator + 4..locator + 8].fill(0);
    bytes[locator + 8..locator + 16].copy_from_slice(&(record as u64).to_le_bytes());
    bytes[locator + 16..locator + 20].copy_from_slice(&1u32.to_le_bytes());
    let standalone = dir.path().join("single.zip");
    fs::write(&standalone, &bytes).unwrap();
    fs::write(standalone.with_extension("z01"), b"stale").unwrap();
    assert_eq!(analyze_archive(standalone).unwrap().volume_count, 1);
    // All three end records can cross byte-volume boundaries.
    for boundary in [record + 8, locator + 8, bytes.len() - 8] {
        let first = dir.path().join(format!("zip64-{boundary}.zip.001"));
        let last = first.with_extension("002");
        fs::write(&first, &bytes[..boundary]).unwrap();
        fs::write(&last, &bytes[boundary..]).unwrap();
        assert_eq!(
            analyze_archive(&first).unwrap(),
            analyze_archive(&last).unwrap()
        );
    }
    let mut tail = fs::read(&volumes[3]).unwrap();
    let offset = tail.len() - 42 + 8;
    tail[offset..offset + 8].copy_from_slice(&u64::MAX.to_le_bytes());
    fs::write(&volumes[3], tail).unwrap();
    assert!(
        analyze_archive(&volumes[0])
            .unwrap_err()
            .to_string()
            .contains("偏移")
    );
}

#[test]
fn zip_volumes_central_directory_can_span_disks() {
    let dir = tempfile::tempdir().unwrap();
    let (volumes, _) = split_zip(dir.path(), "directory", false);
    let mut bytes: Vec<_> = volumes.iter().flat_map(|p| fs::read(p).unwrap()).collect();
    let end = bytes.len() - 22;
    // Directory begins on disk 2 and ends on disk 3; disk sizes differ.
    bytes[end + 6..end + 8].copy_from_slice(&2u16.to_le_bytes());
    bytes[end + 8..end + 10].fill(0);
    bytes[end + 16..end + 20].copy_from_slice(&145u32.to_le_bytes());
    fs::write(&volumes[2], &bytes[200..390]).unwrap();
    fs::write(&volumes[3], &bytes[390..]).unwrap();
    assert_eq!(analyze_archive(&volumes[3]).unwrap().volume_count, 4);
}

#[test]
fn zip_volumes_numeric_order_extends_past_two_digits() {
    let dir = tempfile::tempdir().unwrap();
    let (source, _) = split_zip(dir.path(), "source", false);
    let mut bytes: Vec<_> = source.iter().flat_map(|p| fs::read(p).unwrap()).collect();
    let end = bytes.len() - 22;
    bytes[end + 4..end + 8].copy_from_slice(&[100, 0, 100, 0]);
    bytes[end + 16..end + 20].copy_from_slice(&47u32.to_le_bytes());
    let first = dir.path().join("many.z01");
    fs::write(&first, &bytes[..100]).unwrap();
    for i in 2..=100 {
        let start = 100 + (i - 2) * 2;
        fs::write(
            dir.path().join(format!("many.z{i:02}")),
            &bytes[start..start + 2],
        )
        .unwrap();
    }
    fs::write(dir.path().join("many.zip"), &bytes[298..]).unwrap();
    let analysis = analyze_archive(dir.path().join("many.z100")).unwrap();
    assert_eq!(analysis.volume_count, 101);
    assert_eq!(analysis.volume_paths[99].file_name().unwrap(), "many.z100");
}

#[test]
fn zip_volumes_embedded_signatures_do_not_override_the_disk_set() {
    let dir = tempfile::tempdir().unwrap();
    let (volumes, _) = split_zip(dir.path(), "embedded", false);
    let mut part = fs::read(&volumes[1]).unwrap();
    part[..RAR5_SIGNATURE.len()].copy_from_slice(RAR5_SIGNATURE);
    // A complete-looking single-disk EOCD at the end of file data is incidental.
    let end = part.len() - 22;
    part[end..].fill(0);
    part[end..end + 4].copy_from_slice(b"PK\x05\x06");
    fs::write(&volumes[1], part).unwrap();
    let analysis = analyze_archive(&volumes[1]).unwrap();
    assert_eq!(analysis.format, ArchiveFormat::Zip);
    assert_eq!(analysis.volume_count, 4);
}

#[test]
fn zip_volumes_recursive_scan_schedules_one_archive_per_set() {
    let Some(seven_zip) = locate_seven_zip() else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let inputs = dir.path().join("inputs");
    fs::create_dir(&inputs).unwrap();
    let (_, payload) = split_zip(&inputs, "nested", false);
    let archive = dir.path().join("outer.7z");
    create_plain_archive(&seven_zip, &archive, &inputs);
    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: dir.path().join("unused"),
        john_tools_directory: dir.path().join("unused"),
        perl: dir.path().join("unused"),
    };
    let job = RecoveryJob {
        archive_path: archive,
        output_directory: dir.path().join("out"),
        dictionary_path: dir.path().join("unused"),
        dictionary_count: 0,
        known_password: None,
        work_directory: dir.path().join("work"),
    };
    let result = recover_and_extract_recursive_lazy(
        &job,
        &tools,
        &CancellationToken::default(),
        RecursiveRecoveryOptions::default(),
        None,
        || panic!("plain archives"),
        |_| {},
    )
    .unwrap();
    assert!(result.root.success);
    assert_eq!(result.discovered_nested_archives, 1);
    assert_eq!(result.extracted_nested_archives, 1);
    assert_eq!(result.recovered_archives.len(), 2);
    assert_eq!(
        fs::read(job.output_directory.join("inputs/nested/payload.bin")).unwrap(),
        payload
    );
}

#[test]
fn zip_volumes_standalone_zip_ignores_stale_parts_and_extensions_are_not_proof() {
    let dir = tempfile::tempdir().unwrap();
    let bytes = ordinary_zip_bytes(dir.path());
    let path = dir.path().join("standalone.zip");
    let renamed = dir.path().join("standalone-renamed.z01");
    fs::write(&renamed, &bytes).unwrap();
    assert_eq!(analyze_archive(renamed).unwrap().volume_count, 1);
    fs::write(dir.path().join("renamed.zip.001"), RAR5_SIGNATURE).unwrap();
    assert_eq!(
        analyze_archive(dir.path().join("renamed.zip.001"))
            .unwrap()
            .format,
        ArchiveFormat::Rar5
    );
    fs::write(&path, bytes).unwrap();
    fs::write(path.with_extension("z01"), b"stale").unwrap();
    assert_eq!(analyze_archive(&path).unwrap().volume_count, 1);
    fs::write(dir.path().join("fake.zip"), b"not an archive").unwrap();
    assert!(analyze_archive(dir.path().join("fake.zip")).is_err());
    fs::write(dir.path().join("fake.z01"), b"not an archive").unwrap();
    assert!(analyze_archive(dir.path().join("fake.z01")).is_err());
    fs::write(dir.path().join("renamed.z01"), RAR5_SIGNATURE).unwrap();
    assert_eq!(
        analyze_archive(dir.path().join("renamed.z01"))
            .unwrap()
            .format,
        ArchiveFormat::Rar5
    );
}

#[test]
fn zip_volumes_encrypted_numbered_and_spanned_recover_with_real_seven_zip() {
    let Some(seven_zip) = locate_seven_zip() else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let password = "zip-volume-test-42";
    let payload = dir.path().join("secret.txt");
    let contents = vec![b'A'; 2048];
    fs::write(&payload, &contents).unwrap();
    let original = dir.path().join("original.zip");
    run_seven_zip(
        &seven_zip,
        &[
            "a",
            "-tzip",
            "-mx=0",
            "-mem=AES256",
            "-pzip-volume-test-42",
            "-y",
            original.to_str().unwrap(),
            payload.to_str().unwrap(),
        ],
    );
    let bytes = fs::read(&original).unwrap();
    let end = bytes.len() - 22;
    let central = u32::from_le_bytes(bytes[end + 16..end + 20].try_into().unwrap()) as usize;
    let tools_dir = dir.path().join("tools");
    fs::create_dir(&tools_dir).unwrap();
    // The split path must bypass even an installed converter, not accidentally
    // rely on it being absent. This file is deliberately not executable.
    fs::write(tools_dir.join("zip2john.exe"), b"must not run").unwrap();
    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: dir.path().join("unused"),
        john_tools_directory: tools_dir,
        perl: dir.path().join("unused"),
    };
    let dictionary_path = dir.path().join("words.txt");
    fs::write(&dictionary_path, format!("wrong\n{password}\n")).unwrap();
    for numbered in [false, true] {
        let stem = if numbered { "numbered.zip" } else { "spanned" };
        let mut data = bytes.clone();
        if !numbered {
            data[end + 4..end + 8].copy_from_slice(&[2, 0, 2, 0]);
            data[end + 16..end + 20].copy_from_slice(&((central - 1024) as u32).to_le_bytes());
        }
        let mut volumes = Vec::new();
        for i in 0..3 {
            let extension = if numbered {
                format!("{:03}", i + 1)
            } else if i == 2 {
                "zip".into()
            } else {
                format!("z{:02}", i + 1)
            };
            let path = dir.path().join(format!("{stem}.{extension}"));
            fs::write(
                &path,
                &data[i * 512..if i == 2 { data.len() } else { (i + 1) * 512 }],
            )
            .unwrap();
            volumes.push(path);
        }
        for known in [true, false] {
            let job = RecoveryJob {
                archive_path: volumes[1].clone(),
                output_directory: dir.path().join(format!("out-{numbered}-{known}")),
                dictionary_path: dictionary_path.clone(),
                dictionary_count: 2,
                known_password: known.then(|| password.into()),
                work_directory: dir.path().join(format!("work-{numbered}-{known}")),
            };
            let mut updates = Vec::new();
            let result = recover_and_extract(&job, &tools, &CancellationToken::default(), |u| {
                updates.push(u)
            })
            .unwrap();
            assert!(result.success, "{}", result.message);
            assert_eq!(result.password.as_deref(), Some(password));
            assert_eq!(
                fs::read(job.output_directory.join("secret.txt")).unwrap(),
                contents
            );
            if !known {
                assert_eq!(result.engine.as_deref(), Some("7-Zip CPU"));
                assert!(
                    updates
                        .iter()
                        .any(|u| u.message.contains("zip2john 不支持 ZIP 分卷"))
                );
                assert!(!updates.iter().any(|u| u.phase == RecoveryPhase::Converting));
            }
        }
    }
}

#[test]
fn zip_volumes_extract_from_every_disk_with_real_seven_zip() {
    let Some(seven_zip) = locate_seven_zip() else {
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let (volumes, payload) = split_zip(dir.path(), "extract", false);
    let tools = RecoveryToolPaths {
        seven_zip,
        hashcat: dir.path().join("unused"),
        john_tools_directory: dir.path().join("unused"),
        perl: dir.path().join("unused"),
    };
    for (index, archive_path) in volumes.into_iter().enumerate() {
        let job = RecoveryJob {
            archive_path,
            output_directory: dir.path().join(format!("out-{index}")),
            dictionary_path: dir.path().join("unused"),
            dictionary_count: 0,
            known_password: None,
            work_directory: dir.path().join(format!("work-{index}")),
        };
        let result = recover_and_extract_lazy(
            &job,
            &tools,
            &CancellationToken::default(),
            || panic!("plain ZIP must not prepare a dictionary"),
            |_| {},
        )
        .unwrap();
        assert!(result.success);
        assert_eq!(
            fs::read(job.output_directory.join("payload.bin")).unwrap(),
            payload
        );
    }
}
