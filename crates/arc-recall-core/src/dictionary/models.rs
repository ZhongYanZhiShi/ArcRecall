use serde::{Deserialize, Serialize};

/// Summary returned after submitting candidates for insertion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryCandidateAddSummary {
    pub submitted_count: u64,
    pub added_count: u64,
    pub duplicate_count: u64,
    pub invalid_count: u64,
}

impl DictionaryCandidateAddSummary {
    pub const EMPTY: Self = Self {
        submitted_count: 0,
        added_count: 0,
        duplicate_count: 0,
        invalid_count: 0,
    };

    pub fn merge(self, other: Self) -> Self {
        Self {
            submitted_count: self.submitted_count + other.submitted_count,
            added_count: self.added_count + other.added_count,
            duplicate_count: self.duplicate_count + other.duplicate_count,
            invalid_count: self.invalid_count + other.invalid_count,
        }
    }
}

/// A single candidate row as shown in the dictionary library UI.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryCandidateEntry {
    pub id: i64,
    pub value: String,
    pub byte_count: i64,
    pub success_count: i64,
}

/// Query parameters for listing / searching candidates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryCandidateQuery {
    #[serde(default)]
    pub search_text: String,
    #[serde(default)]
    pub skip: i64,
    #[serde(default = "default_take")]
    pub take: i64,
}

fn default_take() -> i64 {
    500
}

impl Default for DictionaryCandidateQuery {
    fn default() -> Self {
        Self {
            search_text: String::new(),
            skip: 0,
            take: default_take(),
        }
    }
}

/// Combined list payload for the dictionary page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryListResult {
    pub entries: Vec<DictionaryCandidateEntry>,
    pub total_count: u64,
}
