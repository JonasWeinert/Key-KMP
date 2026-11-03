// Typed property definitions, agent-fill recipes and AI provenance. A select property's
// values are rows of their own (`property_options`, migration 010) linked to the sources
// that hold them, so renaming a value renames it on every source at once; the sources'
// properties JSON keeps the text for display.
use crate::{Result, Store, e, new_id, now_ms};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json, json};

/// One value of a select property and how many sources hold it.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyOption {
    pub id: String,
    pub value: String,
    pub position: i64,
    pub count: i64,
}

fn json_path(name: &str) -> String {
    format!("$.\"{}\"", name.replace('"', "\\\""))
}

/// Brings a select property's option rows in line with its definition and links every
/// source holding one of them.
fn sync_options(db: &Connection, name: &str) -> Result<()> {
    let config: Option<String> = db.query_row("SELECT config FROM property_definitions WHERE name = ?", [name], |r| r.get(0)).optional().map_err(e)?;
    let config: Json = config.and_then(|c| serde_json::from_str(&c).ok()).unwrap_or_default();
    if config.get("type").and_then(Json::as_str) != Some("select") {
        db.execute("DELETE FROM property_options WHERE property = ?", [name]).map_err(e)?;
        return Ok(());
    }
    let options: Vec<String> = config.get("options").and_then(Json::as_array).into_iter().flatten().filter_map(Json::as_str).map(String::from).collect();
    db.execute(
        "DELETE FROM property_options WHERE property = ?1 AND value NOT IN (SELECT value FROM json_each(?2))",
        params![name, serde_json::to_string(&options).map_err(e)?],
    )
    .map_err(e)?;
    for (position, value) in options.iter().enumerate() {
        db.execute(
            "INSERT INTO property_options(id, property, value, position) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(property, value) DO UPDATE SET position = excluded.position",
            params![new_id(), name, value, position as i64],
        )
        .map_err(e)?;
    }
    db.execute(
        "INSERT OR IGNORE INTO source_property_options(source_id, option_id)
         SELECT s.id, o.id FROM sources s JOIN property_options o ON o.property = ?1 AND o.value = CAST(json_extract(s.properties, ?2) AS TEXT)",
        params![name, json_path(name)],
    )
    .map_err(e)?;
    Ok(())
}

/// Links a source to the select values its properties hold (after any properties write).
pub(crate) fn sync_choices(db: &Connection, source_id: &str) -> Result<()> {
    db.execute("DELETE FROM source_property_options WHERE source_id = ?", [source_id]).map_err(e)?;
    db.execute(
        "INSERT OR IGNORE INTO source_property_options(source_id, option_id)
         SELECT s.id, o.id FROM sources s, json_each(s.properties) p JOIN property_options o ON o.property = p.key AND o.value = CAST(p.value AS TEXT)
         WHERE s.id = ?",
        [source_id],
    )
    .map(|_| ())
    .map_err(e)
}

/// Migration 010: option rows for the select properties defined before it.
pub(crate) fn backfill_choices(db: &Connection) -> Result<()> {
    let names: Vec<String> = {
        let mut statement = db.prepare("SELECT name FROM property_definitions").map_err(e)?;
        let rows = statement.query_map([], |r| r.get(0)).map_err(e)?;
        rows.collect::<std::result::Result<_, _>>().map_err(e)?
    };
    for name in names {
        sync_options(db, &name)?;
    }
    Ok(())
}

impl Store {
    /// Definitions as `{name, type, options?, formula?, ...}`, sorted by name.
    pub fn property_definitions(&self) -> Result<Vec<Json>> {
        let db = self.db()?;
        let mut statement = db.prepare("SELECT name, config FROM property_definitions ORDER BY name COLLATE NOCASE").map_err(e)?;
        statement
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(e)?
            .map(|row| {
                let (name, config) = row.map_err(e)?;
                let mut value: Json = serde_json::from_str(&config).map_err(e)?;
                value["name"] = json!(name);
                Ok(value)
            })
            .collect()
    }

    pub fn save_property_definition(&self, name: &str, config: &Json) -> Result<()> {
        let name = name.trim();
        if name.is_empty() || name.len() > 128 || !config.is_object() {
            return Err("Invalid property definition".into());
        }
        let mut config = config.clone();
        if let Some(object) = config.as_object_mut() {
            object.remove("name");
        }
        let text = config.to_string();
        if text.len() > 16384 {
            return Err("Property definition exceeds 16 KiB".into());
        }
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        tx.execute(
            "INSERT INTO property_definitions(name, config, updated_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at",
            params![name, text, now_ms()],
        )
        .map_err(e)?;
        sync_options(&tx, name)?;
        tx.commit().map_err(e)
    }

    /// A select property's values in order, with how many sources hold each.
    pub fn property_options(&self, name: &str) -> Result<Vec<PropertyOption>> {
        let db = self.read()?;
        let mut statement = db
            .prepare(
                "SELECT o.id, o.value, o.position, (SELECT count(*) FROM source_property_options so JOIN sources s ON s.id = so.source_id WHERE so.option_id = o.id AND s.trashed_at IS NULL)
                 FROM property_options o WHERE o.property = ? ORDER BY o.position",
            )
            .map_err(e)?;
        statement
            .query_map([name], |r| Ok(PropertyOption { id: r.get(0)?, value: r.get(1)?, position: r.get(2)?, count: r.get(3)? }))
            .map_err(e)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(e)
    }

    /// Renames one value of a select property on the definition and on every source holding
    /// it. Renaming to another existing value merges the two. Returns the sources changed.
    pub fn rename_property_option(&self, name: &str, from: &str, to: &str) -> Result<usize> {
        let to = to.trim();
        if to.is_empty() || to.len() > 512 {
            return Err("Invalid value".into());
        }
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let option: String = tx
            .query_row("SELECT id FROM property_options WHERE property = ?1 AND value = ?2", params![name, from], |r| r.get(0))
            .optional()
            .map_err(e)?
            .ok_or("That value is not one of the property's options")?;
        let target: Option<String> =
            tx.query_row("SELECT id FROM property_options WHERE property = ?1 AND value = ?2 AND id <> ?3", params![name, to, option], |r| r.get(0)).optional().map_err(e)?;
        let changed = tx
            .execute(
                "UPDATE sources SET properties = json_set(properties, ?2, ?3), updated_at = ?4 WHERE id IN (SELECT source_id FROM source_property_options WHERE option_id = ?1)",
                params![option, json_path(name), to, now_ms()],
            )
            .map_err(e)?;
        match &target {
            Some(target) => {
                tx.execute("INSERT OR IGNORE INTO source_property_options(source_id, option_id) SELECT source_id, ?2 FROM source_property_options WHERE option_id = ?1", params![option, target])
                    .map_err(e)?;
                tx.execute("DELETE FROM property_options WHERE id = ?", [&option]).map_err(e)?;
            }
            None => {
                tx.execute("UPDATE property_options SET value = ?2 WHERE id = ?1", params![option, to]).map_err(e)?;
            }
        }
        let config: String = tx.query_row("SELECT config FROM property_definitions WHERE name = ?", [name], |r| r.get(0)).map_err(e)?;
        let mut config: Json = serde_json::from_str(&config).map_err(e)?;
        if let Some(options) = config.get_mut("options").and_then(Json::as_array_mut) {
            let mut seen = std::collections::HashSet::new();
            let renamed: Vec<Json> = options
                .iter()
                .map(|o| if o.as_str() == Some(from) { json!(to) } else { o.clone() })
                .filter(|o| seen.insert(o.to_string()))
                .collect();
            *options = renamed;
        }
        tx.execute("UPDATE property_definitions SET config = ?2, updated_at = ?3 WHERE name = ?1", params![name, config.to_string(), now_ms()]).map_err(e)?;
        sync_options(&tx, name)?;
        tx.commit().map_err(e)?;
        Ok(changed)
    }

    /// Renames a definition and the matching key in every source's properties.
    pub fn rename_property(&self, name: &str, new_name: &str) -> Result<Json> {
        let new_name = new_name.trim();
        if new_name.is_empty() || new_name.len() > 128 {
            return Err("Invalid property name".into());
        }
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        if tx
            .query_row("SELECT 1 FROM property_definitions WHERE name = ?", [new_name], |_| Ok(()))
            .optional()
            .map_err(e)?
            .is_some()
            && name != new_name
        {
            return Err(format!("A property named “{new_name}” already exists"));
        }
        tx.execute("UPDATE property_definitions SET name = ?2, updated_at = ?3 WHERE name = ?1", params![name, new_name, now_ms()])
            .map_err(e)?;
        let path = format!("$.\"{}\"", name.replace('"', "\\\""));
        let new_path = format!("$.\"{}\"", new_name.replace('"', "\\\""));
        tx.execute(
            "UPDATE sources SET properties = json_remove(json_set(properties, ?2, json_extract(properties, ?1)), ?1)
             WHERE json_type(properties, ?1) IS NOT NULL",
            params![path, new_path],
        )
        .map_err(e)?;
        tx.execute("UPDATE agent_recipes SET name = ?2 WHERE name = ?1", params![name, new_name]).map_err(e)?;
        tx.execute("UPDATE property_provenance SET name = ?2 WHERE name = ?1", params![name, new_name]).map_err(e)?;
        tx.commit().map_err(e)?;
        drop(db);
        let definition = self.property_definitions()?.into_iter().find(|d| d["name"] == new_name).unwrap_or(json!({"name": new_name}));
        Ok(json!({ "attribute": definition }))
    }

    /// Removes a definition; with `delete_values` also every stored value. Returns sources touched.
    pub fn delete_property(&self, name: &str, delete_values: bool) -> Result<usize> {
        let db = self.db()?;
        db.execute("DELETE FROM property_definitions WHERE name = ?", [name]).map_err(e)?;
        if !delete_values {
            return Ok(0);
        }
        let path = format!("$.\"{}\"", name.replace('"', "\\\""));
        db.execute("DELETE FROM property_provenance WHERE name = ?", [name]).map_err(e)?;
        db.execute(
            "UPDATE sources SET properties = json_remove(properties, ?1) WHERE json_type(properties, ?1) IS NOT NULL",
            [path],
        )
        .map_err(e)
    }

    pub fn agent_recipe(&self, name: &str) -> Result<Option<Json>> {
        let config: Option<String> = self
            .db()?
            .query_row("SELECT config FROM agent_recipes WHERE name = ?", [name], |r| r.get(0))
            .optional()
            .map_err(e)?;
        config.map(|text| serde_json::from_str(&text).map_err(e)).transpose()
    }

    pub fn save_agent_recipe(&self, name: &str, config: &Json) -> Result<()> {
        let name = name.trim();
        let prompt = config.get("prompt").and_then(Json::as_str).ok_or("A prompt is required")?;
        let inputs = config.get("inputs").and_then(Json::as_array).ok_or("Select inputs")?;
        if name.is_empty() || name.len() > 128 || prompt.len() > 8192 || inputs.is_empty() || inputs.len() > 16 {
            return Err("Invalid prompt or inputs".into());
        }
        self.db()?
            .execute(
                "INSERT INTO agent_recipes(name, config, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(name) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at",
                params![name, config.to_string(), now_ms()],
            )
            .map(|_| ())
            .map_err(e)
    }

    /// Writes an AI-proposed value only if the property still holds the value the
    /// proposal was generated against, and records where it came from.
    pub fn apply_property_proposal(&self, id: &str, name: &str, value: &Json, expected: &Json, provenance: &Json) -> Result<()> {
        if name.trim().is_empty() || !(value.is_string() || value.is_number() || value.is_boolean()) || value.to_string().len() > 8192 {
            return Err("Proposal must be a bounded scalar".into());
        }
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let properties: String = tx
            .query_row("SELECT properties FROM sources WHERE id = ?", [id], |r| r.get(0))
            .optional()
            .map_err(e)?
            .ok_or("Source not found")?;
        let mut map: Map<String, Json> = serde_json::from_str(&properties).unwrap_or_default();
        if map.get(name).unwrap_or(&Json::Null) != expected {
            return Err("Property changed; generate a new proposal".into());
        }
        map.insert(name.to_string(), value.clone());
        tx.execute(
            "UPDATE sources SET properties = ?2, updated_at = ?3 WHERE id = ?1",
            params![id, Json::Object(map).to_string(), now_ms()],
        )
        .map_err(e)?;
        sync_choices(&tx, id)?;
        tx.execute(
            "INSERT INTO property_provenance(source_id, name, payload) VALUES (?1, ?2, ?3)
             ON CONFLICT(source_id, name) DO UPDATE SET payload = excluded.payload",
            params![id, name, provenance.to_string()],
        )
        .map_err(e)?;
        tx.commit().map_err(e)
    }

    pub fn property_provenance(&self, id: &str) -> Result<Map<String, Json>> {
        let db = self.db()?;
        let mut statement = db.prepare("SELECT name, payload FROM property_provenance WHERE source_id = ?").map_err(e)?;
        let rows = statement
            .query_map([id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(e)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(e)?;
        Ok(rows.into_iter().map(|(name, payload)| (name, serde_json::from_str(&payload).unwrap_or(Json::Null))).collect())
    }

    /// Text for agent context: the first chunks of the source, bounded.
    pub fn leading_text(&self, id: &str, limit: usize) -> Result<String> {
        let db = self.db()?;
        let mut statement = db.prepare("SELECT text FROM chunks WHERE source_id = ? AND page IS NOT NULL ORDER BY seq LIMIT 60").map_err(e)?;
        let mut text = String::new();
        for row in statement.query_map([id], |r| r.get::<_, String>(0)).map_err(e)? {
            let piece = row.map_err(e)?;
            if text.len() + piece.len() > limit {
                break;
            }
            if !text.is_empty() {
                text.push('\n');
            }
            text.push_str(&piece);
        }
        Ok(text)
    }
}
