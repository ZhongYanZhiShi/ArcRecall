use serde::Deserialize;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ReportFormat {
    Json,
    Csv,
}

pub(crate) fn csv_cell(value: &str) -> String {
    // Quoting alone does not prevent spreadsheet formulas.
    let unsafe_start = value.trim_start().starts_with(['=', '+', '-', '@'])
        || value.starts_with(['\t', '\r', '\n']);
    format!(
        "\"{}{}\"",
        if unsafe_start { "'" } else { "" },
        value.replace('"', "\"\"")
    )
}

/// Publish a complete, synced report; failed writes leave no partial export.
pub(crate) fn write_report(
    root: &Path,
    prefix: &str,
    format: &ReportFormat,
    content: &str,
) -> Result<PathBuf, String> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let suffix = match format {
        ReportFormat::Json => ".json",
        ReportFormat::Csv => ".csv",
    };
    let mut file = tempfile::Builder::new()
        .prefix(prefix)
        .suffix(suffix)
        .tempfile_in(root)
        .map_err(|e| e.to_string())?;
    file.write_all(content.as_bytes())
        .map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    let (_, path) = file.keep().map_err(|e| e.to_string())?;
    Ok(path)
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

    #[test]
    fn reports_have_distinct_names_and_preserve_complete_unicode_contents() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("[测试分组] 报告");
        let first = write_report(&root, "report-", &ReportFormat::Csv, "中文,\"a\"\nnext").unwrap();
        let second = write_report(&root, "report-", &ReportFormat::Json, "{}").unwrap();
        assert_ne!(first, second);
        assert_eq!(first.extension().unwrap(), "csv");
        assert_eq!(second.extension().unwrap(), "json");
        assert_eq!(fs::read_to_string(first).unwrap(), "中文,\"a\"\nnext");
        assert_eq!(fs::read_to_string(second).unwrap(), "{}");
    }
}
