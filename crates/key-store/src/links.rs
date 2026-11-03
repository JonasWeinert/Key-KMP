// Cross-references between items (notes, sources and their pages or highlights, canvases,
// workspace records) and the canvases that hold them. Links are rewritten by whoever owns
// them: a note on every save (from its Markdown), a canvas on every save (its cards and
// connectors). Titles are read from the items when links are listed, so a rename follows
// by id; deleting an item drops the links it wrote and marks links to it as broken.
use super::{Result, Store, e, new_id, now_ms};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use std::collections::HashMap;

pub const NOTE: &str = "note";
pub const SOURCE: &str = "source";
pub const CANVAS: &str = "canvas";
pub const RECORD: &str = "record";

/// An item, or a place inside one: `page:3`, `highlight:<id>`, `heading:<slug>`, `node:<id>`.
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct ItemRef {
    pub kind: String,
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
}
impl ItemRef {
    pub fn new(kind: &str, id: &str, anchor: Option<&str>) -> Self {
        Self { kind: kind.into(), id: id.into(), anchor: anchor.map(String::from) }
    }
}

/// One link as its owner writes it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct LinkInput {
    pub from: ItemRef,
    pub to: ItemRef,
    pub label: Option<String>,
    pub context: Option<String>,
}

/// One end of a listed link, with what the item is called now.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkEnd {
    pub kind: String,
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor: Option<String>,
    pub title: String,
    /// The source's kind (pdf, web …) or the record's, for an icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// "p. 4" or the highlighted text, when the link points inside the item.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub anchor_label: Option<String>,
    pub exists: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    pub id: i64,
    pub from: LinkEnd,
    pub to: LinkEnd,
    /// The canvas a connector was drawn on, when it is not the link's own start.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub via: Option<LinkEnd>,
    pub label: Option<String>,
    pub context: Option<String>,
    pub broken: bool,
    pub created_at: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemLinks {
    pub outgoing: Vec<Link>,
    pub backlinks: Vec<Link>,
}

/// Something a link can point at, as offered by the link picker.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkTarget {
    #[serde(flatten)]
    pub item: ItemRef,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// Highlights carry the source's title and their colour.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<i64>,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasSummary {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Canvas {
    pub id: String,
    pub title: String,
    pub doc: Json,
    pub created_at: i64,
    pub updated_at: i64,
}

impl Store {
    /// Replaces every link `owner` wrote. Links to items that do not exist are kept, broken.
    pub fn replace_links(&self, owner: &ItemRef, links: &[LinkInput]) -> Result<()> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        write_links(&tx, owner, links)?;
        tx.commit().map_err(e)
    }

    /// A note's links as read from the version saved at `version` (its updated_at); a newer
    /// save writes its own.
    pub fn replace_note_links(&self, note_id: &str, version: i64, links: &[LinkInput]) -> Result<()> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let current: Option<i64> = tx
            .query_row("SELECT updated_at FROM notes WHERE id = ?", [note_id], |r| r.get(0))
            .optional()
            .map_err(e)?;
        if current != Some(version) {
            return Ok(());
        }
        write_links(&tx, &ItemRef::new(NOTE, note_id, None), links)?;
        tx.commit().map_err(e)
    }

    /// What an item links to and what links to it.
    pub fn item_links(&self, kind: &str, id: &str) -> Result<ItemLinks> {
        let db = self.read()?;
        let mut titles = Titles::new(&db);
        let outgoing = query_links(&db, "from_kind = ?1 AND from_id = ?2", kind, id, &mut titles)?;
        let mut backlinks = query_links(&db, "to_kind = ?1 AND to_id = ?2", kind, id, &mut titles)?;
        // A source's own notes quote and mention it all the time; they are not news.
        let own_notes: Vec<String> = if kind == SOURCE {
            let mut statement = db.prepare("SELECT id FROM notes WHERE source_id = ?").map_err(e)?;
            let rows = statement.query_map([id], |r| r.get::<_, String>(0)).map_err(e)?;
            rows.collect::<std::result::Result<_, _>>().map_err(e)?
        } else {
            Vec::new()
        };
        backlinks.retain(|link| {
            !(link.from.kind == kind && link.from.id == id) && !(link.from.kind == NOTE && own_notes.contains(&link.from.id))
        });
        Ok(ItemLinks { outgoing, backlinks })
    }

    /// Items whose title (or a highlight's text) matches, for the link picker. Empty text
    /// lists the most recently edited of each kind.
    pub fn link_targets(&self, text: &str, kinds: &[String], limit: usize) -> Result<Vec<LinkTarget>> {
        let db = self.read()?;
        let pattern = format!("%{}%", text.trim().replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let wants = |kind: &str| kinds.is_empty() || kinds.iter().any(|k| k == kind);
        let limit = limit.max(1) as i64;
        let mut out = Vec::new();
        if wants(NOTE) {
            let mut statement = db
                .prepare(
                    "SELECT id, title, body, source_id, updated_at FROM notes
                     WHERE title LIKE ?1 ESCAPE '\\' OR (title = '' AND body LIKE ?1 ESCAPE '\\')
                     ORDER BY updated_at DESC LIMIT ?2",
                )
                .map_err(e)?;
            let rows = statement
                .query_map(params![pattern, limit], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, i64>(4)?))
                })
                .map_err(e)?;
            for row in rows {
                let (id, title, body, source, updated_at) = row.map_err(e)?;
                out.push(LinkTarget {
                    item: ItemRef::new(NOTE, &id, None),
                    title: note_title(&title, &body),
                    detail: source.map(|_| "source note".into()),
                    context: None,
                    color: None,
                    page: None,
                    updated_at,
                });
            }
        }
        if wants(SOURCE) {
            let mut statement = db
                .prepare(
                    "SELECT id, title, kind, updated_at FROM sources
                     WHERE trashed_at IS NULL AND (title LIKE ?1 ESCAPE '\\' OR coalesce(short_title, '') LIKE ?1 ESCAPE '\\' OR creators LIKE ?1 ESCAPE '\\')
                     ORDER BY updated_at DESC LIMIT ?2",
                )
                .map_err(e)?;
            let rows = statement
                .query_map(params![pattern, limit], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?)))
                .map_err(e)?;
            for row in rows {
                let (id, title, kind, updated_at) = row.map_err(e)?;
                out.push(LinkTarget {
                    item: ItemRef::new(SOURCE, &id, None),
                    title: or_untitled(&title, "Untitled"),
                    detail: Some(kind),
                    context: None,
                    color: None,
                    page: None,
                    updated_at,
                });
            }
        }
        if wants(CANVAS) {
            let mut statement = db
                .prepare("SELECT id, title, updated_at FROM canvases WHERE title LIKE ?1 ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?2")
                .map_err(e)?;
            let rows = statement
                .query_map(params![pattern, limit], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
                .map_err(e)?;
            for row in rows {
                let (id, title, updated_at) = row.map_err(e)?;
                out.push(LinkTarget {
                    item: ItemRef::new(CANVAS, &id, None),
                    title: or_untitled(&title, "Untitled canvas"),
                    detail: None,
                    context: None,
                    color: None,
                    page: None,
                    updated_at,
                });
            }
        }
        // Without text, highlights come only when asked for by name (the most recent first).
        if wants("highlight") && (!text.trim().is_empty() || kinds.iter().any(|k| k == "highlight")) {
            let mut statement = db
                .prepare(
                    "SELECT a.id, a.source_id, a.payload, a.updated_at, s.title FROM annotations a JOIN sources s ON s.id = a.source_id
                     WHERE s.trashed_at IS NULL AND (json_extract(a.payload, '$.text') LIKE ?1 ESCAPE '\\' OR json_extract(a.payload, '$.comment') LIKE ?1 ESCAPE '\\')
                     ORDER BY a.updated_at DESC LIMIT ?2",
                )
                .map_err(e)?;
            let rows = statement
                .query_map(params![pattern, limit], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, i64>(3)?, r.get::<_, String>(4)?))
                })
                .map_err(e)?;
            for row in rows {
                let (id, source, payload, updated_at, source_title) = row.map_err(e)?;
                let payload: Json = serde_json::from_str(&payload).unwrap_or_default();
                let anchor = format!("highlight:{id}");
                out.push(LinkTarget {
                    item: ItemRef::new(SOURCE, &source, Some(&anchor)),
                    title: highlight_text(&payload).unwrap_or_else(|| "Highlight".into()),
                    detail: Some("highlight".into()),
                    context: Some(or_untitled(&source_title, "Untitled")),
                    color: payload.get("color").and_then(Json::as_str).map(String::from),
                    page: highlight_page(&payload),
                    updated_at,
                });
            }
        }
        Ok(out)
    }

    // ── Canvases ────────────────────────────────────────────

    pub fn canvases(&self) -> Result<Vec<CanvasSummary>> {
        let db = self.read()?;
        let mut statement = db.prepare("SELECT id, title, created_at, updated_at FROM canvases ORDER BY updated_at DESC").map_err(e)?;
        statement
            .query_map([], |r| Ok(CanvasSummary { id: r.get(0)?, title: r.get(1)?, created_at: r.get(2)?, updated_at: r.get(3)? }))
            .map_err(e)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(e)
    }

    pub fn canvas(&self, id: &str) -> Result<Option<Canvas>> {
        self.read()?
            .query_row("SELECT id, title, doc, created_at, updated_at FROM canvases WHERE id = ?", [id], read_canvas)
            .optional()
            .map_err(e)
    }

    /// Creates (without an id) or replaces a canvas, and rewrites the links its cards and
    /// connectors make. `title` or `doc` left out keep what is stored.
    pub fn save_canvas(&self, id: Option<&str>, title: Option<&str>, doc: Option<&Json>) -> Result<Canvas> {
        let now = now_ms();
        let id = id.map(String::from).unwrap_or_else(new_id);
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let doc_text = doc.map(Json::to_string);
        tx.execute(
            "INSERT INTO canvases(id, title, doc, created_at, updated_at) VALUES (?1, coalesce(?2, ''), coalesce(?3, '{}'), ?4, ?4)
             ON CONFLICT(id) DO UPDATE SET title = coalesce(?2, title), doc = coalesce(?3, doc), updated_at = ?4",
            params![id, title, doc_text, now],
        )
        .map_err(e)?;
        let canvas = tx
            .query_row("SELECT id, title, doc, created_at, updated_at FROM canvases WHERE id = ?", [&id], read_canvas)
            .map_err(e)?;
        if doc.is_some() {
            write_links(&tx, &ItemRef::new(CANVAS, &id, None), &canvas_links(&id, &canvas.doc))?;
        }
        // A canvas that was deleted and comes back (undo) mends the links to it.
        mend_links_to(&tx, CANVAS, &id)?;
        tx.commit().map_err(e)?;
        Ok(canvas)
    }

    pub fn delete_canvas(&self, id: &str) -> Result<()> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        tx.execute("DELETE FROM canvases WHERE id = ?", [id]).map_err(e)?;
        forget_item(&tx, CANVAS, id)?;
        tx.commit().map_err(e)
    }
}

/// The links a canvas makes: each card that shows an item links the canvas (at that card)
/// to the item, and each connector between two such cards links the two items.
pub fn canvas_links(canvas_id: &str, doc: &Json) -> Vec<LinkInput> {
    let empty = Vec::new();
    let nodes = doc.get("nodes").and_then(Json::as_array).unwrap_or(&empty);
    let mut items: HashMap<&str, (ItemRef, Option<String>)> = HashMap::new();
    let mut links = Vec::new();
    for node in nodes {
        let (Some(node_id), Some(item)) = (node.get("id").and_then(Json::as_str), node.get("ref")) else { continue };
        let Ok(item) = serde_json::from_value::<ItemRef>(item.clone()) else { continue };
        if item.kind.is_empty() || item.id.is_empty() {
            continue;
        }
        let label = node.get("title").and_then(Json::as_str).map(String::from);
        links.push(LinkInput {
            from: ItemRef::new(CANVAS, canvas_id, Some(&format!("node:{node_id}"))),
            to: item.clone(),
            label: label.clone(),
            context: None,
        });
        items.insert(node_id, (item, label));
    }
    for edge in doc.get("edges").and_then(Json::as_array).unwrap_or(&empty) {
        let end = |side: &str| edge.get(side).and_then(|s| s.get("node")).and_then(Json::as_str).and_then(|n| items.get(n));
        let (Some((from, _)), Some((to, to_label))) = (end("from"), end("to")) else { continue };
        if from == to {
            continue;
        }
        let label = edge.get("label").and_then(Json::as_str).filter(|l| !l.trim().is_empty()).map(String::from);
        links.push(LinkInput { from: from.clone(), to: to.clone(), label: label.clone().or_else(|| to_label.clone()), context: label });
    }
    links
}

/// Drops the links an item wrote and marks links to it broken. Used by every delete path.
pub(crate) fn forget_item(db: &Connection, kind: &str, id: &str) -> Result<()> {
    db.execute("DELETE FROM links WHERE owner_kind = ?1 AND owner_id = ?2", params![kind, id]).map_err(e)?;
    db.execute(
        "UPDATE links SET broken_at = ?3 WHERE to_kind = ?1 AND to_id = ?2 AND broken_at IS NULL",
        params![kind, id, now_ms()],
    )
    .map_err(e)?;
    Ok(())
}

fn mend_links_to(db: &Connection, kind: &str, id: &str) -> Result<()> {
    db.execute("UPDATE links SET broken_at = NULL WHERE to_kind = ?1 AND to_id = ?2 AND to_anchor IS NULL AND broken_at IS NOT NULL", params![kind, id])
        .map_err(e)?;
    Ok(())
}

/// Links to a source's highlights follow the highlights: broken once one is deleted,
/// whole again if it comes back.
pub(crate) fn sync_highlight_links(db: &Connection, source_id: &str) -> Result<()> {
    let missing = "substr(to_anchor, 11) NOT IN (SELECT id FROM annotations WHERE source_id = ?1)";
    db.execute(
        &format!("UPDATE links SET broken_at = ?2 WHERE to_kind = 'source' AND to_id = ?1 AND to_anchor LIKE 'highlight:%' AND broken_at IS NULL AND {missing}"),
        params![source_id, now_ms()],
    )
    .map_err(e)?;
    db.execute(
        &format!("UPDATE links SET broken_at = NULL WHERE to_kind = 'source' AND to_id = ?1 AND to_anchor LIKE 'highlight:%' AND broken_at IS NOT NULL AND NOT {missing}"),
        params![source_id],
    )
    .map_err(e)?;
    Ok(())
}

fn write_links(db: &Connection, owner: &ItemRef, links: &[LinkInput]) -> Result<()> {
    db.execute("DELETE FROM links WHERE owner_kind = ?1 AND owner_id = ?2", params![owner.kind, owner.id]).map_err(e)?;
    let now = now_ms();
    let mut insert = db
        .prepare(
            "INSERT INTO links(owner_kind, owner_id, from_kind, from_id, from_anchor, to_kind, to_id, to_anchor, label, context, seq, broken_at, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        )
        .map_err(e)?;
    for (seq, link) in links.iter().enumerate() {
        let broken = (!target_exists(db, &link.to)?).then_some(now);
        insert
            .execute(params![
                owner.kind,
                owner.id,
                link.from.kind,
                link.from.id,
                link.from.anchor,
                link.to.kind,
                link.to.id,
                link.to.anchor,
                link.label,
                link.context,
                seq as i64,
                broken,
                now
            ])
            .map_err(e)?;
    }
    Ok(())
}

fn target_exists(db: &Connection, item: &ItemRef) -> Result<bool> {
    let table = match item.kind.as_str() {
        NOTE => "notes",
        SOURCE => "sources",
        CANVAS => "canvases",
        // Records live in the workspace's other database; the host checks those.
        _ => return Ok(true),
    };
    let exists: bool = db
        .query_row(&format!("SELECT EXISTS(SELECT 1 FROM {table} WHERE id = ?)"), [&item.id], |r| r.get(0))
        .map_err(e)?;
    if !exists {
        return Ok(false);
    }
    match item.anchor.as_deref().and_then(|a| a.strip_prefix("highlight:")) {
        Some(highlight) if item.kind == SOURCE => db
            .query_row("SELECT EXISTS(SELECT 1 FROM annotations WHERE id = ?1 AND source_id = ?2)", params![highlight, item.id], |r| r.get(0))
            .map_err(e),
        _ => Ok(true),
    }
}

fn query_links(db: &Connection, filter: &str, kind: &str, id: &str, titles: &mut Titles) -> Result<Vec<Link>> {
    let mut statement = db
        .prepare(&format!(
            "SELECT id, owner_kind, owner_id, from_kind, from_id, from_anchor, to_kind, to_id, to_anchor, label, context, broken_at, created_at
             FROM links WHERE {filter} ORDER BY owner_kind, owner_id, seq"
        ))
        .map_err(e)?;
    let rows = statement
        .query_map(params![kind, id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                ItemRef { kind: r.get(1)?, id: r.get(2)?, anchor: None },
                ItemRef { kind: r.get(3)?, id: r.get(4)?, anchor: r.get(5)? },
                ItemRef { kind: r.get(6)?, id: r.get(7)?, anchor: r.get(8)? },
                r.get::<_, Option<String>>(9)?,
                r.get::<_, Option<String>>(10)?,
                r.get::<_, Option<i64>>(11)?,
                r.get::<_, i64>(12)?,
            ))
        })
        .map_err(e)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(e)?;
    let mut links = Vec::with_capacity(rows.len());
    for (id, owner, from, to, label, context, broken_at, created_at) in rows {
        let via = (owner.kind != from.kind || owner.id != from.id).then(|| titles.end(&owner, None)).transpose()?;
        let from = titles.end(&from, None)?;
        let to = titles.end(&to, label.as_deref())?;
        let broken = broken_at.is_some() || !to.exists;
        links.push(Link { id, from, to, via, label, context, broken, created_at });
    }
    Ok(links)
}

/// Looks items up once per listing.
struct Titles<'a> {
    db: &'a Connection,
    seen: HashMap<(String, String), Option<(String, Option<String>)>>,
}
impl<'a> Titles<'a> {
    fn new(db: &'a Connection) -> Self {
        Self { db, seen: HashMap::new() }
    }

    fn end(&mut self, item: &ItemRef, label: Option<&str>) -> Result<LinkEnd> {
        let key = (item.kind.clone(), item.id.clone());
        if !self.seen.contains_key(&key) {
            let found = lookup(self.db, &item.kind, &item.id)?;
            self.seen.insert(key.clone(), found);
        }
        let found = self.seen[&key].clone();
        let unknown = item.kind == RECORD;
        let (title, detail) = found.clone().unwrap_or_else(|| (label.filter(|l| !l.trim().is_empty()).unwrap_or("Missing item").to_string(), None));
        let (anchor_label, anchor_exists) = anchor_label(self.db, item)?;
        Ok(LinkEnd {
            kind: item.kind.clone(),
            id: item.id.clone(),
            anchor: item.anchor.clone(),
            title,
            detail,
            anchor_label,
            exists: (found.is_some() || unknown) && anchor_exists,
        })
    }
}

fn lookup(db: &Connection, kind: &str, id: &str) -> Result<Option<(String, Option<String>)>> {
    match kind {
        NOTE => db
            .query_row("SELECT title, body FROM notes WHERE id = ?", [id], |r| Ok(note_title(&r.get::<_, String>(0)?, &r.get::<_, String>(1)?)))
            .optional()
            .map(|t| t.map(|t| (t, None)))
            .map_err(e),
        SOURCE => db
            .query_row("SELECT title, kind FROM sources WHERE id = ?", [id], |r| {
                Ok((or_untitled(&r.get::<_, String>(0)?, "Untitled"), Some(r.get::<_, String>(1)?)))
            })
            .optional()
            .map_err(e),
        CANVAS => db
            .query_row("SELECT title FROM canvases WHERE id = ?", [id], |r| Ok((or_untitled(&r.get::<_, String>(0)?, "Untitled canvas"), None)))
            .optional()
            .map_err(e),
        _ => Ok(None),
    }
}

fn anchor_label(db: &Connection, item: &ItemRef) -> Result<(Option<String>, bool)> {
    let Some(anchor) = item.anchor.as_deref() else { return Ok((None, true)) };
    if let Some(page) = anchor.strip_prefix("page:").and_then(|p| p.parse::<i64>().ok()) {
        return Ok((Some(format!("p. {}", page + 1)), true));
    }
    if let Some(highlight) = anchor.strip_prefix("highlight:") {
        let payload: Option<String> = db
            .query_row("SELECT payload FROM annotations WHERE id = ?", [highlight], |r| r.get(0))
            .optional()
            .map_err(e)?;
        let payload = payload.and_then(|p| serde_json::from_str::<Json>(&p).ok());
        return Ok((Some(payload.as_ref().and_then(highlight_text).unwrap_or_else(|| "Highlight".into())), payload.is_some()));
    }
    if let Some(heading) = anchor.strip_prefix("heading:") {
        return Ok((Some(heading.replace('-', " ")), true));
    }
    Ok((None, true))
}

fn read_canvas(r: &rusqlite::Row) -> rusqlite::Result<Canvas> {
    let doc: String = r.get(2)?;
    Ok(Canvas { id: r.get(0)?, title: r.get(1)?, doc: serde_json::from_str(&doc).unwrap_or_else(|_| Json::Object(Default::default())), created_at: r.get(3)?, updated_at: r.get(4)? })
}

fn or_untitled(title: &str, fallback: &str) -> String {
    let title = title.trim();
    if title.is_empty() { fallback.into() } else { title.into() }
}

/// A note's title, or its first line of text when it has none.
pub fn note_title(title: &str, body: &str) -> String {
    if !title.trim().is_empty() {
        return title.trim().into();
    }
    let line = body
        .lines()
        .map(|l| l.trim().trim_start_matches(['#', '>', '-', '*', ' ']).trim())
        .find(|l| !l.is_empty() && !l.starts_with("```"))
        .unwrap_or("");
    let line: String = line.chars().take(80).collect();
    if line.is_empty() { "Untitled note".into() } else { line }
}

fn highlight_text(payload: &Json) -> Option<String> {
    let text = ["text", "comment"].iter().find_map(|k| payload.get(*k).and_then(Json::as_str).filter(|t| !t.trim().is_empty()))?;
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    Some(if text.chars().count() > 120 { format!("{}…", text.chars().take(119).collect::<String>()) } else { text })
}

fn highlight_page(payload: &Json) -> Option<i64> {
    payload
        .pointer("/anchor/pages/0/page")
        .or_else(|| payload.pointer("/range/start/page"))
        .and_then(Json::as_i64)
}
