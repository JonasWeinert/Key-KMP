// Search filters ("Author is Mohamed Ali", "Journal contains lancet") and the suggestions
// that create them as the user types, in the manner of Apple Mail's search tokens.
use crate::{ListQuery, Result, Store, e, fts_phrase, where_clause};
use rusqlite::{params_from_iter, types::Value};
use serde::{Deserialize, Serialize};

/// One filter. Several filters all have to match.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Filter {
    /// creator | container | title | abstract | notes | fulltext | tag | collection | year | kind | itemType | property
    pub field: String,
    /// is | contains (default)
    #[serde(default)]
    pub op: Option<String>,
    pub value: String,
    /// The property name, for `field = "property"`.
    #[serde(default)]
    pub key: Option<String>,
}

/// A creator's display name from its JSON: the literal name, or "Given Family".
const NAME: &str = "trim(coalesce(nullif(json_extract(c.value, '$.literal'), ''), \
    coalesce(json_extract(c.value, '$.given'), '') || ' ' || coalesce(json_extract(c.value, '$.family'), '')))";

fn like(value: &str) -> Value {
    let escaped = value.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
    Value::Text(format!("%{escaped}%"))
}

/// The SQL condition (over `sources s`) and bound values for one filter.
pub(crate) fn condition(filter: &Filter) -> Option<(String, Vec<Value>)> {
    let value = filter.value.trim();
    if value.is_empty() {
        return None;
    }
    let exact = filter.op.as_deref() == Some("is");
    let text = || Value::Text(value.to_string());
    let (sql, values) = match (filter.field.as_str(), exact) {
        ("creator", true) => (format!("EXISTS (SELECT 1 FROM json_each(s.creators) c WHERE {NAME} = ? COLLATE NOCASE)"), vec![text()]),
        ("creator", false) => (format!("EXISTS (SELECT 1 FROM json_each(s.creators) c WHERE {NAME} LIKE ? ESCAPE '\\')"), vec![like(value)]),
        ("container", true) => ("s.container_title = ? COLLATE NOCASE".into(), vec![text()]),
        ("container", false) => (
            "(s.container_title LIKE ? ESCAPE '\\' OR s.container_short LIKE ? ESCAPE '\\' OR s.publisher LIKE ? ESCAPE '\\')".into(),
            vec![like(value), like(value), like(value)],
        ),
        ("title", true) => ("s.title = ? COLLATE NOCASE".into(), vec![text()]),
        ("title", false) => ("(s.title LIKE ? ESCAPE '\\' OR s.short_title LIKE ? ESCAPE '\\')".into(), vec![like(value), like(value)]),
        ("abstract", _) => ("s.abstract LIKE ? ESCAPE '\\'".into(), vec![like(value)]),
        ("notes", _) => (
            "s.id IN (SELECT source_id FROM notes WHERE body LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\')".into(),
            vec![like(value), like(value)],
        ),
        ("fulltext", _) => (
            "s.id IN (SELECT ch.source_id FROM chunks ch WHERE ch.id IN (SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?))".into(),
            vec![Value::Text(fts_phrase(value)?)],
        ),
        ("tag", true) => ("EXISTS (SELECT 1 FROM json_each(s.tags) t WHERE t.value = ? COLLATE NOCASE)".into(), vec![text()]),
        ("tag", false) => ("EXISTS (SELECT 1 FROM json_each(s.tags) t WHERE t.value LIKE ? ESCAPE '\\')".into(), vec![like(value)]),
        // A collection includes items filed in any of its sub-collections.
        ("collection", _) => (
            "s.id IN (SELECT sc.source_id FROM source_collections sc WHERE sc.collection_id IN (
               WITH RECURSIVE tree(id) AS (SELECT ? UNION ALL SELECT c.id FROM collections c JOIN tree ON c.parent_id = tree.id)
               SELECT id FROM tree))"
                .into(),
            vec![text()],
        ),
        ("year", _) => ("s.year = ?".into(), vec![Value::Integer(value.parse().ok()?)]),
        ("kind", _) => ("s.kind = ?".into(), vec![text()]),
        ("itemType", _) => ("s.item_type = ?".into(), vec![text()]),
        ("property", is) => {
            let path = Value::Text(format!("$.\"{}\"", filter.key.as_deref()?.replace('"', "\\\"")));
            if is {
                ("CAST(json_extract(s.properties, ?) AS TEXT) = ? COLLATE NOCASE".into(), vec![path, text()])
            } else {
                ("CAST(json_extract(s.properties, ?) AS TEXT) LIKE ? ESCAPE '\\'".into(), vec![path, like(value)])
            }
        }
        _ => return None,
    };
    Some((sql, values))
}

/// A filter the user can pick, with how many sources in the current view it matches.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub filter: Filter,
    /// What the menu shows, e.g. a person's name or a journal title.
    pub label: String,
    pub count: i64,
}

impl Store {
    /// Values in the current view that start a word with what was typed: people, journals,
    /// tags, collections, years and values of the user's defined properties, most common
    /// first within each group.
    pub fn suggest(&self, text: &str, view: &ListQuery, per_group: usize) -> Result<Vec<Suggestion>> {
        let typed = text.trim();
        if typed.chars().count() < 2 {
            return Ok(Vec::new());
        }
        let mut view = view.clone();
        view.text = None;
        let (clause, values) = where_clause(&view);
        let db = self.read()?;
        let escaped = typed.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_");
        // Matches at the start of the value or of any word in it ("Ali" in "Mohamed Ali").
        let starts = Value::Text(format!("{escaped}%"));
        let inner = Value::Text(format!("% {escaped}%"));
        let word = "(v LIKE ?1 ESCAPE '\\' OR v LIKE ?2 ESCAPE '\\')";
        let limit = per_group.clamp(1, 20);
        let mut out = Vec::new();
        let mut group = |field: &str, sql: String, key: bool| -> Result<()> {
            let mut statement = db.prepare(&sql).map_err(e)?;
            let mut args = vec![starts.clone(), inner.clone()];
            args.extend(values.iter().cloned());
            let rows = statement
                .query_map(params_from_iter(args.iter()), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, if key { r.get::<_, Option<String>>(2)? } else { None }))
                })
                .map_err(e)?;
            for row in rows {
                let (value, count, property) = row.map_err(e)?;
                out.push(Suggestion {
                    label: value.clone(),
                    count,
                    filter: Filter { field: field.into(), op: Some("is".into()), value, key: property },
                });
            }
            Ok(())
        };
        // Bound values: ?1 and ?2 are the patterns, the view's own values follow from ?3.
        let numbered = number_from(&clause, 3);
        group(
            "creator",
            format!(
                "SELECT v, count(DISTINCT sid) n FROM (SELECT s.id sid, {NAME} v FROM sources s, json_each(s.creators) c {numbered})
                 WHERE v <> '' AND {word} GROUP BY v COLLATE NOCASE ORDER BY v LIKE ?1 ESCAPE '\\' DESC, n DESC, v LIMIT {limit}"
            ),
            false,
        )?;
        group(
            "container",
            format!(
                "SELECT v, count(*) n FROM (SELECT s.container_title v FROM sources s {numbered})
                 WHERE v IS NOT NULL AND v <> '' AND {word} GROUP BY v COLLATE NOCASE ORDER BY n DESC, v LIMIT {limit}"
            ),
            false,
        )?;
        group(
            "tag",
            format!(
                "SELECT v, count(*) n FROM (SELECT t.value v FROM sources s, json_each(s.tags) t {numbered})
                 WHERE {word} GROUP BY v COLLATE NOCASE ORDER BY n DESC, v LIMIT {limit}"
            ),
            false,
        )?;
        group(
            "property",
            format!(
                "SELECT v, count(*) n, k FROM (SELECT CAST(p.value AS TEXT) v, p.key k FROM sources s, json_each(s.properties) p {numbered}
                   AND p.type IN ('text', 'integer', 'real') AND length(CAST(p.value AS TEXT)) <= 80
                   AND p.key IN (SELECT name FROM property_definitions))
                 WHERE {word} GROUP BY k, v COLLATE NOCASE ORDER BY n DESC, v LIMIT {limit}"
            ),
            true,
        )?;
        drop(group);
        // Collections and years are matched by name and number rather than from the view.
        let mut statement = db
            .prepare(&format!(
                "SELECT c.id, c.name, (SELECT count(*) FROM source_collections sc WHERE sc.collection_id = c.id) FROM collections c
                 WHERE (c.name LIKE ?1 ESCAPE '\\' OR c.name LIKE ?2 ESCAPE '\\') ORDER BY c.name LIKE ?1 ESCAPE '\\' DESC, c.name LIMIT {limit}"
            ))
            .map_err(e)?;
        let rows = statement
            .query_map([starts.clone(), inner.clone()], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
            .map_err(e)?;
        for row in rows {
            let (id, name, count) = row.map_err(e)?;
            out.push(Suggestion { label: name, count, filter: Filter { field: "collection".into(), op: Some("is".into()), value: id, key: None } });
        }
        if let Ok(year) = typed.parse::<i64>() {
            if (1400..=2200).contains(&year) {
                let mut year_view = view.clone();
                year_view.filters.push(Filter { field: "year".into(), value: year.to_string(), ..Default::default() });
                let (clause, values) = where_clause(&year_view);
                let count: i64 = db
                    .query_row(&format!("SELECT count(*) FROM sources s {clause}"), params_from_iter(values.iter()), |r| r.get(0))
                    .map_err(e)?;
                if count > 0 {
                    out.push(Suggestion { label: year.to_string(), count, filter: Filter { field: "year".into(), op: Some("is".into()), value: year.to_string(), key: None } });
                }
            }
        }
        Ok(out)
    }
}

/// Rewrites bare `?` placeholders as `?N, ?N+1, …` so they can follow numbered ones.
fn number_from(sql: &str, first: usize) -> String {
    let mut out = String::with_capacity(sql.len() + 16);
    let mut next = first;
    let mut chars = sql.chars().peekable();
    let mut quoted = false;
    while let Some(ch) = chars.next() {
        if ch == '\'' {
            quoted = !quoted;
        }
        if ch == '?' && !quoted && !chars.peek().is_some_and(|c| c.is_ascii_digit()) {
            out.push_str(&format!("?{next}"));
            next += 1;
        } else {
            out.push(ch);
        }
    }
    out
}
