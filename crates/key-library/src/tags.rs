use crate::{Library, Result, err};
use rusqlite::params;
use serde_json::{Value, json};
impl Library {
    pub fn library_tags(&self, offset: usize, limit: usize) -> Result<Value> {
        let c = self.connection()?;
        let total: i64 = c
            .query_row(
                "SELECT count(DISTINCT name) FROM document_labels WHERE kind='tag'",
                [],
                |r| r.get(0),
            )
            .map_err(err)?;
        let tags=c.prepare("SELECT name,count(*) FROM document_labels WHERE kind='tag' GROUP BY name ORDER BY name COLLATE NOCASE LIMIT ?1 OFFSET ?2").map_err(err)?.query_map(params![limit.clamp(1,200) as i64,offset.min(i64::MAX as usize) as i64],|r|Ok(json!({"name":r.get::<_,String>(0)?,"count":r.get::<_,i64>(1)?}))).map_err(err)?.collect::<rusqlite::Result<Vec<_>>>().map_err(err)?;
        Ok(json!({"tags":tags,"total":total}))
    }
    pub fn library_retag(&self, from: &[String], to: Option<&str>) -> Result<Value> {
        if from.is_empty()
            || from.len() > 200
            || from.iter().any(|v| v.trim().is_empty() || v.len() > 128)
        {
            return Err("Select 1–200 valid tags".into());
        }
        let to = to
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        if to.as_ref().is_some_and(|v| v.len() > 128) {
            return Err("Tag exceeds 128 bytes".into());
        }
        let from = serde_json::to_string(from).map_err(err)?;
        self.writer.run(true,move|c|{let tx=c.transaction().map_err(err)?;
   tx.execute_batch("CREATE TEMP TABLE IF NOT EXISTS key_retag_docs(hash TEXT PRIMARY KEY);DELETE FROM key_retag_docs;").map_err(err)?;
   tx.execute("INSERT INTO key_retag_docs SELECT DISTINCT document_hash FROM document_labels WHERE kind='tag' AND name IN (SELECT value FROM json_each(?1))",[&from]).map_err(err)?;
   let affected:i64=tx.query_row("SELECT count(*) FROM key_retag_docs",[],|r|r.get(0)).map_err(err)?;
   tx.execute("DELETE FROM document_labels WHERE kind='tag' AND name IN (SELECT value FROM json_each(?1))",[&from]).map_err(err)?;
   if let Some(to)=&to{tx.execute("INSERT OR IGNORE INTO document_labels SELECT hash,'tag',?1 FROM key_retag_docs",[to]).map_err(err)?;}
   tx.execute("DELETE FROM key_retag_docs",[]).map_err(err)?;tx.commit().map_err(err)?;Ok(json!({"affected":affected}))
  })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn retag_merges_without_deleting_documents_or_collections() {
        let t = tempfile::tempdir().unwrap();
        let l = Library::open(t.path()).unwrap();
        let h = l.store_source(b"pdf", "Paper", 1).unwrap();
        l.set_labels(&h, &["brain".into(), "brains".into()], &["Project".into()])
            .unwrap();
        l.library_retag(&["brain".into(), "brains".into()], Some("Brain"))
            .unwrap();
        let d = l.metadata_details(&h).unwrap();
        assert_eq!(d.tags, vec!["Brain"]);
        assert_eq!(d.collections, vec!["Project"]);
        l.library_retag(&["Brain".into()], None).unwrap();
        assert!(l.metadata_details(&h).unwrap().tags.is_empty());
        assert!(l.source_info(&h).is_ok());
    }
}
