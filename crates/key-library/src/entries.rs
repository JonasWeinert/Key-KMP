//! Metadata-only sources and persisted automation instructions. No synthetic extraction.
use crate::{Library, Result, WorkspaceRecord, err, now_ms};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
impl Library {
    pub fn save_source_entry(
        &self,
        id: Option<&str>,
        source_type: &str,
        title: &str,
        url: Option<&str>,
        content: &str,
        properties: &Value,
        revision: Option<i64>,
        project_id: Option<&str>,
    ) -> Result<WorkspaceRecord> {
        if !["web", "reference", "note", "image", "video", "audio", "dataset"].contains(&source_type) {
            return Err("Unsupported source type".into());
        }
        if content.len() > 256 * 1024 {
            return Err("Source content is limited to 256 KiB".into());
        }
        let url = url.unwrap_or("").trim();
        if !url.is_empty()
            && (!(url.starts_with("https://") || url.starts_with("http://"))
                || url.len() > 4096
                || url.chars().any(char::is_whitespace))
        {
            return Err("Enter a valid http or https URL".into());
        }
        let mut properties = properties
            .as_object()
            .cloned()
            .ok_or("Properties must be an object")?;
        properties.insert("sourceType".into(), json!(source_type));
        properties.insert("url".into(), json!(url));
        properties.insert(
            "contentMode".into(),
            json!(if content.is_empty() {
                "metadata"
            } else {
                "user-provided"
            }),
        );
        let kind = if let Some(id) = id {
            let old = self.source_entry(id)?.ok_or("Source entry not found")?;
            old.kind
        } else {
            "document".into()
        };
        let r = self.save_record(
            id,
            &kind,
            title,
            &Value::Object(properties),
            content,
            revision,
        )?;
        if let Some(project) = project_id {
            self.set_project_membership(project, &r.id, true)?
        }
        Ok(r)
    }
    pub fn source_entry(&self, id: &str) -> Result<Option<WorkspaceRecord>> {
        self.connection()?.query_row("SELECT id,kind,document_hash,title,properties,body,revision,updated_at FROM workspace_records WHERE id=?1 AND kind!='source' AND json_extract(properties,'$.sourceType') IN ('web','reference','note','image','video','audio','dataset')",[id],crate::workspace::record).optional().map_err(err)
    }
    pub fn source_entries(
        &self,
        project: Option<&str>,
        query: Option<&str>,
        limit: usize,
        offset: usize,
    ) -> Result<Value> {
        let query = query
            .filter(|q| !q.trim().is_empty())
            .map(|q| format!("\"{}\"", q.replace('"', "\"\"")));
        let c = self.connection()?;
        let condition = " FROM workspace_records r WHERE kind!='source' AND json_extract(properties,'$.sourceType') IN ('web','reference','note','image','video','audio','dataset') AND (?1 IS NULL OR EXISTS(SELECT 1 FROM workspace_project_records p WHERE p.record_id=r.id AND p.project_id=?1)) AND (?2 IS NULL OR r.id IN (SELECT id FROM workspace_record_fts WHERE workspace_record_fts MATCH ?2))";
        let total = c
            .query_row(
                &format!("SELECT count(*){condition}"),
                params![project, query],
                |r| r.get::<_, i64>(0),
            )
            .map_err(err)? as usize;
        let mut q=c.prepare(&format!("SELECT id,kind,document_hash,title,properties,'' as body,revision,updated_at{condition} ORDER BY updated_at DESC,id LIMIT ?3 OFFSET ?4")).map_err(err)?;
        let entries = q
            .query_map(
                params![
                    project,
                    query,
                    limit.clamp(1, 100) as i64,
                    offset.min(i64::MAX as usize) as i64
                ],
                crate::workspace::record,
            )
            .map_err(err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err)?;
        let next = offset.saturating_add(entries.len());
        Ok(
            json!({"entries":entries,"total":total,"nextOffset":if next<total{Some(next)}else{None}}),
        )
    }
    pub fn workspace_attributes(&self) -> Result<Vec<Value>> {
        let c = self.connection()?;
        let mut q = c
            .prepare("SELECT name,config FROM workspace_attributes ORDER BY name")
            .map_err(err)?;
        q.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(err)?
            .map(|r| {
                let (name, config) = r.map_err(err)?;
                let mut v: Value = serde_json::from_str(&config).map_err(err)?;
                v["name"] = json!(name);
                Ok(v)
            })
            .collect()
    }
    pub fn save_workspace_attribute(&self, name: &str, config: &Value) -> Result<()> {
        if name.trim().is_empty() || name.len() > 128 || !config.is_object() {
            return Err("Invalid attribute".into());
        }
        let name = name.trim().to_owned();
        let config = serde_json::to_string(config).map_err(err)?;
        if config.len() > 16384 {
            return Err("Attribute exceeds 16 KiB".into());
        }
        self.writer.run(true,move|c|{c.execute("INSERT INTO workspace_attributes VALUES(?1,?2,?3) ON CONFLICT(name) DO UPDATE SET config=excluded.config,updated_at=excluded.updated_at",params![name,config,now_ms()]).map_err(err)?;Ok(())})
    }
    pub fn agent_context(&self, hash: &str, inputs: &[String]) -> Result<Value> {
        if inputs.len() > 16 {
            return Err("Too many inputs".into());
        }
        let c = self.connection()?;
        let (title,authors,year,pages):(String,String,Option<i64>,i64)=c.query_row("SELECT title,authors,year,page_count FROM documents WHERE hash=?1 AND deleted_at IS NULL",[hash],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).map_err(err)?;
        let mut v = json!({});
        for input in inputs {
            match input.as_str() {
                "title" => v["title"] = json!(title),
                "authors" => v["authors"] = serde_json::from_str(&authors).map_err(err)?,
                "year" => v["year"] = json!(year),
                "pageCount" => v["pageCount"] = json!(pages),
                "pdfText" => {
                    let mut q=c.prepare("SELECT substr(text,1,8192) FROM block_data WHERE document_id=(SELECT id FROM content_keys WHERE digest=unhex(?1)) ORDER BY id LIMIT 4").map_err(err)?;
                    let blocks = q
                        .query_map([hash], |r| r.get::<_, String>(0))
                        .map_err(err)?
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .map_err(err)?;
                    let mut text = blocks.join("\n");
                    if text.len() > 32768 {
                        let mut n = 32768;
                        while !text.is_char_boundary(n) {
                            n -= 1
                        }
                        text.truncate(n)
                    }
                    v["pdfText"] = json!(text);
                }
                _ => return Err("Unknown input".into()),
            }
        }
        Ok(v)
    }
    pub fn apply_property_proposal(
        &self,
        hash: &str,
        name: &str,
        value: &Value,
        expected: &Value,
        provenance: &Value,
    ) -> Result<()> {
        if name.trim().is_empty()
            || name.len() > 128
            || !(value.is_string() || value.is_number() || value.is_boolean())
            || value.to_string().len() > 8192
        {
            return Err("Proposal must be a bounded scalar".into());
        }
        let hash = hash.to_owned();
        let name = name.to_owned();
        let value = value.to_string();
        let expected = expected.to_string();
        let provenance = provenance.to_string();
        if provenance.len() > 16384 {
            return Err("Provenance exceeds budget".into());
        }
        self.writer.run(true,move|c|{let tx=c.transaction().map_err(err)?;let current:Option<String>=tx.query_row("SELECT value FROM document_properties WHERE document_hash=?1 AND name=?2",params![hash,name],|r|r.get(0)).optional().map_err(err)?;
   if current.as_deref().unwrap_or("null")!=expected{return Err("Property changed; generate a new proposal".into())}
   tx.execute("INSERT INTO document_properties VALUES(?1,?2,?3) ON CONFLICT(document_hash,name) DO UPDATE SET value=excluded.value",params![hash,name,value]).map_err(err)?;
   tx.execute("INSERT INTO workspace_property_provenance VALUES(?1,?2,?3) ON CONFLICT(document_hash,name) DO UPDATE SET payload=excluded.payload",params![hash,name,provenance]).map_err(err)?;tx.commit().map_err(err)})
    }
    pub fn agent_property(&self, name: &str) -> Result<Option<Value>> {
        let config: Option<String> = self
            .connection()?
            .query_row(
                "SELECT config FROM workspace_agent_properties WHERE name=?1",
                [name],
                |r| r.get(0),
            )
            .optional()
            .map_err(err)?;
        config
            .map(|s| serde_json::from_str(&s).map_err(err))
            .transpose()
    }
    pub fn save_agent_property(&self, name: &str, config: &Value) -> Result<()> {
        let name = name.trim();
        if name.is_empty() || name.len() > 128 {
            return Err("Property name must contain 1–128 bytes".into());
        }
        let prompt = config
            .get("prompt")
            .and_then(Value::as_str)
            .ok_or("Prompt is required")?;
        let inputs = config
            .get("inputs")
            .and_then(Value::as_array)
            .ok_or("Select inputs")?;
        if prompt.len() > 8192
            || inputs.is_empty()
            || inputs.len() > 16
            || inputs.iter().any(|v| {
                !matches!(
                    v.as_str(),
                    Some("title" | "authors" | "year" | "pageCount" | "pdfText")
                )
            })
        {
            return Err("Invalid prompt or inputs".into());
        }
        let name = name.to_owned();
        let config = serde_json::to_string(config).map_err(err)?;
        if config.len() > 16384 {
            return Err("Configuration exceeds 16 KiB".into());
        }
        self.writer.run(true,move|c|{c.execute("INSERT INTO workspace_agent_properties VALUES(?1,?2,?3) ON CONFLICT(name) DO UPDATE SET config=excluded.config,updated_at=excluded.updated_at",params![name,config,now_ms()]).map_err(err)?;Ok(())})
    }
    /// Explicit deterministic copy, not AI inference. Existing values are preserved.
    pub fn fill_known_property(&self, hashes: &[String], name: &str, input: &str) -> Result<Value> {
        if hashes.len() > 100 || hashes.is_empty() {
            return Err("Select 1–100 PDFs".into());
        }
        if name.trim().is_empty() || name.len() > 128 {
            return Err("Invalid property name".into());
        }
        if !["title", "authors", "year", "pageCount"].contains(&input) {
            return Err("Only known document metadata can be copied".into());
        }
        let hashes = hashes.to_vec();
        let name = name.trim().to_owned();
        let input = input.to_owned();
        self.writer.run(true,move|c|{let tx=c.transaction().map_err(err)?;let mut filled=0;let mut skipped=0;
   for hash in hashes{let row:Option<(String,String,Option<i64>,i64)>=tx.query_row("SELECT title,authors,year,page_count FROM documents WHERE hash=?1 AND deleted_at IS NULL",[&hash],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional().map_err(err)?;
    let Some((title,authors,year,pages))=row else{skipped+=1;continue};
    let value=match input.as_str(){"title"=>json!(title),"authors"=>json!(serde_json::from_str::<Vec<String>>(&authors).unwrap_or_default().join("; ")),"year"=>json!(year),_=>if pages>0{json!(pages)}else{Value::Null}};
    if value.is_null()||value.as_str()==Some(""){skipped+=1;continue}
    let changed=tx.execute("INSERT INTO document_properties(document_hash,name,value) VALUES(?1,?2,?3) ON CONFLICT(document_hash,name) DO UPDATE SET value=excluded.value WHERE document_properties.value IN ('null','\"\"')",params![hash,name,value.to_string()]).map_err(err)?;filled+=changed;if changed==0{skipped+=1}
   }tx.commit().map_err(err)?;Ok(json!({"filled":filled,"skipped":skipped,"method":"Known metadata copied; no AI inference"}))})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn entries_persist_filter_and_index_supplied_content() {
        let t = tempfile::tempdir().unwrap();
        let l = Library::open(t.path()).unwrap();
        let e = l
            .save_source_entry(
                None,
                "video",
                "Talk",
                Some("https://example.com/video"),
                "supplied transcript synapse",
                &json!({}),
                None,
                None,
            )
            .unwrap();
        assert_eq!(
            l.source_entries(None, Some("synapse"), 10, 0).unwrap()["total"],
            1
        );
        assert_eq!(
            l.source_entry(&e.id).unwrap().unwrap().body,
            "supplied transcript synapse"
        );
        assert!(
            l.save_source_entry(
                None,
                "web",
                "Unsafe",
                Some("javascript:alert(1)"),
                "",
                &json!({}),
                None,
                None
            )
            .is_err()
        );
    }
    #[test]
    fn deterministic_fill_preserves_edits_and_configuration() {
        let t = tempfile::tempdir().unwrap();
        let l = Library::open(t.path()).unwrap();
        let h = l.store_source(b"pdf", "Known", 2).unwrap();
        l.save_agent_property(
            "Extracted title",
            &json!({"prompt":"Extract title","inputs":["title"]}),
        )
        .unwrap();
        assert!(l.agent_property("Extracted title").unwrap().is_some());
        assert_eq!(
            l.fill_known_property(&[h.clone()], "Extracted title", "title")
                .unwrap()["filled"],
            1
        );
        l.set_property(&h, "Extracted title", &json!("Curated"))
            .unwrap();
        assert_eq!(
            l.fill_known_property(&[h.clone()], "Extracted title", "title")
                .unwrap()["skipped"],
            1
        );
        assert_eq!(
            l.metadata_details(&h).unwrap().properties["Extracted title"],
            "Curated"
        );
    }
    #[test]
    fn proposal_confirmation_is_atomic_and_records_provenance() {
        let t = tempfile::tempdir().unwrap();
        let l = Library::open(t.path()).unwrap();
        let h = l.store_source(b"proposal", "Paper", 1).unwrap();
        l.apply_property_proposal(
            &h,
            "Topic",
            &json!("Neuroscience"),
            &Value::Null,
            &json!({"model":"test","contentHash":h}),
        )
        .unwrap();
        assert!(
            l.apply_property_proposal(&h, "Topic", &json!("Wrong"), &Value::Null, &json!({}))
                .is_err()
        );
        assert_eq!(
            l.metadata_details(&h).unwrap().properties["Topic"],
            "Neuroscience"
        );
        let count: i64 = l
            .connection()
            .unwrap()
            .query_row(
                "SELECT count(*) FROM workspace_property_provenance",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }
}
