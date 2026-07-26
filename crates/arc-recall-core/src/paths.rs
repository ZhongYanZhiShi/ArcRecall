use std::path::{Path, PathBuf};

/// Directory name under the OS local data folder (not the reverse-domain bundle id).
pub const APP_DATA_FOLDER_NAME: &str = "ArcRecall";

/// Application data layout under a platform local-data root.
///
/// - Windows: `%LocalAppData%\ArcRecall`
/// - macOS / Linux: `{local_data_dir}/ArcRecall`
///
/// Database, settings and optional external tools live outside the project tree.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    pub root: PathBuf,
    pub database: PathBuf,
    pub settings: PathBuf,
    pub exports: PathBuf,
    pub tools: PathBuf,
    pub temp: PathBuf,
}

impl AppPaths {
    pub fn from_root(root: impl Into<PathBuf>) -> Self {
        let root = root.into();
        Self {
            database: root.join("arcrecall.db"),
            settings: root.join("settings.json"),
            exports: root.join("exports"),
            tools: root.join("tools"),
            temp: root.join("temp"),
            root,
        }
    }

    /// `{local_data_dir}/ArcRecall`
    pub fn from_local_data_dir(local_data_dir: impl AsRef<Path>) -> Self {
        Self::from_root(local_data_dir.as_ref().join(APP_DATA_FOLDER_NAME))
    }

    pub fn ensure_dirs(&self) -> std::io::Result<()> {
        std::fs::create_dir_all(&self.root)?;
        std::fs::create_dir_all(&self.exports)?;
        std::fs::create_dir_all(&self.tools)?;
        std::fs::create_dir_all(&self.temp)?;
        Ok(())
    }

    pub fn database_exists(&self) -> bool {
        self.database.is_file()
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}
