use super::*;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskRecordQuery {
    pub text: String,
    pub operation: Option<TaskOperation>,
    pub state: Option<String>,
    pub failed_only: bool,
    pub from_ms: Option<u64>,
    /// Exclusive upper bound, so local calendar days work across DST transitions.
    pub before_ms: Option<u64>,
}

impl TaskRecordQuery {
    fn validate(&self) -> Result<(), String> {
        if self.text.chars().count() > 500
            || self.state.as_deref().is_some_and(|v| {
                !matches!(
                    v,
                    "running" | "success" | "partial" | "failed" | "cancelled" | "interrupted"
                )
            })
            || self.from_ms.is_some_and(|v| v > i64::MAX as u64)
            || self.before_ms.is_some_and(|v| v > i64::MAX as u64)
            || matches!((self.from_ms, self.before_ms), (Some(a), Some(b)) if a >= b)
        {
            return Err("查询条件无效，请检查关键词、状态和日期范围。".into());
        }
        Ok(())
    }
}

impl TaskRecordStore {
    pub fn search(
        &self,
        query: &TaskRecordQuery,
        skip: u32,
        limit: u32,
    ) -> Result<Vec<TaskRecord>, String> {
        query.validate()?;
        let operation = query.operation.map(|v| {
            serde_json::to_value(v)
                .unwrap()
                .as_str()
                .unwrap()
                .to_string()
        });
        let mut stmt = self.0.prepare("SELECT record, state FROM task_records WHERE
            (?1 IS NULL OR COALESCE(json_extract(record,'$.operation'),'recovery')=?1)
            AND (?2 IS NULL OR state=?2) AND (?3=0 OR state NOT IN ('success','running'))
            AND (?4 IS NULL OR started>=?4) AND (?5 IS NULL OR started<?5)
            AND (?6='' OR instr(lower(json_extract(record,'$.archivePath')),lower(?6))>0
                OR instr(lower(json_extract(record,'$.outputDirectory')),lower(?6))>0
                OR instr(lower(json_extract(record,'$.outputPath')),lower(?6))>0
                OR EXISTS(SELECT 1 FROM json_each(record,'$.sourcePaths') WHERE instr(lower(value),lower(?6))>0)
                OR EXISTS(SELECT 1 FROM json_each(record,'$.checkItems') WHERE instr(lower(json_extract(value,'$.path')),lower(?6))>0))
            ORDER BY started DESC, id DESC LIMIT ?7 OFFSET ?8").map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(
                params![
                    operation,
                    query.state,
                    query.failed_only,
                    query.from_ms,
                    query.before_ms,
                    query.text.trim(),
                    limit.min(10_001),
                    skip
                ],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
            )
            .map_err(|e| e.to_string())?;
        rows.map(|row| {
            let (json, state) = row.map_err(|e| e.to_string())?;
            let mut record: TaskRecord = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            record.state = state;
            if record.state == "interrupted" {
                if record.compression_verification == Some(super::CompressionVerification::Running)
                {
                    record.compression_verification =
                        Some(super::CompressionVerification::Interrupted);
                }
                for item in &mut record.check_items {
                    if matches!(item.state.as_str(), "waiting" | "checking") {
                        item.state = "interrupted".into();
                    }
                }
            }
            Ok(record)
        })
        .collect()
    }

    pub fn delete_many(&mut self, ids: &[String]) -> Result<usize, String> {
        if ids.len() > 1000 {
            return Err("每次最多删除 1000 条记录。".into());
        }
        let tx = self.0.transaction().map_err(|e| e.to_string())?;
        let mut deleted = 0;
        for id in ids {
            deleted += tx
                .execute(
                    "DELETE FROM task_records WHERE id=?1 AND state!='running'",
                    [id],
                )
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(deleted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn search_combines_literal_paths_dates_and_states_before_pagination() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = TaskRecordStore::open(&dir.path().join("records.db")).unwrap();
        for i in 0..205 {
            store
                .save(&TaskRecord {
                    task_id: format!("task-{i}"),
                    started_at_ms: i,
                    archive_path: "普通归档.zip".into(),
                    source_paths: vec![r"C:\[测试分组]\100%_资料.zip".into()],
                    state: if i == 204 { "running" } else { "failed" }.into(),
                    ..Default::default()
                })
                .unwrap();
        }
        let q = TaskRecordQuery {
            text: r"\100%_资料".into(),
            from_ms: Some(1),
            before_ms: Some(204),
            state: Some("failed".into()),
            ..Default::default()
        };
        assert_eq!(store.search(&q, 0, 100).unwrap().len(), 100);
        assert_eq!(store.search(&q, 200, 100).unwrap().len(), 3);
        assert_eq!(store.search(&q, 0, 10001).unwrap()[0].started_at_ms, 203);
        assert_eq!(
            store
                .delete_many(&["task-204".into(), "task-203".into(), "task-203".into()])
                .unwrap(),
            1
        );
        assert_eq!(store.search(&q, 200, 100).unwrap().len(), 2);
        assert!(
            store
                .search(
                    &TaskRecordQuery {
                        from_ms: Some(5),
                        before_ms: Some(5),
                        ..Default::default()
                    },
                    0,
                    100
                )
                .is_err()
        );
    }
}
