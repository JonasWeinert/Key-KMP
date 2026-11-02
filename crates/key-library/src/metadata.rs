use crate::{Library, Result, err, now_ms};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataDetails {
    pub tags: Vec<String>,
    pub collections: Vec<String>,
    pub properties: BTreeMap<String, serde_json::Value>,
}
impl Library {
    pub fn metadata_details(&self, hash: &str) -> Result<MetadataDetails> {
        let conn = self.connection()?;
        let mut details = MetadataDetails::default();
        let mut q = conn
            .prepare("SELECT kind,name FROM document_labels WHERE document_hash=?1 ORDER BY name")
            .map_err(err)?;
        for row in q
            .query_map([hash], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(err)?
        {
            let (kind, name) = row.map_err(err)?;
            if kind == "tag" {
                details.tags.push(name)
            } else {
                details.collections.push(name)
            }
        }
        let mut q = conn
            .prepare(
                "SELECT name,value FROM document_properties WHERE document_hash=?1 ORDER BY name",
            )
            .map_err(err)?;
        for row in q
            .query_map([hash], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(err)?
        {
            let (name, value) = row.map_err(err)?;
            details
                .properties
                .insert(name, serde_json::from_str(&value).map_err(err)?);
        }
        Ok(details)
    }
    pub fn set_labels(&self, hash: &str, tags: &[String], collections: &[String]) -> Result<()> {
        if tags.len() + collections.len() > 256 {
            return Err("A document supports at most 256 labels".into());
        }
        let hash = hash.to_owned();
        let tags = tags.to_vec();
        let collections = collections.to_vec();
        self.writer.run(true,move |conn| {
        let tx = conn.transaction().map_err(err)?;
        tx.execute("DELETE FROM document_labels WHERE document_hash=?1", [&hash])
            .map_err(err)?;
        for (kind, names) in [("tag", &tags), ("collection", &collections)] {
            for name in names {
                let name = name.trim();
                if name.is_empty() || name.len() > 128 {
                    return Err("Labels must contain 1 to 128 bytes".into());
                }
                tx.execute("INSERT OR IGNORE INTO document_labels(document_hash,kind,name) VALUES(?1,?2,?3)",params![hash,kind,name]).map_err(err)?;
            }
        }
        tx.execute(
            "UPDATE documents SET updated_at=?2 WHERE hash=?1",
            params![hash, now_ms()],
        )
        .map_err(err)?;
        tx.commit().map_err(err)
        })
    }
    /// Queryable relations retain their complete payload as well as indexed fields.
    pub fn store_relations<T: Serialize>(&self, hash: &str, kind: &str, rows: &[T]) -> Result<()> {
        let hash = hash.to_owned();
        let kind = kind.to_owned();
        let rows = rows
            .iter()
            .map(serde_json::to_string)
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(err)?;
        self.writer.run(false,move |conn| {
        let tx = conn.transaction().map_err(err)?;
        tx.execute(
            "DELETE FROM document_relations WHERE document_hash=?1 AND kind=?2",
            params![hash, kind],
        )
        .map_err(err)?;
        {
            let mut insert=tx.prepare("INSERT INTO document_relations(document_hash,kind,ordinal,payload) VALUES(?1,?2,?3,?4)").map_err(err)?;
            for (ordinal, row) in rows.iter().enumerate() {
                insert
                    .execute(params![
                        hash,
                        kind,
                        ordinal as i64,
                        row
                    ])
                    .map_err(err)?;
            }
        }
        tx.commit().map_err(err)
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn labels_authors_observations_and_relations_survive_reopen() {
        let tmp = tempfile::tempdir().unwrap();
        let lib = Library::open(tmp.path()).unwrap();
        let hash = crate::content_hash(b"paper");
        lib.register(&hash, "Paper", 1).unwrap();
        lib.update_metadata(&hash, "Title", Some(2025), &["Alice".into()])
            .unwrap();
        lib.set_labels(&hash, &["Reviewed".into()], &["Thesis".into()])
            .unwrap();
        lib.store_relations(
            &hash,
            "reference",
            &[serde_json::json!({"page":2,"text":"Reference"})],
        )
        .unwrap();
        let lib = Library::open(tmp.path()).unwrap();
        assert_eq!(
            lib.documents(&crate::Filter {
                tag: Some("reviewed".into()),
                collection: Some("Thesis".into()),
                author: Some("alice".into()),
                ..Default::default()
            })
            .unwrap()
            .len(),
            1
        );
        assert_eq!(lib.metadata_details(&hash).unwrap().tags, ["Reviewed"]);
        lib.set_property(&hash, "topic", &serde_json::json!("quantum physics"))
            .unwrap();
        assert_eq!(
            lib.documents(&crate::Filter {
                metadata_text: Some("quantum physics".into()),
                ..Default::default()
            })
            .unwrap()
            .len(),
            1
        );
        lib.set_property(&hash, "topic", &serde_json::json!("biology"))
            .unwrap();
        assert!(
            lib.documents(&crate::Filter {
                metadata_text: Some("quantum physics".into()),
                ..Default::default()
            })
            .unwrap()
            .is_empty()
        );
        let conn = lib.connection().unwrap();
        assert_eq!(
            conn.query_row("SELECT count(*) FROM metadata_observations", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            5
        );
        assert_eq!(
            conn.query_row(
                "SELECT json_extract(payload,'$.page') FROM document_relations",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
            2
        );
        assert!(lib.set_labels(&hash, &["".into()], &[]).is_err());
        assert_eq!(lib.metadata_details(&hash).unwrap().tags, ["Reviewed"]);
    }
}
