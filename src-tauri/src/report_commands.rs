use crate::AppState;
use arc_recall_core::{ArchiveFormat, RecoveryComputeMode};
use serde::{Deserialize, Serialize};
use std::{fs, io::Write};
use tauri::State;

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RecoveryReport {
    version: u32,
    summary: Summary,
    timings: Vec<Timing>,
    #[serde(skip_serializing_if = "Option::is_none")]
    paths: Option<ReportPaths>,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Summary {
    status: ReportStatus,
    archive_format: ArchiveFormat,
    compute_mode: RecoveryComputeMode,
    recursive: bool,
    root_extraction_completed: bool,
    elapsed_ms: u64,
    candidate_count: u64,
    attempted_count: u64,
    completed_archives: u64,
    skipped_archives: u64,
    pending_archives: u64,
    scanned_files: u64,
    unscanned_directories: u64,
    scan_interrupted: bool,
    depth_limit_reached: bool,
    count_limit_reached: bool,
    budget_limit_reached: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum ReportStatus {
    Running,
    Success,
    Failed,
    Cancelled,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Timing {
    operation: Operation,
    duration_ms: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
enum Operation {
    Fingerprint,
    Preflight,
    Verification,
    Extraction,
    Scan,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ReportPaths {
    archive: String,
    output: String,
    completed: Vec<String>,
    skipped: Vec<String>,
    pending: Vec<String>,
    unscanned: Vec<String>,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ReportFormat {
    Json,
    Csv,
}

fn csv_cell(value: &str) -> String {
    // Quoting alone does not prevent spreadsheet formulas.
    let unsafe_start = value.trim_start().starts_with(['=', '+', '-', '@'])
        || value.starts_with(['\t', '\r', '\n']);
    format!(
        "\"{}{}\"",
        if unsafe_start { "'" } else { "" },
        value.replace('"', "\"\"")
    )
}

fn render_report(report: &RecoveryReport, format: &ReportFormat) -> Result<String, String> {
    if report.version != 1 {
        return Err("不支持的报告版本。".into());
    }
    match format {
        ReportFormat::Json => serde_json::to_string_pretty(report).map_err(|e| e.to_string()),
        ReportFormat::Csv => {
            let mut rows = vec!["\u{feff}field,value".to_string()];
            let mut append = |key: &str, value: &str| {
                rows.push(format!("{},{}", csv_cell(key), csv_cell(value)))
            };
            append("version", "1");
            let summary = serde_json::to_value(&report.summary).map_err(|e| e.to_string())?;
            for (key, value) in summary.as_object().ok_or("报告摘要无效")? {
                append(
                    key,
                    &value
                        .as_str()
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_string()),
                );
            }
            for timing in &report.timings {
                let operation =
                    serde_json::to_value(&timing.operation).map_err(|e| e.to_string())?;
                append(
                    &format!("timing.{}.ms", operation.as_str().unwrap_or_default()),
                    &timing.duration_ms.to_string(),
                );
            }
            if let Some(paths) = &report.paths {
                append("archive", &paths.archive);
                append("output", &paths.output);
                for (label, paths) in [
                    ("completed", &paths.completed),
                    ("skipped", &paths.skipped),
                    ("pending", &paths.pending),
                    ("unscanned", &paths.unscanned),
                ] {
                    for path in paths {
                        append(label, path);
                    }
                }
            }
            Ok(rows.join("\r\n") + "\r\n")
        }
    }
}

#[tauri::command]
pub(crate) async fn recovery_report_export(
    state: State<'_, AppState>,
    report: RecoveryReport,
    format: ReportFormat,
) -> Result<String, String> {
    let root = state.paths.exports.clone();
    let lease = state.lifecycle.begin()?;
    tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        let content = render_report(&report, &format)?;
        if content.len() > 4 * 1024 * 1024 {
            return Err("报告过大。".into());
        }
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let suffix = match format {
            ReportFormat::Json => ".json",
            ReportFormat::Csv => ".csv",
        };
        let mut file = tempfile::Builder::new()
            .prefix("recovery-report-")
            .suffix(suffix)
            .tempfile_in(root)
            .map_err(|e| e.to_string())?;
        file.write_all(content.as_bytes())
            .map_err(|e| e.to_string())?;
        file.as_file().sync_all().map_err(|e| e.to_string())?;
        let (_, path) = file.keep().map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn csv_handles_formulas_quotes_commas_unicode_and_newlines() {
        assert_eq!(csv_cell("=1+1"), "\"'=1+1\"");
        assert_eq!(csv_cell("  @SUM(1)"), "\"'  @SUM(1)\"");
        assert_eq!(csv_cell("\tvalue"), "\"'\tvalue\"");
        assert_eq!(csv_cell("中文,\"a\"\nnext"), "\"中文,\"\"a\"\"\nnext\"");
    }
}
