use crate::{Library, Result, err};
impl Library {
    pub fn delete_workspace_attribute(&self, name: &str, delete_values: bool) -> Result<usize> {
        if name.is_empty() || name.len() > 128 {
            return Err("Invalid attribute name".into());
        }
        let name = name.to_owned();
        self.writer.run(true, move |c| {
            let tx = c.transaction().map_err(err)?;
            tx.execute("DELETE FROM workspace_attributes WHERE name=?1", [&name])
                .map_err(err)?;
            tx.execute(
                "DELETE FROM workspace_agent_properties WHERE name=?1",
                [&name],
            )
            .map_err(err)?;
            let affected = if delete_values {
                // Existing triggers remove each value from extra_metadata_fts atomically.
                let count = tx
                    .execute("DELETE FROM document_properties WHERE name=?1", [&name])
                    .map_err(err)?;
                tx.execute("DELETE FROM property_definitions WHERE name=?1", [&name])
                    .map_err(err)?;
                tx.execute(
                    "DELETE FROM workspace_property_provenance WHERE name=?1",
                    [&name],
                )
                .map_err(err)?;
                count
            } else {
                0
            };
            tx.commit().map_err(err)?;
            Ok(affected)
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delete_attribute_clears_values_and_search_but_preserves_other_properties() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        let hash = crate::content_hash(b"paper");
        lib.register(&hash, "Paper", 1).unwrap();
        lib.set_property(&hash, "Topic", &serde_json::json!("uniqueneedle"))
            .unwrap();
        lib.set_property(&hash, "Rating", &serde_json::json!(4))
            .unwrap();
        assert_eq!(lib.delete_workspace_attribute("Topic", true).unwrap(), 1);
        let c = lib.connection().unwrap();
        assert_eq!(c.query_row("SELECT count(*) FROM extra_metadata_fts WHERE extra_metadata_fts MATCH 'uniqueneedle'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM document_properties WHERE name='Rating'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            1
        );
    }
}

/// Rewrite only property tokens outside string literals; no expression evaluation.
fn renamed_formula(source: &str, old: &str, new: &str) -> Result<String> {
    let chars: Vec<char> = source.chars().collect();
    let mut result = String::new();
    let mut i = 0;
    while i < chars.len() {
        let ch = chars[i];
        if ch == '\'' || ch == '"' {
            let quote = ch;
            result.push(ch);
            i += 1;
            let mut closed = false;
            while i < chars.len() {
                let ch = chars[i];
                result.push(ch);
                i += 1;
                if ch == '\\' && i < chars.len() {
                    result.push(chars[i]);
                    i += 1;
                } else if ch == quote {
                    closed = true;
                    break;
                }
            }
            if !closed {
                return Err(
                    "Fix unterminated formula strings before renaming this property".into(),
                );
            }
        } else if ch == '[' || ch == '{' {
            let end = if ch == '[' { ']' } else { '}' };
            let start = i + 1;
            i += 1;
            while i < chars.len() && chars[i] != end {
                i += 1;
            }
            if i == chars.len() {
                return Err(
                    "Fix incomplete formula references before renaming this property".into(),
                );
            }
            let key: String = chars[start..i].iter().collect();
            result.push(ch);
            if key.to_lowercase() == old.to_lowercase() {
                let metadata_names = ["title", "authors", "year", "pages", "pagecount"];
                if metadata_names.contains(&old.to_lowercase().as_str())
                    || metadata_names.contains(&new.to_lowercase().as_str())
                {
                    return Err("Formula references overlap built-in document metadata; choose a distinct custom property name or update the formula first".into());
                }
                result.push_str(new);
            } else {
                result.push_str(&key);
            }
            result.push(end);
            i += 1;
        } else {
            result.push(ch);
            i += 1;
        }
    }
    if result.len() > 16384 {
        return Err("Renamed formula exceeds the storage limit".into());
    }
    Ok(result)
}

impl Library {
    /// A workspace-wide rename is one transaction, including metadata FTS triggers.
    pub fn rename_workspace_attribute(
        &self,
        name: &str,
        new_name: &str,
    ) -> Result<serde_json::Value> {
        let name = name.trim().to_owned();
        let new_name = new_name.trim().to_owned();
        let reserved = [
            "view",
            "path",
            "editor",
            "sourceType",
            "contentMode",
            "contentHash",
            "pdfHash",
            "__proto__",
            "constructor",
            "prototype",
        ];
        if name.is_empty()
            || new_name.is_empty()
            || name.len() > 128
            || new_name.len() > 128
            || reserved.contains(&name.as_str())
            || reserved.contains(&new_name.as_str())
            || new_name
                .chars()
                .any(|c| c.is_control() || matches!(c, '[' | ']' | '{' | '}'))
        {
            return Err("Choose a non-reserved property name of 1–128 bytes without control characters or brackets".into());
        }
        self.writer.run(true,move|c| {
            let tx = c.transaction().map_err(err)?;
            let mut found = false;
            // Stream unique names, including values without a definition. Reject case aliases
            // because the formula interpreter resolves exact names before case-insensitive names.
            {
                let mut statement = tx.prepare("SELECT name FROM workspace_attributes UNION SELECT name FROM document_properties UNION SELECT name FROM property_definitions UNION SELECT name FROM workspace_agent_properties UNION SELECT name FROM workspace_property_provenance UNION SELECT j.key FROM workspace_records r,json_each(r.properties) j").map_err(err)?;
                let rows = statement.query_map([], |r| r.get::<_,String>(0)).map_err(err)?;
                for candidate in rows {
                    let candidate = candidate.map_err(err)?;
                    if candidate == name { found = true; continue; }
                    if candidate.to_lowercase() == new_name.to_lowercase() { return Err("A property with that name already exists; rename does not merge values".into()); }
                    if candidate.to_lowercase() == name.to_lowercase() { return Err("Resolve properties differing only in letter case before renaming, to preserve formula references".into()); }
                }
            }
            if !found { return Err("Property not found".into()); }
            if name == new_name { return Ok(serde_json::json!({"name":name,"newName":new_name,"recordsUpdated":0,"valuesUpdated":0})); }
            let now = crate::now_ms();
            // Rewrite schema formulas first. Any unsupported expression or collision aborts everything.
            let mut cursor = String::new();
            loop {
                let batch: Vec<(String,String)> = { let mut statement = tx.prepare("SELECT name,config FROM workspace_attributes WHERE name>?1 ORDER BY name LIMIT 128").map_err(err)?;
                    let rows = statement.query_map([&cursor],|r|Ok((r.get(0)?,r.get(1)?))).map_err(err)?; rows.collect::<rusqlite::Result<_>>().map_err(err)? };
                if batch.is_empty() { break; }
                for (key, encoded) in batch {
                    cursor = key.clone();
                    let mut config: serde_json::Value = serde_json::from_str(&encoded).map_err(err)?;
                    if let Some(formula) = config.get("formula").and_then(serde_json::Value::as_str) {
                        let rewritten = renamed_formula(formula, &name, &new_name)?;
                        if rewritten != formula { config["formula"] = serde_json::Value::String(rewritten); let encoded = serde_json::to_string(&config).map_err(err)?;
                            if encoded.len()>16384 { return Err("Updated definition exceeds 16 KiB".into()); }
                            tx.execute("UPDATE workspace_attributes SET config=?1,updated_at=?2 WHERE name=?3",rusqlite::params![encoded,now,key]).map_err(err)?;
                        }
                    }
                }
            }
            for table in ["workspace_attributes","workspace_agent_properties","property_definitions","workspace_property_provenance"] {
                tx.execute(&format!("UPDATE {table} SET name=?1 WHERE name=?2"),rusqlite::params![new_name,name]).map_err(err)?;
            }
            let values = tx.execute("UPDATE document_properties SET name=?1 WHERE name=?2",rusqlite::params![new_name,name]).map_err(err)?;
            let mut records = 0;
            let mut cursor = String::new();
            loop {
                let batch: Vec<(String,String)> = { let mut statement = tx.prepare("SELECT id,properties FROM workspace_records r WHERE id>?1 AND (EXISTS(SELECT 1 FROM json_each(r.properties) WHERE key=?2) OR json_extract(r.properties,'$.view.property')=?2) ORDER BY id LIMIT 64").map_err(err)?;
                    let rows = statement.query_map(rusqlite::params![cursor,name],|r|Ok((r.get(0)?,r.get(1)?))).map_err(err)?; rows.collect::<rusqlite::Result<_>>().map_err(err)? };
                if batch.is_empty() { break; }
                for (id, encoded) in batch { cursor=id.clone(); let mut properties: serde_json::Value=serde_json::from_str(&encoded).map_err(err)?;
                    let object=properties.as_object_mut().ok_or("Record properties must be an object")?;
                    if let Some(value)=object.remove(&name) { object.insert(new_name.clone(),value); }
                    if properties.pointer("/view/property").and_then(serde_json::Value::as_str)==Some(name.as_str()) { properties["view"]["property"]=serde_json::json!(new_name); }
                    let encoded=serde_json::to_string(&properties).map_err(err)?;
                    if encoded.len()>65536 { return Err("Renamed record properties exceed 64 KiB".into()); }
                    records += tx.execute("UPDATE workspace_records SET properties=?1,revision=revision+1,updated_at=?2 WHERE id=?3",rusqlite::params![encoded,now,id]).map_err(err)?;
                }
            }
            let attribute: Option<String> = rusqlite::OptionalExtension::optional(tx.query_row("SELECT config FROM workspace_attributes WHERE name=?1",[&new_name],|r|r.get(0))).map_err(err)?;
            let attribute = attribute.map(|v|serde_json::from_str::<serde_json::Value>(&v)).transpose().map_err(err)?;
            tx.commit().map_err(err)?;
            Ok(serde_json::json!({"name":name,"newName":new_name,"recordsUpdated":records,"valuesUpdated":values,"attribute":attribute}))
        })
    }
}

#[cfg(test)]
mod rename_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn rename_is_atomic_and_preserves_records_search_formulas_and_recipes() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        let hash = crate::content_hash(b"rename-paper");
        lib.register(&hash, "Paper", 1).unwrap();
        lib.set_property(&hash, "Topic", &json!("uniquerenamevalue"))
            .unwrap();
        lib.save_workspace_attribute("Topic",&json!({"type":"text","agentic":{"inputs":["title"],"instruction":"Classify","enabled":true}})).unwrap();
        lib.save_workspace_attribute(
            "Computed",
            &json!({"type":"formula","formula":"concat([Topic], '{Topic}', {topic})"}),
        )
        .unwrap();
        lib.save_agent_property("Topic", &json!({"prompt":"Classify","inputs":["title"]}))
            .unwrap();
        let record = lib
            .save_record(
                None,
                "note",
                "Research note",
                &json!({"Topic":null,"Other":4}),
                "draft body",
                None,
            )
            .unwrap();
        let view = lib
            .save_record(
                None,
                "database",
                "Filtered view",
                &json!({"view":{"property":"Topic","value":"x"}}),
                "",
                None,
            )
            .unwrap();
        let result = lib.rename_workspace_attribute("Topic", "Subject").unwrap();
        assert_eq!(result["valuesUpdated"], 1);
        assert_eq!(result["recordsUpdated"], 2);
        assert_eq!(result["attribute"]["agentic"]["inputs"], json!(["title"]));
        let saved = lib.workspace_record(&record.id).unwrap().unwrap();
        assert_eq!(saved.revision, record.revision + 1);
        assert_eq!(saved.body, "draft body");
        assert_eq!(saved.properties, json!({"Subject":null,"Other":4}));
        assert_eq!(
            lib.workspace_record(&view.id).unwrap().unwrap().properties["view"]["property"],
            "Subject"
        );
        assert!(
            lib.save_record(
                Some(&record.id),
                "note",
                "Research note",
                &json!({}),
                "overwrite",
                Some(record.revision)
            )
            .is_err()
        );
        assert!(lib.agent_property("Topic").unwrap().is_none());
        assert!(lib.agent_property("Subject").unwrap().is_some());
        let attributes = lib.workspace_attributes().unwrap();
        assert_eq!(
            attributes.iter().find(|a| a["name"] == "Computed").unwrap()["formula"],
            "concat([Subject], '{Topic}', {Subject})"
        );
        let c = lib.connection().unwrap();
        assert_eq!(c.query_row("SELECT count(*) FROM extra_metadata_fts WHERE key='Subject' AND extra_metadata_fts MATCH 'uniquerenamevalue'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        assert_eq!(
            c.query_row(
                "SELECT count(*) FROM extra_metadata_fts WHERE key='Topic'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            0
        );
        assert_eq!(c.query_row("SELECT count(*) FROM workspace_record_fts WHERE id=?1 AND workspace_record_fts MATCH 'Subject'",[&record.id],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
    #[test]
    fn rejects_collisions_and_bad_formulas_without_partial_changes() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        lib.save_workspace_attribute("Old", &json!({"type":"text"}))
            .unwrap();
        lib.save_record(None, "note", "Has collision", &json!({"New":1}), "", None)
            .unwrap();
        assert!(lib.rename_workspace_attribute("Old", "New").is_err());
        lib.save_workspace_attribute("Bad", &json!({"type":"formula","formula":"[Old"}))
            .unwrap();
        assert!(lib.rename_workspace_attribute("Old", "Fresh").is_err());
        assert!(
            lib.workspace_attributes()
                .unwrap()
                .iter()
                .any(|a| a["name"] == "Old")
        );
        assert!(
            !lib.workspace_attributes()
                .unwrap()
                .iter()
                .any(|a| a["name"] == "Fresh")
        );
        assert!(renamed_formula("[Old]", "Old", "Title").is_err());
        assert_eq!(
            renamed_formula("concat('[Old]', [Old])", "Old", "New").unwrap(),
            "concat('[Old]', [New])"
        );
    }
    #[test]
    fn rejects_ambiguous_case_aliases_and_preserves_unicode_names() {
        let temp = tempfile::tempdir().unwrap();
        let lib = Library::open(temp.path()).unwrap();
        lib.save_workspace_attribute("Topic", &json!({"type":"text"}))
            .unwrap();
        lib.save_record(None, "note", "Case alias", &json!({"topic":1}), "", None)
            .unwrap();
        assert!(lib.rename_workspace_attribute("Topic", "Subject").is_err());
        lib.save_workspace_attribute("研究", &json!({"type":"text"}))
            .unwrap();
        assert!(lib.rename_workspace_attribute("研究", "研究领域").is_ok());
    }
}
