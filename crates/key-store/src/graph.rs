// The metadata graph around sources: people, venues, publishers, institutions, topics,
// keywords and funders, each in its own table and linked to sources by id (migration 010).
//
// A source's creators JSON and container title stay the text it shows and cites. Whenever
// they change, `sync_people` and `sync_venue` link that text to rows here: a name keeps its
// person while it is unchanged at its position; a new name joins the person with the same
// name who has no identifiers (or a spelling confirmed by an earlier merge), else a new
// person. Identified people (ORCID, OpenAlex) come only from OpenAlex and are joined only by
// those identifiers. Name variants that may be one person are suggested, never merged
// without the user (`merge_suggestions`, `merge_people`, `dismiss_merge`).
use crate::{Creator, Result, Store, e, links, new_id, now_ms};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use unicode_normalization::{UnicodeNormalization, char::is_combining_mark};

pub const PERSON: &str = "person";
pub const VENUE: &str = "venue";
pub const TOPIC: &str = "topic";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Institution {
    pub id: String,
    pub name: String,
    pub ror: Option<String>,
    pub openalex_id: Option<String>,
    pub country: Option<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub name: String,
    pub family: Option<String>,
    pub given: Option<String>,
    pub orcid: Option<String>,
    pub openalex_id: Option<String>,
    pub institution: Option<Institution>,
    /// Cached from OpenAlex; `metrics_at` is when they were fetched.
    pub works_count: Option<i64>,
    pub cited_by_count: Option<i64>,
    pub h_index: Option<i64>,
    pub i10_index: Option<i64>,
    pub metrics_at: Option<i64>,
    /// Other spellings seen for this person.
    pub names: Vec<String>,
    /// Sources in this library (not in the bin).
    pub source_count: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Publisher {
    pub id: String,
    pub name: String,
    pub openalex_id: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Venue {
    pub id: String,
    pub name: String,
    pub issn_l: Option<String>,
    pub issns: Vec<String>,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    pub openalex_id: Option<String>,
    pub publisher: Option<Publisher>,
    pub homepage: Option<String>,
    pub is_oa: Option<bool>,
    pub in_doaj: Option<bool>,
    pub works_count: Option<i64>,
    pub cited_by_count: Option<i64>,
    pub h_index: Option<i64>,
    pub metrics_at: Option<i64>,
    pub source_count: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicRef {
    pub id: String,
    pub name: String,
    pub level: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub id: String,
    pub name: String,
    pub level: String,
    /// Domain first, down to the topic's parent.
    pub path: Vec<TopicRef>,
    pub source_count: i64,
}

/// Something connected to a person, venue or topic, with how many library sources share it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NamedCount {
    pub id: String,
    pub name: String,
    pub count: i64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePerson {
    pub position: i64,
    pub person_id: String,
    /// As printed on this source.
    pub name: String,
    pub role: String,
    pub corresponding: bool,
    pub orcid: Option<String>,
    pub openalex_id: Option<String>,
    pub institutions: Vec<Institution>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceTopic {
    pub id: String,
    pub name: String,
    pub score: Option<f64>,
    pub primary: bool,
    pub path: Vec<TopicRef>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keyword {
    pub id: String,
    pub name: String,
    pub score: Option<f64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub funder_id: String,
    pub funder: String,
    pub award_id: Option<String>,
    pub title: Option<String>,
}

/// One work a source cites: from the PDF's own bibliography, from OpenAlex, or both.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkReference {
    /// pdf | openalex
    pub origin: String,
    pub seq: i64,
    pub number: Option<i64>,
    pub title: Option<String>,
    pub byline: Option<String>,
    pub year: Option<i64>,
    pub container: Option<String>,
    pub doi: Option<String>,
    pub openalex_id: Option<String>,
    /// The printed entry, for a PDF reference.
    pub text: Option<String>,
    pub matched_source_id: Option<String>,
}

/// A library source that cites this one.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CitingSource {
    pub id: String,
    pub title: String,
    pub year: Option<i64>,
}

/// Everything around one source: who wrote it and where they were, where it appeared,
/// what it is about, who paid for it, what it cites and what cites it.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceGraph {
    pub people: Vec<SourcePerson>,
    pub venue: Option<Venue>,
    pub publisher: Option<Publisher>,
    pub topics: Vec<SourceTopic>,
    pub keywords: Vec<Keyword>,
    pub grants: Vec<Grant>,
    pub references: Vec<WorkReference>,
    pub cited_by: Vec<CitingSource>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeSuggestion {
    /// The one kept.
    pub person: Person,
    /// The one folded into it.
    pub other: Person,
    pub reason: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersonPage {
    pub person: Person,
    pub coauthors: Vec<NamedCount>,
    pub venues: Vec<NamedCount>,
    pub topics: Vec<NamedCount>,
    pub first_year: Option<i64>,
    pub last_year: Option<i64>,
    pub suggestions: Vec<MergeSuggestion>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VenuePage {
    pub venue: Venue,
    pub people: Vec<NamedCount>,
    pub topics: Vec<NamedCount>,
    pub first_year: Option<i64>,
    pub last_year: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TopicPage {
    pub topic: Topic,
    /// Narrower topics with sources in the library.
    pub children: Vec<NamedCount>,
    pub people: Vec<NamedCount>,
    pub venues: Vec<NamedCount>,
}

// ── Names ───────────────────────────────────────────────────

/// Lower case, without accents or punctuation, single spaces: "Alperín, J.-P." → "alperin j p".
pub fn name_key(text: &str) -> String {
    let folded: String = text
        .nfkd()
        .filter(|c| !is_combining_mark(*c))
        .flat_map(char::to_lowercase)
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A creator's name as shown ("Given Family", or the literal name) and its parts.
pub(crate) fn creator_name(c: &Creator) -> Option<(String, Option<String>, Option<String>)> {
    let clean = |v: &Option<String>| v.as_deref().map(str::trim).filter(|v| !v.is_empty()).map(String::from);
    let (family, given, literal) = (clean(&c.family), clean(&c.given), clean(&c.literal));
    if let Some(literal) = literal {
        return Some((literal, family, given));
    }
    let name = [given.as_deref(), family.as_deref()].into_iter().flatten().collect::<Vec<_>>().join(" ");
    (!name.is_empty()).then_some((name, family, given))
}

/// Splits "Jason R Priem" into family "Priem" and given "Jason R".
pub(crate) fn split_name(name: &str) -> (Option<String>, Option<String>) {
    let name = name.trim();
    if let Some((family, given)) = name.split_once(',') {
        return (Some(family.trim().to_string()).filter(|f| !f.is_empty()), Some(given.trim().to_string()).filter(|g| !g.is_empty()));
    }
    match name.rsplit_once(' ') {
        Some((given, family)) => (Some(family.to_string()), Some(given.trim().to_string()).filter(|g| !g.is_empty())),
        None => (Some(name.to_string()).filter(|f| !f.is_empty()), None),
    }
}

fn family_key(name_key: &str, family: Option<&str>) -> String {
    family.map(self::name_key).filter(|f| !f.is_empty()).unwrap_or_else(|| name_key.rsplit(' ').next().unwrap_or("").to_string())
}

/// The given names of a key, once the family name is taken off.
fn given_tokens<'a>(name_key: &'a str, family_key: &str) -> Vec<&'a str> {
    let rest = name_key.strip_suffix(family_key).or_else(|| name_key.strip_prefix(family_key)).unwrap_or(name_key);
    rest.split_whitespace().collect()
}

/// Could two spellings with the same family name be one person? "J. Priem", "Jason Priem"
/// and "Jason R Priem" can; "Jason Priem" and "Jane Priem" cannot.
fn given_compatible(a: &[&str], b: &[&str]) -> bool {
    if a.is_empty() || b.is_empty() {
        return true;
    }
    a.iter().zip(b).all(|(x, y)| {
        x == y || (x.chars().count() == 1 && y.starts_with(*x)) || (y.chars().count() == 1 && x.starts_with(*y))
    })
}

pub(crate) fn bare_orcid(value: &str) -> Option<String> {
    let id = value.trim().trim_end_matches('/').rsplit('/').next()?.to_ascii_uppercase();
    (id.len() == 19 && id.chars().filter(|c| *c == '-').count() == 3).then_some(id)
}

/// OpenAlex's short id from a URL: https://openalex.org/A123 → A123.
pub(crate) fn short_id(value: &str) -> String {
    value.trim().trim_end_matches('/').rsplit('/').next().unwrap_or("").to_string()
}

// ── People ──────────────────────────────────────────────────

/// A person found by name: one with no identifiers and this exact spelling, or one whose
/// spelling the user confirmed by merging.
fn find_by_name(db: &Connection, key: &str) -> Result<Option<String>> {
    db.query_row(
        "SELECT id FROM (
           SELECT p.id, 0 o FROM people p WHERE p.name_key = ?1 AND p.orcid IS NULL AND p.openalex_id IS NULL
           UNION ALL SELECT n.person_id, 1 FROM person_names n WHERE n.name_key = ?1 AND n.confirmed = 1)
         ORDER BY o LIMIT 1",
        [key],
        |r| r.get(0),
    )
    .optional()
    .map_err(e)
}

pub(crate) fn create_person(db: &Connection, name: &str, family: Option<&str>, given: Option<&str>) -> Result<String> {
    let id = new_id();
    let key = name_key(name);
    let now = now_ms();
    db.execute(
        "INSERT INTO people(id, name, family, given, name_key, family_key, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
        params![id, name, family, given, key, family_key(&key, family), now],
    )
    .map_err(e)?;
    Ok(id)
}

/// Removes a person nothing points at any more: no source names them and no note links them.
pub(crate) fn prune_person(db: &Connection, id: &str) -> Result<()> {
    db.execute(
        "DELETE FROM people WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM source_people WHERE person_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM links WHERE to_kind = 'person' AND to_id = ?1)",
        [id],
    )
    .map(|_| ())
    .map_err(e)
}

/// Links a source's creators to people, position by position (see the module comment).
pub(crate) fn sync_people(db: &Connection, source_id: &str, suggest: bool) -> Result<()> {
    let creators: Option<String> = db.query_row("SELECT creators FROM sources WHERE id = ?", [source_id], |r| r.get(0)).optional().map_err(e)?;
    let creators: Vec<Creator> = creators.and_then(|c| serde_json::from_str(&c).ok()).unwrap_or_default();
    let mut existing: HashMap<i64, (String, String)> = HashMap::new();
    {
        let mut statement = db.prepare("SELECT position, person_id, name_key FROM source_people WHERE source_id = ?").map_err(e)?;
        for row in statement.query_map([source_id], |r| Ok((r.get::<_, i64>(0)?, (r.get(1)?, r.get(2)?)))).map_err(e)? {
            let (position, value) = row.map_err(e)?;
            existing.insert(position, value);
        }
    }
    let mut released = Vec::new();
    let mut created = Vec::new();
    for (position, creator) in creators.iter().enumerate() {
        let position = position as i64;
        let current = existing.remove(&position);
        let Some((name, family, given)) = creator_name(creator) else {
            if let Some((person, _)) = current {
                db.execute("DELETE FROM source_people WHERE source_id = ?1 AND position = ?2", params![source_id, position]).map_err(e)?;
                released.push(person);
            }
            continue;
        };
        let key = name_key(&name);
        match current {
            Some((_, current_key)) if current_key == key => {
                db.execute(
                    "UPDATE source_people SET name = ?3, role = ?4 WHERE source_id = ?1 AND position = ?2",
                    params![source_id, position, name, creator.role],
                )
                .map_err(e)?;
            }
            current => {
                if let Some((person, _)) = current {
                    db.execute("DELETE FROM source_people WHERE source_id = ?1 AND position = ?2", params![source_id, position]).map_err(e)?;
                    released.push(person);
                }
                let person = match find_by_name(db, &key)? {
                    Some(person) => person,
                    None => {
                        let person = create_person(db, &name, family.as_deref(), given.as_deref())?;
                        created.push(person.clone());
                        person
                    }
                };
                db.execute(
                    "INSERT INTO source_people(source_id, position, person_id, role, name, name_key) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![source_id, position, person, creator.role, name, key],
                )
                .map_err(e)?;
            }
        }
    }
    for (position, (person, _)) in existing {
        db.execute("DELETE FROM source_people WHERE source_id = ?1 AND position = ?2", params![source_id, position]).map_err(e)?;
        released.push(person);
    }
    for person in released {
        prune_person(db, &person)?;
    }
    if suggest {
        for person in created {
            suggest_for(db, &person)?;
        }
    }
    Ok(())
}

struct Candidate {
    id: String,
    name_key: String,
    family_key: String,
    orcid: Option<String>,
    openalex_id: Option<String>,
    sources: i64,
    created_at: i64,
}

fn candidates(db: &Connection, family: Option<&str>) -> Result<Vec<Candidate>> {
    let mut statement = db
        .prepare(
            "SELECT p.id, p.name_key, p.family_key, p.orcid, p.openalex_id, (SELECT count(*) FROM source_people sp WHERE sp.person_id = p.id), p.created_at
             FROM people p WHERE ?1 IS NULL OR p.family_key = ?1",
        )
        .map_err(e)?;
    statement
        .query_map([family], |r| {
            Ok(Candidate { id: r.get(0)?, name_key: r.get(1)?, family_key: r.get(2)?, orcid: r.get(3)?, openalex_id: r.get(4)?, sources: r.get(5)?, created_at: r.get(6)? })
        })
        .map_err(e)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(e)
}

/// Why two people might be one, or None when they cannot be (different identifiers, or
/// they wrote a source together).
fn merge_reason(db: &Connection, a: &Candidate, b: &Candidate) -> Result<Option<String>> {
    if a.id == b.id || a.family_key.is_empty() || a.family_key != b.family_key {
        return Ok(None);
    }
    let differ = |x: &Option<String>, y: &Option<String>| matches!((x, y), (Some(x), Some(y)) if x != y);
    if differ(&a.orcid, &b.orcid) || differ(&a.openalex_id, &b.openalex_id) {
        return Ok(None);
    }
    if !given_compatible(&given_tokens(&a.name_key, &a.family_key), &given_tokens(&b.name_key, &b.family_key)) {
        return Ok(None);
    }
    let together: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM source_people x JOIN source_people y ON y.source_id = x.source_id WHERE x.person_id = ?1 AND y.person_id = ?2)",
            params![a.id, b.id],
            |r| r.get(0),
        )
        .map_err(e)?;
    if together {
        return Ok(None);
    }
    Ok(Some(if a.name_key == b.name_key { "Same name".into() } else { "Similar name".into() }))
}

fn record_suggestion(db: &Connection, a: &Candidate, b: &Candidate, reason: &str) -> Result<()> {
    // Keep the identified one, else the one with more sources, else the older.
    let identified = |c: &Candidate| c.orcid.is_some() || c.openalex_id.is_some();
    let a_first = (identified(a), a.sources, -a.created_at) >= (identified(b), b.sources, -b.created_at);
    let (keep, other) = if a_first { (a, b) } else { (b, a) };
    db.execute(
        "INSERT INTO person_merge_suggestions(person_id, other_id, reason, created_at)
         SELECT ?1, ?2, ?3, ?4 WHERE NOT EXISTS (
           SELECT 1 FROM person_merge_suggestions WHERE (person_id = ?1 AND other_id = ?2) OR (person_id = ?2 AND other_id = ?1))",
        params![keep.id, other.id, reason, now_ms()],
    )
    .map(|_| ())
    .map_err(e)
}

/// Suggests merges between one person and the others with their family name.
pub(crate) fn suggest_for(db: &Connection, person_id: &str) -> Result<()> {
    let family: Option<String> = db.query_row("SELECT family_key FROM people WHERE id = ?", [person_id], |r| r.get(0)).optional().map_err(e)?;
    let Some(family) = family.filter(|f| !f.is_empty()) else { return Ok(()) };
    let all = candidates(db, Some(&family))?;
    let Some(me) = all.iter().find(|c| c.id == person_id) else { return Ok(()) };
    for other in all.iter().take(400) {
        if let Some(reason) = merge_reason(db, me, other)? {
            record_suggestion(db, me, other, &reason)?;
        }
    }
    Ok(())
}

/// Suggests merges across the whole library (after the backfill).
pub(crate) fn suggest_all(db: &Connection) -> Result<()> {
    let mut groups: HashMap<String, Vec<Candidate>> = HashMap::new();
    for candidate in candidates(db, None)? {
        groups.entry(candidate.family_key.clone()).or_default().push(candidate);
    }
    for group in groups.values().filter(|g| g.len() > 1 && g.len() <= 200) {
        for (i, a) in group.iter().enumerate() {
            for b in &group[i + 1..] {
                if let Some(reason) = merge_reason(db, a, b)? {
                    record_suggestion(db, a, b, &reason)?;
                }
            }
        }
    }
    Ok(())
}

// ── Venues and publishers ───────────────────────────────────

fn first_issn(text: Option<&str>) -> Option<String> {
    text?.split(|c: char| !(c.is_ascii_alphanumeric() || c == '-')).find_map(|token| {
        let token = token.trim().to_ascii_uppercase();
        (token.len() == 9 && token.as_bytes()[4] == b'-').then_some(token)
    })
}

pub(crate) fn find_venue(db: &Connection, key: &str, issn: Option<&str>) -> Result<Option<String>> {
    db.query_row(
        "SELECT id FROM venues WHERE name_key = ?1
           OR (?2 IS NOT NULL AND (issn_l = ?2 OR EXISTS (SELECT 1 FROM json_each(venues.issns) WHERE value = ?2)))
         ORDER BY name_key = ?1 DESC, openalex_id IS NOT NULL DESC LIMIT 1",
        params![key, issn],
        |r| r.get(0),
    )
    .optional()
    .map_err(e)
}

pub(crate) fn find_or_create_publisher(db: &Connection, name: &str) -> Result<Option<String>> {
    let key = name_key(name);
    if key.is_empty() {
        return Ok(None);
    }
    if let Some(id) = db.query_row("SELECT id FROM publishers WHERE name_key = ? LIMIT 1", [&key], |r| r.get(0)).optional().map_err(e)? {
        return Ok(Some(id));
    }
    let id = new_id();
    db.execute("INSERT INTO publishers(id, name, name_key) VALUES (?1, ?2, ?3)", params![id, name.trim(), key]).map_err(e)?;
    Ok(Some(id))
}

fn prune_venue(db: &Connection, id: &str) -> Result<()> {
    db.execute(
        "DELETE FROM venues WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM sources WHERE venue_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM links WHERE to_kind = 'venue' AND to_id = ?1)",
        [id],
    )
    .map(|_| ())
    .map_err(e)
}

fn prune_publisher(db: &Connection, id: &str) -> Result<()> {
    db.execute(
        "DELETE FROM publishers WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM sources WHERE publisher_id = ?1)
           AND NOT EXISTS (SELECT 1 FROM venues WHERE publisher_id = ?1)",
        [id],
    )
    .map(|_| ())
    .map_err(e)
}

/// Links a source's container title (and ISSN) to a venue and its publisher text to a
/// publisher, creating them when the library has none by that name.
pub(crate) fn sync_venue(db: &Connection, source_id: &str) -> Result<()> {
    let row: Option<(Option<String>, Option<String>, Option<String>, Option<String>, Option<String>)> = db
        .query_row(
            "SELECT container_title, issn, publisher, venue_id, publisher_id FROM sources WHERE id = ?",
            [source_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)),
        )
        .optional()
        .map_err(e)?;
    let Some((container, issn, publisher, old_venue, old_publisher)) = row else { return Ok(()) };
    let container = container.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
    let venue = match &container {
        Some(name) => {
            let key = name_key(name);
            let issn = first_issn(issn.as_deref());
            match find_venue(db, &key, issn.as_deref())? {
                Some(id) => Some(id),
                None => {
                    let id = new_id();
                    db.execute(
                        "INSERT INTO venues(id, name, name_key, issn_l, issns) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![id, name, key, issn, serde_json::to_string(&issn.iter().collect::<Vec<_>>()).map_err(e)?],
                    )
                    .map_err(e)?;
                    Some(id)
                }
            }
        }
        None => None,
    };
    let publisher = match publisher.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(name) => find_or_create_publisher(db, name)?,
        None => None,
    };
    db.execute("UPDATE sources SET venue_id = ?2, publisher_id = ?3 WHERE id = ?1", params![source_id, venue, publisher]).map_err(e)?;
    if let Some(old) = old_venue.filter(|old| Some(old) != venue.as_ref()) {
        prune_venue(db, &old)?;
    }
    if let Some(old) = old_publisher.filter(|old| Some(old) != publisher.as_ref()) {
        prune_publisher(db, &old)?;
    }
    Ok(())
}

/// After sources are deleted: people, venues and publishers nothing points at any more.
pub(crate) fn prune_orphans(db: &Connection) -> Result<()> {
    db.execute_batch(
        "DELETE FROM people WHERE NOT EXISTS (SELECT 1 FROM source_people WHERE person_id = people.id)
           AND NOT EXISTS (SELECT 1 FROM links WHERE to_kind = 'person' AND to_id = people.id);
         DELETE FROM venues WHERE NOT EXISTS (SELECT 1 FROM sources WHERE venue_id = venues.id)
           AND NOT EXISTS (SELECT 1 FROM links WHERE to_kind = 'venue' AND to_id = venues.id);
         DELETE FROM publishers WHERE NOT EXISTS (SELECT 1 FROM sources WHERE publisher_id = publishers.id)
           AND NOT EXISTS (SELECT 1 FROM venues WHERE publisher_id = publishers.id);",
    )
    .map_err(e)
}

/// Migration 010: every existing source's creators and container linked, then merges suggested.
pub(crate) fn backfill(db: &Connection) -> Result<()> {
    let ids: Vec<String> = {
        let mut statement = db.prepare("SELECT id FROM sources ORDER BY added_at").map_err(e)?;
        let rows = statement.query_map([], |r| r.get(0)).map_err(e)?;
        rows.collect::<std::result::Result<_, _>>().map_err(e)?
    };
    for id in &ids {
        sync_people(db, id, false)?;
        sync_venue(db, id)?;
    }
    db.execute(
        "UPDATE sources SET enrich_status = 'pending' WHERE trashed_at IS NULL AND coalesce(nullif(doi, ''), nullif(pmid, ''), nullif(openalex_id, '')) IS NOT NULL",
        [],
    )
    .map_err(e)?;
    suggest_all(db)
}

// ── Reading ─────────────────────────────────────────────────

const PERSON_COLUMNS: &str = "p.id, p.name, p.family, p.given, p.orcid, p.openalex_id, p.works_count, p.cited_by_count, p.h_index, p.i10_index, p.metrics_at,
    i.id, i.name, i.ror, i.openalex_id, i.country, i.type,
    (SELECT count(DISTINCT sp.source_id) FROM source_people sp JOIN sources s ON s.id = sp.source_id WHERE sp.person_id = p.id AND s.trashed_at IS NULL)";

fn read_person(db: &Connection, r: &rusqlite::Row) -> rusqlite::Result<Person> {
    let id: String = r.get(0)?;
    let institution = r.get::<_, Option<String>>(11)?.map(|iid| -> rusqlite::Result<Institution> {
        Ok(Institution { id: iid, name: r.get(12)?, ror: r.get(13)?, openalex_id: r.get(14)?, country: r.get(15)?, kind: r.get(16)? })
    });
    let name: String = r.get(1)?;
    let mut names: Vec<String> = Vec::new();
    {
        let mut statement = db.prepare_cached("SELECT name FROM person_names WHERE person_id = ? ORDER BY confirmed DESC, name").ok();
        if let Some(statement) = statement.as_mut() {
            if let Ok(rows) = statement.query_map([&id], |r| r.get::<_, String>(0)) {
                names.extend(rows.flatten());
            }
        }
        let mut printed = db.prepare_cached("SELECT DISTINCT name FROM source_people WHERE person_id = ?").ok();
        if let Some(statement) = printed.as_mut() {
            if let Ok(rows) = statement.query_map([&id], |r| r.get::<_, String>(0)) {
                names.extend(rows.flatten());
            }
        }
    }
    let mut seen = HashSet::from([name_key(&name)]);
    names.retain(|n| seen.insert(name_key(n)));
    Ok(Person {
        id,
        name,
        family: r.get(2)?,
        given: r.get(3)?,
        orcid: r.get(4)?,
        openalex_id: r.get(5)?,
        works_count: r.get(6)?,
        cited_by_count: r.get(7)?,
        h_index: r.get(8)?,
        i10_index: r.get(9)?,
        metrics_at: r.get(10)?,
        institution: institution.transpose()?,
        names,
        source_count: r.get(17)?,
    })
}

pub(crate) fn person_on(db: &Connection, id: &str) -> Result<Option<Person>> {
    db.query_row(
        &format!("SELECT {PERSON_COLUMNS} FROM people p LEFT JOIN institutions i ON i.id = p.institution_id WHERE p.id = ?"),
        [id],
        |r| read_person(db, r),
    )
    .optional()
    .map_err(e)
}

const VENUE_COLUMNS: &str = "v.id, v.name, v.issn_l, v.issns, v.type, v.openalex_id, v.homepage, v.is_oa, v.in_doaj, v.works_count, v.cited_by_count, v.h_index, v.metrics_at,
    b.id, b.name, b.openalex_id,
    (SELECT count(*) FROM sources s WHERE s.venue_id = v.id AND s.trashed_at IS NULL)";

fn read_venue(r: &rusqlite::Row) -> rusqlite::Result<Venue> {
    let publisher = r.get::<_, Option<String>>(13)?.map(|id| -> rusqlite::Result<Publisher> { Ok(Publisher { id, name: r.get(14)?, openalex_id: r.get(15)? }) });
    Ok(Venue {
        id: r.get(0)?,
        name: r.get(1)?,
        issn_l: r.get(2)?,
        issns: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or_default(),
        kind: r.get(4)?,
        openalex_id: r.get(5)?,
        homepage: r.get(6)?,
        is_oa: r.get::<_, Option<i64>>(7)?.map(|v| v != 0),
        in_doaj: r.get::<_, Option<i64>>(8)?.map(|v| v != 0),
        works_count: r.get(9)?,
        cited_by_count: r.get(10)?,
        h_index: r.get(11)?,
        metrics_at: r.get(12)?,
        publisher: publisher.transpose()?,
        source_count: r.get(16)?,
    })
}

pub(crate) fn venue_on(db: &Connection, id: &str) -> Result<Option<Venue>> {
    db.query_row(
        &format!("SELECT {VENUE_COLUMNS} FROM venues v LEFT JOIN publishers b ON b.id = v.publisher_id WHERE v.id = ?"),
        [id],
        read_venue,
    )
    .optional()
    .map_err(e)
}

/// A topic's ancestors, domain first.
fn topic_path(db: &Connection, id: &str) -> Result<Vec<TopicRef>> {
    let mut statement = db
        .prepare_cached(
            "WITH RECURSIVE up(id, depth) AS (SELECT parent_id, 1 FROM topics WHERE id = ?1
               UNION ALL SELECT t.parent_id, up.depth + 1 FROM topics t JOIN up ON t.id = up.id WHERE t.parent_id IS NOT NULL)
             SELECT t.id, t.name, t.level FROM up JOIN topics t ON t.id = up.id ORDER BY up.depth DESC",
        )
        .map_err(e)?;
    statement
        .query_map([id], |r| Ok(TopicRef { id: r.get(0)?, name: r.get(1)?, level: r.get(2)? }))
        .map_err(e)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(e)
}

/// Sources under a topic or any narrower one (a field includes its subfields' topics).
pub(crate) const TOPIC_SOURCES: &str = "SELECT st.source_id FROM source_topics st WHERE st.topic_id IN (
    WITH RECURSIVE down(id) AS (SELECT ?1 UNION ALL SELECT t.id FROM topics t JOIN down ON t.parent_id = down.id) SELECT id FROM down)";

fn counted(db: &Connection, sql: &str, id: &str) -> Result<Vec<NamedCount>> {
    let mut statement = db.prepare(sql).map_err(e)?;
    statement
        .query_map([id], |r| Ok(NamedCount { id: r.get(0)?, name: r.get(1)?, count: r.get(2)? }))
        .map_err(e)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(e)
}

fn years(db: &Connection, sql: &str, id: &str) -> Result<(Option<i64>, Option<i64>)> {
    db.query_row(&format!("SELECT min(s.year), max(s.year) FROM sources s WHERE s.trashed_at IS NULL AND s.id IN ({sql})"), [id], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(e)
}

impl Store {
    pub fn person(&self, id: &str) -> Result<Option<Person>> {
        person_on(&*self.read()?, id)
    }

    pub fn venue(&self, id: &str) -> Result<Option<Venue>> {
        venue_on(&*self.read()?, id)
    }

    pub fn topic(&self, id: &str) -> Result<Option<Topic>> {
        let db = self.read()?;
        let row: Option<(String, String, String)> = db
            .query_row("SELECT id, name, level FROM topics WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .optional()
            .map_err(e)?;
        let Some((id, name, level)) = row else { return Ok(None) };
        let source_count: i64 = db
            .query_row(&format!("SELECT count(DISTINCT s.id) FROM sources s WHERE s.trashed_at IS NULL AND s.id IN ({TOPIC_SOURCES})"), [&id], |r| r.get(0))
            .map_err(e)?;
        Ok(Some(Topic { path: topic_path(&db, &id)?, id, name, level, source_count }))
    }

    /// A person with what the library connects to them: co-authors, venues and topics of
    /// their sources, the years they span, and possible duplicates to review.
    pub fn person_page(&self, id: &str) -> Result<Option<PersonPage>> {
        let db = self.read()?;
        let Some(person) = person_on(&db, id)? else { return Ok(None) };
        let mine = "SELECT sp.source_id FROM source_people sp WHERE sp.person_id = ?1";
        let coauthors = counted(
            &db,
            &format!(
                "SELECT p.id, p.name, count(DISTINCT sp.source_id) n FROM source_people sp JOIN people p ON p.id = sp.person_id JOIN sources s ON s.id = sp.source_id
                 WHERE sp.source_id IN ({mine}) AND sp.person_id <> ?1 AND s.trashed_at IS NULL GROUP BY p.id ORDER BY n DESC, p.name LIMIT 24"
            ),
            id,
        )?;
        let venues = counted(
            &db,
            &format!(
                "SELECT v.id, v.name, count(*) n FROM sources s JOIN venues v ON v.id = s.venue_id
                 WHERE s.id IN ({mine}) AND s.trashed_at IS NULL GROUP BY v.id ORDER BY n DESC, v.name LIMIT 12"
            ),
            id,
        )?;
        let topics = counted(
            &db,
            &format!(
                "SELECT t.id, t.name, count(DISTINCT st.source_id) n FROM source_topics st JOIN topics t ON t.id = st.topic_id JOIN sources s ON s.id = st.source_id
                 WHERE st.source_id IN ({mine}) AND s.trashed_at IS NULL GROUP BY t.id ORDER BY n DESC, max(st.score) DESC LIMIT 12"
            ),
            id,
        )?;
        let (first_year, last_year) = years(&db, mine, id)?;
        drop(db);
        let suggestions = self.merge_suggestions()?.into_iter().filter(|s| s.person.id == id || s.other.id == id).collect();
        Ok(Some(PersonPage { person, coauthors, venues, topics, first_year, last_year, suggestions }))
    }

    pub fn venue_page(&self, id: &str) -> Result<Option<VenuePage>> {
        let db = self.read()?;
        let Some(venue) = venue_on(&db, id)? else { return Ok(None) };
        let mine = "SELECT s.id FROM sources s WHERE s.venue_id = ?1";
        let people = counted(
            &db,
            &format!(
                "SELECT p.id, p.name, count(DISTINCT sp.source_id) n FROM source_people sp JOIN people p ON p.id = sp.person_id JOIN sources s ON s.id = sp.source_id
                 WHERE sp.source_id IN ({mine}) AND s.trashed_at IS NULL GROUP BY p.id ORDER BY n DESC, p.name LIMIT 24"
            ),
            id,
        )?;
        let topics = counted(
            &db,
            &format!(
                "SELECT t.id, t.name, count(DISTINCT st.source_id) n FROM source_topics st JOIN topics t ON t.id = st.topic_id JOIN sources s ON s.id = st.source_id
                 WHERE st.source_id IN ({mine}) AND s.trashed_at IS NULL GROUP BY t.id ORDER BY n DESC LIMIT 12"
            ),
            id,
        )?;
        let (first_year, last_year) = years(&db, mine, id)?;
        Ok(Some(VenuePage { venue, people, topics, first_year, last_year }))
    }

    pub fn topic_page(&self, id: &str) -> Result<Option<TopicPage>> {
        let Some(topic) = self.topic(id)? else { return Ok(None) };
        let db = self.read()?;
        let mut children = Vec::new();
        {
            let mut statement = db.prepare("SELECT id, name FROM topics WHERE parent_id = ? ORDER BY name").map_err(e)?;
            let rows: Vec<(String, String)> = statement.query_map([id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<std::result::Result<_, _>>().map_err(e)?;
            for (child, name) in rows {
                let count: i64 = db
                    .query_row(&format!("SELECT count(DISTINCT s.id) FROM sources s WHERE s.trashed_at IS NULL AND s.id IN ({TOPIC_SOURCES})"), [&child], |r| r.get(0))
                    .map_err(e)?;
                if count > 0 {
                    children.push(NamedCount { id: child, name, count });
                }
            }
            children.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.name.cmp(&b.name)));
        }
        let people = counted(
            &db,
            &format!(
                "SELECT p.id, p.name, count(DISTINCT sp.source_id) n FROM source_people sp JOIN people p ON p.id = sp.person_id JOIN sources s ON s.id = sp.source_id
                 WHERE sp.source_id IN ({TOPIC_SOURCES}) AND s.trashed_at IS NULL GROUP BY p.id ORDER BY n DESC, p.name LIMIT 24"
            ),
            id,
        )?;
        let venues = counted(
            &db,
            &format!(
                "SELECT v.id, v.name, count(*) n FROM sources s JOIN venues v ON v.id = s.venue_id
                 WHERE s.id IN ({TOPIC_SOURCES}) AND s.trashed_at IS NULL GROUP BY v.id ORDER BY n DESC, v.name LIMIT 12"
            ),
            id,
        )?;
        Ok(Some(TopicPage { topic, children, people, venues }))
    }

    /// Who wrote a source, where it appeared, what it is about, who funded it, what it
    /// cites (its PDF's bibliography and OpenAlex's list, as one) and what cites it.
    pub fn source_graph(&self, id: &str) -> Result<SourceGraph> {
        let db = self.read()?;
        let mut graph = SourceGraph::default();
        {
            let mut statement = db
                .prepare(
                    "SELECT sp.position, sp.person_id, sp.name, sp.role, sp.corresponding, p.orcid, p.openalex_id FROM source_people sp
                     JOIN people p ON p.id = sp.person_id WHERE sp.source_id = ? ORDER BY sp.position",
                )
                .map_err(e)?;
            let rows = statement
                .query_map([id], |r| {
                    Ok(SourcePerson {
                        position: r.get(0)?,
                        person_id: r.get(1)?,
                        name: r.get(2)?,
                        role: r.get(3)?,
                        corresponding: r.get::<_, i64>(4)? != 0,
                        orcid: r.get(5)?,
                        openalex_id: r.get(6)?,
                        institutions: Vec::new(),
                    })
                })
                .map_err(e)?;
            graph.people = rows.collect::<std::result::Result<_, _>>().map_err(e)?;
            let mut institutions = db
                .prepare(
                    "SELECT i.id, i.name, i.ror, i.openalex_id, i.country, i.type FROM source_person_institutions x JOIN institutions i ON i.id = x.institution_id
                     WHERE x.source_id = ? AND x.position = ? ORDER BY i.name",
                )
                .map_err(e)?;
            for person in &mut graph.people {
                let rows = institutions
                    .query_map(params![id, person.position], |r| {
                        Ok(Institution { id: r.get(0)?, name: r.get(1)?, ror: r.get(2)?, openalex_id: r.get(3)?, country: r.get(4)?, kind: r.get(5)? })
                    })
                    .map_err(e)?;
                person.institutions = rows.collect::<std::result::Result<_, _>>().map_err(e)?;
            }
        }
        let (venue, publisher): (Option<String>, Option<String>) =
            db.query_row("SELECT venue_id, publisher_id FROM sources WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(e)?.unwrap_or_default();
        if let Some(venue) = venue {
            graph.venue = venue_on(&db, &venue)?;
        }
        if let Some(publisher) = publisher {
            graph.publisher = db
                .query_row("SELECT id, name, openalex_id FROM publishers WHERE id = ?", [&publisher], |r| Ok(Publisher { id: r.get(0)?, name: r.get(1)?, openalex_id: r.get(2)? }))
                .optional()
                .map_err(e)?;
        }
        {
            let mut statement = db
                .prepare("SELECT t.id, t.name, st.score, st.is_primary FROM source_topics st JOIN topics t ON t.id = st.topic_id WHERE st.source_id = ? ORDER BY st.is_primary DESC, st.score DESC")
                .map_err(e)?;
            let rows = statement
                .query_map([id], |r| Ok(SourceTopic { id: r.get(0)?, name: r.get(1)?, score: r.get(2)?, primary: r.get::<_, i64>(3)? != 0, path: Vec::new() }))
                .map_err(e)?;
            graph.topics = rows.collect::<std::result::Result<_, _>>().map_err(e)?;
            for topic in &mut graph.topics {
                topic.path = topic_path(&db, &topic.id)?;
            }
        }
        {
            let mut statement = db
                .prepare("SELECT k.id, k.name, sk.score FROM source_keywords sk JOIN keywords k ON k.id = sk.keyword_id WHERE sk.source_id = ? ORDER BY sk.score DESC, k.name")
                .map_err(e)?;
            let rows = statement.query_map([id], |r| Ok(Keyword { id: r.get(0)?, name: r.get(1)?, score: r.get(2)? })).map_err(e)?;
            graph.keywords = rows.collect::<std::result::Result<_, _>>().map_err(e)?;
        }
        {
            let mut statement = db
                .prepare("SELECT f.id, f.name, nullif(g.award_id, ''), g.title FROM source_grants g JOIN funders f ON f.id = g.funder_id WHERE g.source_id = ? ORDER BY f.name, g.award_id")
                .map_err(e)?;
            let rows = statement.query_map([id], |r| Ok(Grant { funder_id: r.get(0)?, funder: r.get(1)?, award_id: r.get(2)?, title: r.get(3)? })).map_err(e)?;
            graph.grants = rows.collect::<std::result::Result<_, _>>().map_err(e)?;
        }
        graph.references = work_references(&db, id)?;
        {
            let mut statement = db
                .prepare(
                    "SELECT s.id, s.title, s.year FROM sources s WHERE s.trashed_at IS NULL AND s.id <> ?1 AND s.id IN (
                       SELECT source_id FROM source_cites WHERE matched_source_id = ?1
                       UNION SELECT source_id FROM source_references WHERE matched_source_id = ?1)
                     ORDER BY s.year DESC, s.title COLLATE NOCASE",
                )
                .map_err(e)?;
            let rows = statement.query_map([id], |r| Ok(CitingSource { id: r.get(0)?, title: r.get(1)?, year: r.get(2)? })).map_err(e)?;
            graph.cited_by = rows.collect::<std::result::Result<_, _>>().map_err(e)?;
        }
        Ok(graph)
    }

    // ── Merges ──────────────────────────────────────────────

    /// Possible duplicates the user has not answered yet.
    pub fn merge_suggestions(&self) -> Result<Vec<MergeSuggestion>> {
        let db = self.read()?;
        let pairs: Vec<(String, String, String)> = {
            let mut statement = db
                .prepare("SELECT person_id, other_id, reason FROM person_merge_suggestions WHERE dismissed_at IS NULL ORDER BY created_at, person_id")
                .map_err(e)?;
            let rows = statement.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).map_err(e)?;
            rows.collect::<std::result::Result<_, _>>().map_err(e)?
        };
        let mut out = Vec::new();
        for (person, other, reason) in pairs {
            if let (Some(person), Some(other)) = (person_on(&db, &person)?, person_on(&db, &other)?) {
                out.push(MergeSuggestion { person, other, reason });
            }
        }
        Ok(out)
    }

    /// "Not the same person": the pair is not suggested again.
    pub fn dismiss_merge(&self, person_id: &str, other_id: &str) -> Result<()> {
        self.db()?
            .execute(
                "UPDATE person_merge_suggestions SET dismissed_at = ?3 WHERE (person_id = ?1 AND other_id = ?2) OR (person_id = ?2 AND other_id = ?1)",
                params![person_id, other_id, now_ms()],
            )
            .map(|_| ())
            .map_err(e)
    }

    /// Folds `other` into `keep`: its sources, spellings (confirmed, so the same spelling on
    /// a later source joins `keep`), identifiers `keep` lacks and links to it. Returns `keep`.
    pub fn merge_people(&self, keep: &str, other: &str) -> Result<Person> {
        {
            let db = self.db()?;
            let tx = db.unchecked_transaction().map_err(e)?;
            merge_on(&tx, keep, other)?;
            tx.commit().map_err(e)?;
        }
        self.person(keep)?.ok_or_else(|| "Person not found".into())
    }

    /// People, venues and topics whose name matches, for the link picker and Open Quickly.
    pub(crate) fn graph_targets(db: &Connection, pattern: &str, kind: &str, limit: i64) -> Result<Vec<(String, String, Option<String>)>> {
        let sql = match kind {
            PERSON => {
                "SELECT p.id, p.name, (SELECT i.name FROM institutions i WHERE i.id = p.institution_id) FROM people p
                 WHERE p.name LIKE ?1 ESCAPE '\\' OR EXISTS (SELECT 1 FROM person_names n WHERE n.person_id = p.id AND n.name LIKE ?1 ESCAPE '\\')
                 ORDER BY (SELECT count(*) FROM source_people sp WHERE sp.person_id = p.id) DESC, p.name LIMIT ?2"
            }
            VENUE => {
                "SELECT v.id, v.name, v.type FROM venues v WHERE v.name LIKE ?1 ESCAPE '\\'
                 ORDER BY (SELECT count(*) FROM sources s WHERE s.venue_id = v.id) DESC, v.name LIMIT ?2"
            }
            _ => {
                "SELECT t.id, t.name, t.level FROM topics t WHERE t.name LIKE ?1 ESCAPE '\\'
                 ORDER BY (SELECT count(*) FROM source_topics st WHERE st.topic_id = t.id) DESC, t.name LIMIT ?2"
            }
        };
        let mut statement = db.prepare(sql).map_err(e)?;
        statement
            .query_map(params![pattern, limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .map_err(e)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(e)
    }
}

/// See `Store::merge_people`. Also used when OpenAlex shows two rows are one person.
pub(crate) fn merge_on(tx: &Connection, keep: &str, other: &str) -> Result<()> {
    if keep == other {
        return Err("Choose two different people".into());
    }
    let row = |id: &str| -> Result<Option<(String, Option<String>, Option<String>, Option<String>)>> {
        tx.query_row("SELECT name, orcid, openalex_id, institution_id FROM people WHERE id = ?", [id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .optional()
            .map_err(e)
    };
    let (_, keep_orcid, keep_openalex, _) = row(keep)?.ok_or("Person not found")?;
    let (other_name, other_orcid, other_openalex, other_institution) = row(other)?.ok_or("Person not found")?;
    if matches!((&keep_orcid, &other_orcid), (Some(a), Some(b)) if a != b) || matches!((&keep_openalex, &other_openalex), (Some(a), Some(b)) if a != b) {
        return Err("These two have different identifiers, so they are different people".into());
    }
    let mut spellings: Vec<String> = vec![other_name];
    {
        let mut statement = tx.prepare("SELECT name FROM person_names WHERE person_id = ?1 UNION SELECT name FROM source_people WHERE person_id = ?1").map_err(e)?;
        let rows = statement.query_map([other], |r| r.get::<_, String>(0)).map_err(e)?;
        spellings.extend(rows.collect::<std::result::Result<Vec<_>, _>>().map_err(e)?);
    }
    // Identifiers are unique: take them off `other` before `keep` gets them.
    tx.execute("UPDATE people SET orcid = NULL, openalex_id = NULL WHERE id = ?", [other]).map_err(e)?;
    tx.execute(
        "UPDATE people SET orcid = coalesce(orcid, ?2), openalex_id = coalesce(openalex_id, ?3), institution_id = coalesce(institution_id, ?4), updated_at = ?5 WHERE id = ?1",
        params![keep, other_orcid, other_openalex, other_institution, now_ms()],
    )
    .map_err(e)?;
    tx.execute("UPDATE source_people SET person_id = ?1 WHERE person_id = ?2", params![keep, other]).map_err(e)?;
    for spelling in spellings {
        tx.execute(
            "INSERT INTO person_names(person_id, name, name_key, confirmed) VALUES (?1, ?2, ?3, 1)
             ON CONFLICT(person_id, name_key) DO UPDATE SET confirmed = 1",
            params![keep, spelling, name_key(&spelling)],
        )
        .map_err(e)?;
    }
    tx.execute("UPDATE links SET to_id = ?1 WHERE to_kind = 'person' AND to_id = ?2", params![keep, other]).map_err(e)?;
    tx.execute("UPDATE links SET from_id = ?1 WHERE from_kind = 'person' AND from_id = ?2", params![keep, other]).map_err(e)?;
    tx.execute("DELETE FROM people WHERE id = ?", [other]).map_err(e)?;
    Ok(())
}

/// A source's bibliography: the PDF's entries in their order, then the works OpenAlex lists
/// that none of them already names (matched by DOI or by the library source they point at).
pub(crate) fn work_references(db: &Connection, id: &str) -> Result<Vec<WorkReference>> {
    let mut out: Vec<WorkReference> = Vec::new();
    {
        let mut statement = db
            .prepare("SELECT seq, number, text, metadata, matched_source_id FROM source_references WHERE source_id = ? ORDER BY seq")
            .map_err(e)?;
        let rows = statement
            .query_map([id], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?, r.get::<_, String>(2)?, r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?)))
            .map_err(e)?;
        for row in rows {
            let (seq, number, text, metadata, matched) = row.map_err(e)?;
            let metadata: serde_json::Value = metadata.and_then(|m| serde_json::from_str(&m).ok()).unwrap_or_default();
            let text_of = |key: &str| metadata.get(key).and_then(|v| v.as_str()).map(String::from).filter(|v| !v.is_empty());
            out.push(WorkReference {
                origin: "pdf".into(),
                seq,
                number,
                title: text_of("title"),
                byline: metadata.get("authors").and_then(|a| a.as_array()).map(|a| {
                    let names: Vec<&str> = a.iter().filter_map(|v| v.as_str().or_else(|| v.get("name").and_then(|n| n.as_str()))).collect();
                    byline(&names)
                }),
                year: metadata.get("year").and_then(|y| y.as_i64()),
                container: text_of("journal"),
                doi: text_of("doi").map(|d| bare_doi(&d)),
                openalex_id: None,
                text: Some(text),
                matched_source_id: matched,
            });
        }
    }
    let mut statement = db
        .prepare("SELECT seq, openalex_id, doi, title, byline, year, container, matched_source_id FROM source_cites WHERE source_id = ? ORDER BY seq")
        .map_err(e)?;
    let rows = statement
        .query_map([id], |r| {
            Ok(WorkReference {
                origin: "openalex".into(),
                seq: r.get(0)?,
                number: None,
                openalex_id: r.get(1)?,
                doi: r.get(2)?,
                title: r.get(3)?,
                byline: r.get(4)?,
                year: r.get(5)?,
                container: r.get(6)?,
                text: None,
                matched_source_id: r.get(7)?,
            })
        })
        .map_err(e)?;
    let pdf = out.len();
    for row in rows {
        let mut reference = row.map_err(e)?;
        let same = out[..pdf].iter_mut().find(|p| {
            (p.doi.is_some() && p.doi == reference.doi) || (p.matched_source_id.is_some() && p.matched_source_id == reference.matched_source_id)
        });
        match same {
            // Both name it: the printed entry stays, with what OpenAlex adds.
            Some(printed) => {
                printed.openalex_id = reference.openalex_id.take();
                if printed.matched_source_id.is_none() {
                    printed.matched_source_id = reference.matched_source_id.take();
                }
            }
            None => out.push(reference),
        }
    }
    Ok(out)
}

/// "Piwowar, Priem et al." from display names.
pub(crate) fn byline(names: &[&str]) -> String {
    let family = |n: &&str| split_name(n).0.unwrap_or_else(|| n.to_string());
    match names.len() {
        0 => String::new(),
        1 | 2 => names.iter().map(family).collect::<Vec<_>>().join(", "),
        _ => format!("{}, {} et al.", family(&names[0]), family(&names[1])),
    }
}

pub(crate) fn bare_doi(doi: &str) -> String {
    let doi = doi.trim();
    let lower = doi.to_ascii_lowercase();
    for prefix in ["https://doi.org/", "http://doi.org/", "https://dx.doi.org/", "http://dx.doi.org/", "doi:"] {
        if lower.starts_with(prefix) {
            return lower[prefix.len()..].to_string();
        }
    }
    lower
}

/// Re-links citations to a source that just arrived or gained an identifier, and the citing
/// sources' citation links with them.
pub(crate) fn relink_citations(db: &Connection, source_id: &str) -> Result<()> {
    let (doi, openalex, trashed): (Option<String>, Option<String>, Option<i64>) = match db
        .query_row("SELECT doi, openalex_id, trashed_at FROM sources WHERE id = ?", [source_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .optional()
        .map_err(e)?
    {
        Some(row) => row,
        None => return Ok(()),
    };
    if trashed.is_some() {
        return Ok(());
    }
    let doi = doi.map(|d| bare_doi(&d)).filter(|d| !d.is_empty());
    let citing: Vec<String> = {
        let mut statement = db
            .prepare(
                "SELECT source_id FROM source_cites WHERE matched_source_id IS NULL AND source_id <> ?1 AND (openalex_id = ?2 OR doi = ?3)
                 UNION SELECT source_id FROM source_references WHERE matched_source_id IS NULL AND source_id <> ?1 AND ?3 IS NOT NULL
                   AND lower(json_extract(metadata, '$.doi')) = ?3",
            )
            .map_err(e)?;
        let rows = statement.query_map(params![source_id, openalex, doi], |r| r.get(0)).map_err(e)?;
        rows.collect::<std::result::Result<_, _>>().map_err(e)?
    };
    if citing.is_empty() {
        return Ok(());
    }
    db.execute(
        "UPDATE source_cites SET matched_source_id = ?1 WHERE matched_source_id IS NULL AND source_id <> ?1 AND (openalex_id = ?2 OR doi = ?3)",
        params![source_id, openalex, doi],
    )
    .map_err(e)?;
    if doi.is_some() {
        db.execute(
            "UPDATE source_references SET matched_source_id = ?1 WHERE matched_source_id IS NULL AND source_id <> ?1 AND lower(json_extract(metadata, '$.doi')) = ?2",
            params![source_id, doi],
        )
        .map_err(e)?;
    }
    for citing in citing {
        sync_cite_links(db, &citing)?;
    }
    Ok(())
}

/// A source owns one link per library source it cites (from its PDF's bibliography or
/// OpenAlex's list), so citations show as backlinks like any other link.
pub(crate) fn sync_cite_links(db: &Connection, source_id: &str) -> Result<()> {
    let cited: Vec<String> = {
        let mut statement = db
            .prepare(
                "SELECT DISTINCT matched_source_id FROM (
                   SELECT matched_source_id, seq FROM source_references WHERE source_id = ?1 AND matched_source_id IS NOT NULL
                   UNION ALL SELECT matched_source_id, 100000 + seq FROM source_cites WHERE source_id = ?1 AND matched_source_id IS NOT NULL)
                 WHERE matched_source_id <> ?1",
            )
            .map_err(e)?;
        let rows = statement.query_map([source_id], |r| r.get(0)).map_err(e)?;
        rows.collect::<std::result::Result<_, _>>().map_err(e)?
    };
    let from = links::ItemRef::new(links::SOURCE, source_id, None);
    let inputs: Vec<links::LinkInput> = cited
        .iter()
        .map(|to| links::LinkInput { from: from.clone(), to: links::ItemRef::new(links::SOURCE, to, None), label: None, context: Some("Cites".into()) })
        .collect();
    links::write_links(db, &from, &inputs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_keys_fold_accents_and_punctuation() {
        assert_eq!(name_key("Alperín, J.-P."), "alperin j p");
        assert_eq!(name_key("  Jason  R. Priem "), "jason r priem");
        assert_eq!(split_name("Jason R Priem"), (Some("Priem".into()), Some("Jason R".into())));
        assert_eq!(split_name("Priem, Jason"), (Some("Priem".into()), Some("Jason".into())));
        assert_eq!(bare_orcid("https://orcid.org/0000-0001-6187-6610").as_deref(), Some("0000-0001-6187-6610"));
        assert_eq!(bare_doi("https://doi.org/10.7717/PeerJ.4375"), "10.7717/peerj.4375");
    }

    #[test]
    fn given_names_are_compatible_by_initial() {
        assert!(given_compatible(&["j"], &["jason"]));
        assert!(given_compatible(&["jason"], &["jason", "r"]));
        assert!(given_compatible(&["j", "r"], &["jason", "r"]));
        assert!(!given_compatible(&["jason"], &["jane"]));
        assert!(!given_compatible(&["j", "p"], &["jason", "r"]));
    }
}
