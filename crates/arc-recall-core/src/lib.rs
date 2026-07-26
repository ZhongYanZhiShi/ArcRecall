pub mod dictionary;
pub mod paths;
pub mod settings;

pub use dictionary::{
    DEFAULT_PAGE_SIZE, DictionaryCandidateAddSummary, DictionaryCandidateEntry,
    DictionaryCandidateQuery, DictionaryCandidateStore, DictionaryError, DictionaryListResult,
    MAX_CANDIDATE_BYTES,
};
pub use paths::{APP_DATA_FOLDER_NAME, AppPaths};
pub use settings::{AppSettings, DatabaseInfo, SettingsError, SettingsStore};

pub const SERVICE_NAME: &str = "arc-recall-core";

pub fn health_status() -> &'static str {
    "ok"
}
