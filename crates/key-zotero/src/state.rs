// What Key last took from Zotero, kept beside the library in zotero-sync.sqlite: for each
// Zotero item, note and collection, the Key id it became and the values it had then. A
// later import or sync compares Zotero now, Key now and this base, so it can tell an edit
// made in Key (kept) from a change made in Zotero (applied).
use crate::Result;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::Value as Json;
use std::{collections::HashMap, path::Path};

pub struct State {
    db: Connection,
}

/// A tracked Zotero object. `id` is None once it was deleted in Key: it is not brought back.
#[derive(Clone, Debug, Default)]
pub struct Tracked {
    pub id: Option<String>,
    pub base: Json,
    /// Key moved it to the trash because it was deleted in Zotero.
    pub trashed_by_sync: bool,
}

impl State {
    pub fn open(root: &Path) -> Result<State> {
        let db = Connection::open(root.join("zotero-sync.sqlite")).map_err(|e| e.to_string())?;
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS tracked(
               kind TEXT NOT NULL, key TEXT NOT NULL, id TEXT, base TEXT NOT NULL,
               trashed_by_sync INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(kind, key));",
        )
        .map_err(|e| e.to_string())?;
        Ok(State { db })
    }

    pub fn meta(&self, key: &str) -> Option<String> {
        self.db.query_row("SELECT value FROM meta WHERE key = ?", [key], |r| r.get(0)).optional().ok().flatten()
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        self.db
            .execute("INSERT INTO meta(key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![key, value])
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Everything tracked of one kind ("item", "note", "collection").
    pub fn all(&self, kind: &str) -> Result<HashMap<String, Tracked>> {
        let mut statement = self.db.prepare("SELECT key, id, base, trashed_by_sync FROM tracked WHERE kind = ?").map_err(|e| e.to_string())?;
        statement
            .query_map([kind], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    Tracked {
                        id: r.get(1)?,
                        base: serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or(Json::Null),
                        trashed_by_sync: r.get::<_, i64>(3)? != 0,
                    },
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<std::result::Result<HashMap<_, _>, _>>()
            .map_err(|e| e.to_string())
    }

    /// Writes every change of a run in one transaction.
    pub fn save(&mut self, kind: &str, changes: &HashMap<String, Option<Tracked>>) -> Result<()> {
        let tx = self.db.transaction().map_err(|e| e.to_string())?;
        {
            let mut upsert = tx
                .prepare(
                    "INSERT INTO tracked(kind, key, id, base, trashed_by_sync) VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(kind, key) DO UPDATE SET id = excluded.id, base = excluded.base, trashed_by_sync = excluded.trashed_by_sync",
                )
                .map_err(|e| e.to_string())?;
            let mut delete = tx.prepare("DELETE FROM tracked WHERE kind = ?1 AND key = ?2").map_err(|e| e.to_string())?;
            for (key, change) in changes {
                match change {
                    Some(t) => upsert.execute(params![kind, key, t.id, t.base.to_string(), t.trashed_by_sync as i64]),
                    None => delete.execute(params![kind, key]),
                }
                .map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())
    }
}
