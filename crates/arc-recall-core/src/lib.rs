pub mod dictionary;

pub use dictionary::{
    DEFAULT_PAGE_SIZE, DictionaryCandidateAddSummary, DictionaryCandidateEntry,
    DictionaryCandidateQuery, DictionaryCandidateStore, DictionaryError, DictionaryListResult,
    MAX_CANDIDATE_BYTES,
};

pub const SERVICE_NAME: &str = "arc-recall-core";

pub fn health_status() -> &'static str {
    "ok"
}
