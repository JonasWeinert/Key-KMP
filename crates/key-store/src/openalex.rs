// OpenAlex records written into the library. The host fetches (politely, in the background,
// see key-desktop-host's openalex.rs); this module parses the JSON and stores it in three
// tiers (https://help.openalex.org/data/native/):
//  (a) stored and filterable: identifiers, type, language, date, volume/issue/pages, open
//      access status and link, the retracted flag, topics, keywords, funders and grants;
//  (b) cached with the time they were fetched and refreshed when viewed: citation count and
//      FWCI of a work, works count, citations and h-index of a person or venue;
//  (c) not stored: counts by year and related works, fetched when shown.
// Fields the user already filled are kept; OpenAlex fills the blanks. The deprecated
// "concepts" are not read.
use crate::graph::{self, bare_doi, bare_orcid, byline, name_key, short_id, split_name};
use crate::{Creator, Result, Store, e, new_id, now_ms};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use serde_json::{Value as Json, json};

/// A source to look up, with what it can be looked up by.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnrichJob {
    pub id: String,
    pub doi: Option<String>,
    pub pmid: Option<String>,
    pub openalex_id: Option<String>,
    pub title: Option<String>,
    pub year: Option<i64>,
    pub attempts: i64,
}

fn text(value: &Json, key: &str) -> Option<String> {
    value.get(key).and_then(Json::as_str).map(str::trim).filter(|v| !v.is_empty()).map(String::from)
}

/// The plain abstract from OpenAlex's inverted index.
pub fn abstract_text(index: &Json) -> Option<String> {
    let map = index.as_object()?;
    let mut words: Vec<(i64, &str)> = Vec::new();
    for (word, positions) in map {
        for position in positions.as_array()? {
            words.push((position.as_i64()?, word));
        }
    }
    words.sort_by_key(|(p, _)| *p);
    let text = words.into_iter().map(|(_, w)| w).collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then_some(text)
}

/// D2, F18, S1802 and T13607 from OpenAlex's topic URLs.
fn topic_id(url: &str) -> String {
    let url = url.trim_end_matches('/');
    let id = short_id(url);
    if url.contains("/domains/") {
        format!("D{id}")
    } else if url.contains("/fields/") {
        format!("F{id}")
    } else if url.contains("/subfields/") {
        format!("S{id}")
    } else {
        id
    }
}

fn upsert_institution(db: &Connection, value: &Json) -> Result<Option<String>> {
    let Some(name) = text(value, "display_name") else { return Ok(None) };
    let openalex = text(value, "id").map(|id| short_id(&id));
    let ror = text(value, "ror").map(|r| short_id(&r));
    let existing: Option<String> = db
        .query_row(
            "SELECT id FROM institutions WHERE (?1 IS NOT NULL AND openalex_id = ?1) OR (?2 IS NOT NULL AND ror = ?2) LIMIT 1",
            params![openalex, ror],
            |r| r.get(0),
        )
        .optional()
        .map_err(e)?;
    let id = existing.unwrap_or_else(new_id);
    db.execute(
        "INSERT INTO institutions(id, name, name_key, ror, openalex_id, country, type) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key, ror = coalesce(excluded.ror, ror),
           openalex_id = coalesce(excluded.openalex_id, openalex_id), country = coalesce(excluded.country, country), type = coalesce(excluded.type, type)",
        params![id, name, name_key(&name), ror, openalex, text(value, "country_code"), text(value, "type")],
    )
    .map_err(e)?;
    Ok(Some(id))
}

fn upsert_publisher(db: &Connection, openalex: Option<&str>, name: &str) -> Result<Option<String>> {
    if let Some(openalex) = openalex {
        if let Some(id) = db.query_row("SELECT id FROM publishers WHERE openalex_id = ?", [openalex], |r| r.get::<_, String>(0)).optional().map_err(e)? {
            return Ok(Some(id));
        }
    }
    let Some(id) = graph::find_or_create_publisher(db, name)? else { return Ok(None) };
    if let Some(openalex) = openalex {
        db.execute("UPDATE publishers SET openalex_id = coalesce(openalex_id, ?2) WHERE id = ?1", params![id, openalex]).map_err(e)?;
    }
    Ok(Some(id))
}

/// A venue from OpenAlex's `source` object: found by OpenAlex id, ISSN or name, then
/// given what OpenAlex knows about it.
fn upsert_venue(db: &Connection, value: &Json) -> Result<Option<String>> {
    let Some(name) = text(value, "display_name") else { return Ok(None) };
    let openalex = text(value, "id").map(|id| short_id(&id));
    let issn_l = text(value, "issn_l");
    let mut id: Option<String> = match &openalex {
        Some(openalex) => db.query_row("SELECT id FROM venues WHERE openalex_id = ?", [openalex], |r| r.get(0)).optional().map_err(e)?,
        None => None,
    };
    if id.is_none() {
        // A venue the library named itself (no OpenAlex id yet) is this one.
        id = db
            .query_row(
                "SELECT id FROM venues WHERE openalex_id IS NULL AND (name_key = ?1 OR (?2 IS NOT NULL AND (issn_l = ?2 OR EXISTS (SELECT 1 FROM json_each(venues.issns) WHERE value = ?2)))) LIMIT 1",
                params![name_key(&name), issn_l],
                |r| r.get(0),
            )
            .optional()
            .map_err(e)?;
    }
    let id = id.unwrap_or_else(new_id);
    let publisher = match text(value, "host_organization_name") {
        Some(publisher) => upsert_publisher(db, text(value, "host_organization").map(|p| short_id(&p)).as_deref(), &publisher)?,
        None => None,
    };
    let issns = value.get("issn").filter(|v| v.is_array()).cloned().unwrap_or_else(|| json!(issn_l.iter().collect::<Vec<_>>()));
    db.execute(
        "INSERT INTO venues(id, name, name_key, issn_l, issns, type, openalex_id, publisher_id, is_oa, in_doaj) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key, issn_l = coalesce(excluded.issn_l, issn_l), issns = excluded.issns,
           type = coalesce(excluded.type, type), openalex_id = coalesce(excluded.openalex_id, openalex_id), publisher_id = coalesce(excluded.publisher_id, publisher_id),
           is_oa = coalesce(excluded.is_oa, is_oa), in_doaj = coalesce(excluded.in_doaj, in_doaj)",
        params![
            id,
            name,
            name_key(&name),
            issn_l,
            issns.to_string(),
            text(value, "type"),
            openalex,
            publisher,
            value.get("is_oa").and_then(Json::as_bool).map(i64::from),
            value.get("is_in_doaj").and_then(Json::as_bool).map(i64::from)
        ],
    )
    .map_err(e)?;
    Ok(Some(id))
}

/// The person an OpenAlex author is: found by OpenAlex id or ORCID (and when those name two
/// rows, they are one person and are merged), else `fallback` when it is a person of this
/// source alone with no identifiers, else a new person.
fn identified_person(db: &Connection, author: &Json, fallback: Option<&str>) -> Result<Option<String>> {
    let openalex = text(author, "id").map(|id| short_id(&id)).filter(|id| !id.is_empty());
    let orcid = text(author, "orcid").and_then(|o| bare_orcid(&o));
    let Some(name) = text(author, "display_name") else { return Ok(None) };
    if openalex.is_none() && orcid.is_none() {
        return Ok(None);
    }
    let find = |column: &str, value: &Option<String>| -> Result<Option<String>> {
        match value {
            Some(value) => db.query_row(&format!("SELECT id FROM people WHERE {column} = ?"), [value], |r| r.get(0)).optional().map_err(e),
            None => Ok(None),
        }
    };
    let by_openalex = find("openalex_id", &openalex)?;
    let by_orcid = find("orcid", &orcid)?;
    let found = match (by_openalex, by_orcid) {
        (Some(a), Some(b)) if a != b => {
            graph::merge_on(db, &a, &b)?;
            Some(a)
        }
        (a, b) => a.or(b),
    };
    let id = match found {
        Some(id) => id,
        None => {
            let solo = match fallback {
                Some(person) => db
                    .query_row(
                        "SELECT p.orcid IS NULL AND p.openalex_id IS NULL AND (SELECT count(*) FROM source_people WHERE person_id = p.id) = 1
                           AND NOT EXISTS (SELECT 1 FROM person_names WHERE person_id = p.id AND confirmed = 1)
                         FROM people p WHERE p.id = ?",
                        [person],
                        |r| r.get::<_, bool>(0),
                    )
                    .optional()
                    .map_err(e)?
                    .unwrap_or(false),
                None => false,
            };
            if let (true, Some(person)) = (solo, fallback) {
                person.to_string()
            } else {
                let (family, given) = split_name(&name);
                graph::create_person(db, &name, family.as_deref(), given.as_deref())?
            }
        }
    };
    let (family, given) = split_name(&name);
    db.execute(
        "UPDATE people SET orcid = coalesce(orcid, ?2), openalex_id = coalesce(openalex_id, ?3), name = ?4, family = ?5, given = ?6,
           name_key = ?7, family_key = ?8, updated_at = ?9 WHERE id = ?1",
        params![id, orcid, openalex, name, family, given, name_key(&name), family.as_deref().map(name_key).unwrap_or_default(), now_ms()],
    )
    .map_err(e)?;
    Ok(Some(id))
}

/// Which of the source's creators an authorship is: the same position when the names agree,
/// else the first one with that family name and compatible given names.
fn creator_position(db: &Connection, source_id: &str, index: usize, name: &str) -> Result<Option<i64>> {
    let key = name_key(name);
    let family = key.rsplit(' ').next().unwrap_or("").to_string();
    let mut statement = db.prepare("SELECT position, name_key FROM source_people WHERE source_id = ? ORDER BY position").map_err(e)?;
    let rows: Vec<(i64, String)> = statement.query_map([source_id], |r| Ok((r.get(0)?, r.get(1)?))).map_err(e)?.collect::<std::result::Result<_, _>>().map_err(e)?;
    let fits = |k: &str| {
        let (a, b) = (k.split_whitespace().collect::<Vec<_>>(), key.split_whitespace().collect::<Vec<_>>());
        let (Some(fa), Some(fb)) = (a.last(), b.last()) else { return false };
        // Family names agree (either order of given and family) and the first initials match.
        let same_family = fa == fb || a.first() == b.last() || a.last() == b.first();
        let initial = |t: &[&str]| t.iter().find(|w| **w != family).and_then(|w| w.chars().next());
        same_family && (k == key || initial(&a) == initial(&b) || initial(&a).is_none() || initial(&b).is_none())
    };
    if let Some((position, _)) = rows.iter().find(|(p, k)| *p == index as i64 && fits(k)) {
        return Ok(Some(*position));
    }
    Ok(rows.iter().find(|(_, k)| fits(k)).map(|(p, _)| *p))
}

impl Store {
    // ── Queue ───────────────────────────────────────────────

    /// The next source to look up: ones the user asked for first, then (with `auto`) ones
    /// imported with an identifier, those open in a view before the rest.
    pub fn next_enrichment(&self, auto: bool, focus: &[String]) -> Result<Option<EnrichJob>> {
        let db = self.read()?;
        let focus = serde_json::to_string(focus).map_err(e)?;
        db.query_row(
            "SELECT id, doi, pmid, openalex_id, title, year, enrich_attempts FROM sources
             WHERE trashed_at IS NULL AND (enrich_status = 'requested' OR (?1 AND enrich_status = 'pending')) AND coalesce(enrich_after, 0) <= ?2
             ORDER BY enrich_status = 'requested' DESC, id IN (SELECT value FROM json_each(?3)) DESC, added_at DESC LIMIT 1",
            params![auto, now_ms(), focus],
            |r| {
                Ok(EnrichJob {
                    id: r.get(0)?,
                    doi: r.get(1)?,
                    pmid: r.get(2)?,
                    openalex_id: r.get(3)?,
                    title: r.get(4)?,
                    year: r.get(5)?,
                    attempts: r.get(6)?,
                })
            },
        )
        .optional()
        .map_err(e)
    }

    /// "Enrich": looks these sources up next, whether or not automatic enrichment is on.
    pub fn request_enrichment(&self, ids: &[String]) -> Result<usize> {
        let db = self.db()?;
        let mut changed = 0;
        for id in ids {
            changed += db
                .execute(
                    "UPDATE sources SET enrich_status = 'requested', enrich_error = NULL, enrich_attempts = 0, enrich_after = NULL WHERE id = ? AND trashed_at IS NULL",
                    [id],
                )
                .map_err(e)?;
        }
        Ok(changed)
    }

    /// A lookup that did not work: `not_found` stays until the identifiers change; `failed`
    /// is tried again after `retry_at` (None: given up).
    pub fn enrichment_failed(&self, id: &str, status: &str, error: &str, retry_at: Option<i64>) -> Result<()> {
        self.db()?
            .execute(
                "UPDATE sources SET enrich_status = CASE WHEN ?4 IS NULL THEN ?2 ELSE enrich_status END, enrich_error = ?3,
                   enrich_attempts = enrich_attempts + 1, enrich_after = ?4 WHERE id = ?1",
                params![id, status, error, retry_at],
            )
            .map(|_| ())
            .map_err(e)
    }

    /// How many sources wait for a lookup, for the status line.
    pub fn enrichment_queue(&self, auto: bool) -> Result<i64> {
        self.read()?
            .query_row(
                "SELECT count(*) FROM sources WHERE trashed_at IS NULL AND (enrich_status = 'requested' OR (?1 AND enrich_status = 'pending'))",
                [auto],
                |r| r.get(0),
            )
            .map_err(e)
    }

    /// The library source for an OpenAlex work, by its id or DOI.
    pub fn source_for_work(&self, openalex_id: Option<&str>, doi: Option<&str>) -> Result<Option<String>> {
        let doi = doi.map(bare_doi).filter(|d| !d.is_empty());
        self.read()?
            .query_row(
                "SELECT id FROM sources WHERE trashed_at IS NULL AND ((?1 IS NOT NULL AND openalex_id = ?1) OR (?2 IS NOT NULL AND (lower(doi) = ?2 OR lower(doi) = 'https://doi.org/' || ?2))) LIMIT 1",
                params![openalex_id, doi],
                |r| r.get(0),
            )
            .optional()
            .map_err(e)
    }

    // ── Works ───────────────────────────────────────────────

    /// Stores an OpenAlex work on a source (see the module comment for what goes where).
    pub fn apply_openalex_work(&self, id: &str, work: &Json) -> Result<()> {
        let work_id = text(work, "id").map(|w| short_id(&w)).filter(|w| w.starts_with('W')).ok_or("OpenAlex returned no work")?;
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let now = now_ms();
        let location = work.get("primary_location").filter(|l| l.is_object());
        let venue = location.and_then(|l| l.get("source")).filter(|s| s.is_object());
        let open_access = work.get("open_access");
        let ids = work.get("ids");
        let biblio = work.get("biblio");
        let pages = biblio.and_then(|b| match (text(b, "first_page"), text(b, "last_page")) {
            (Some(first), Some(last)) if first != last => Some(format!("{first}–{last}")),
            (first, last) => first.or(last),
        });
        let oa_url = open_access.and_then(|o| text(o, "oa_url")).or_else(|| work.get("best_oa_location").and_then(|l| text(l, "pdf_url").or_else(|| text(l, "landing_page_url"))));
        tx.execute(
            "UPDATE sources SET openalex_id = ?2, work_type = ?3, oa_status = ?4, oa_url = ?5, retracted = ?6, cited_by_count = ?7, fwci = ?8, metrics_at = ?9,
               enriched_at = ?9, enrich_status = 'done', enrich_error = NULL, enrich_attempts = 0, enrich_after = NULL,
               doi = coalesce(nullif(doi, ''), ?10), pmid = coalesce(nullif(pmid, ''), ?11), pmcid = coalesce(nullif(pmcid, ''), ?12),
               language = coalesce(nullif(language, ''), ?13), volume = coalesce(nullif(volume, ''), ?14), issue = coalesce(nullif(issue, ''), ?15),
               pages = coalesce(nullif(pages, ''), ?16), date = coalesce(nullif(date, ''), ?17), year = coalesce(year, ?18),
               title = CASE WHEN trim(title) = '' THEN coalesce(?19, title) ELSE title END, abstract = coalesce(nullif(abstract, ''), ?20),
               container_title = coalesce(nullif(container_title, ''), ?21), issn = coalesce(nullif(issn, ''), ?22), publisher = coalesce(nullif(publisher, ''), ?23),
               updated_at = ?9
             WHERE id = ?1",
            params![
                id,
                work_id,
                text(work, "type"),
                open_access.and_then(|o| text(o, "oa_status")),
                oa_url,
                work.get("is_retracted").and_then(Json::as_bool).map(i64::from),
                work.get("cited_by_count").and_then(Json::as_i64),
                work.get("fwci").and_then(Json::as_f64),
                now,
                text(work, "doi").map(|d| bare_doi(&d)),
                ids.and_then(|i| text(i, "pmid")).map(|p| short_id(&p)),
                ids.and_then(|i| text(i, "pmcid")).map(|p| { let id = short_id(&p); if id.starts_with("PMC") { id } else { format!("PMC{id}") } }),
                text(work, "language"),
                biblio.and_then(|b| text(b, "volume")),
                biblio.and_then(|b| text(b, "issue")),
                pages,
                text(work, "publication_date"),
                work.get("publication_year").and_then(Json::as_i64),
                text(work, "display_name").or_else(|| text(work, "title")),
                work.get("abstract_inverted_index").and_then(abstract_text),
                venue.and_then(|v| text(v, "display_name")),
                venue.and_then(|v| text(v, "issn_l")),
                venue.and_then(|v| text(v, "host_organization_name")),
            ],
        )
        .map_err(e)?;

        // People: a source without creators takes OpenAlex's; otherwise each authorship is
        // matched to the creator it names, and that position gets the identified person.
        let authorships: Vec<Json> = work.get("authorships").and_then(Json::as_array).cloned().unwrap_or_default();
        let creators: String = tx.query_row("SELECT creators FROM sources WHERE id = ?", [id], |r| r.get(0)).map_err(e)?;
        let empty = serde_json::from_str::<Vec<Creator>>(&creators).map(|c| c.is_empty()).unwrap_or(true);
        if empty && !authorships.is_empty() {
            let creators: Vec<Creator> = authorships
                .iter()
                .filter_map(|a| a.get("author").and_then(|author| text(author, "display_name")))
                .map(|name| {
                    let (family, given) = split_name(&name);
                    Creator { family, given, literal: None, role: "author".into(), person_id: None }
                })
                .collect();
            tx.execute("UPDATE sources SET creators = ?2 WHERE id = ?1", params![id, serde_json::to_string(&creators).map_err(e)?]).map_err(e)?;
            graph::sync_people(&tx, id, false)?;
        }
        let mut created_or_upgraded = Vec::new();
        for (index, authorship) in authorships.iter().enumerate() {
            let Some(author) = authorship.get("author") else { continue };
            let Some(name) = text(author, "display_name") else { continue };
            let Some(position) = creator_position(&tx, id, index, &name)? else { continue };
            let current: String = tx
                .query_row("SELECT person_id FROM source_people WHERE source_id = ?1 AND position = ?2", params![id, position], |r| r.get(0))
                .map_err(e)?;
            let Some(person) = identified_person(&tx, author, Some(&current))? else { continue };
            let affiliation = authorship.get("raw_affiliation_strings").and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_str).collect::<Vec<_>>().join("; "));
            tx.execute(
                "UPDATE source_people SET person_id = ?3, corresponding = ?4, author_position = ?5, raw_affiliation = ?6 WHERE source_id = ?1 AND position = ?2",
                params![
                    id,
                    position,
                    person,
                    authorship.get("is_corresponding").and_then(Json::as_bool).unwrap_or(false),
                    text(authorship, "author_position"),
                    affiliation.filter(|a| !a.is_empty())
                ],
            )
            .map_err(e)?;
            tx.execute("DELETE FROM source_person_institutions WHERE source_id = ?1 AND position = ?2", params![id, position]).map_err(e)?;
            for institution in authorship.get("institutions").and_then(Json::as_array).into_iter().flatten() {
                if let Some(institution) = upsert_institution(&tx, institution)? {
                    tx.execute(
                        "INSERT OR IGNORE INTO source_person_institutions(source_id, position, institution_id) VALUES (?1, ?2, ?3)",
                        params![id, position, institution],
                    )
                    .map_err(e)?;
                }
            }
            if person != current {
                graph::prune_person(&tx, &current)?;
            }
            created_or_upgraded.push(person);
        }
        for person in created_or_upgraded {
            graph::suggest_for(&tx, &person)?;
        }

        if let Some(venue) = venue {
            let old: Option<String> = tx.query_row("SELECT venue_id FROM sources WHERE id = ?", [id], |r| r.get(0)).map_err(e)?;
            if let Some(venue) = upsert_venue(&tx, venue)? {
                tx.execute(
                    "UPDATE sources SET venue_id = ?2, publisher_id = coalesce(publisher_id, (SELECT publisher_id FROM venues WHERE id = ?2)) WHERE id = ?1",
                    params![id, venue],
                )
                .map_err(e)?;
                if let Some(old) = old.filter(|old| *old != venue) {
                    tx.execute(
                        "DELETE FROM venues WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM sources WHERE venue_id = ?1) AND NOT EXISTS (SELECT 1 FROM links WHERE to_kind = 'venue' AND to_id = ?1)",
                        [old],
                    )
                    .map_err(e)?;
                }
            }
        }

        // Topics with their hierarchy, and the work's score for each.
        tx.execute("DELETE FROM source_topics WHERE source_id = ?", [id]).map_err(e)?;
        let primary = work.get("primary_topic").and_then(|t| text(t, "id")).map(|t| topic_id(&t));
        for topic in work.get("topics").and_then(Json::as_array).into_iter().flatten() {
            let mut parent: Option<String> = None;
            for (key, level) in [("domain", "domain"), ("field", "field"), ("subfield", "subfield")] {
                let Some(node) = topic.get(key) else { continue };
                let (Some(url), Some(name)) = (text(node, "id"), text(node, "display_name")) else { continue };
                let node_id = topic_id(&url);
                tx.execute(
                    "INSERT INTO topics(id, name, level, parent_id) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id",
                    params![node_id, name, level, parent],
                )
                .map_err(e)?;
                parent = Some(node_id);
            }
            let (Some(url), Some(name)) = (text(topic, "id"), text(topic, "display_name")) else { continue };
            let topic = topic_id(&url);
            tx.execute(
                "INSERT INTO topics(id, name, level, parent_id) VALUES (?1, ?2, 'topic', ?3) ON CONFLICT(id) DO UPDATE SET name = excluded.name, parent_id = excluded.parent_id",
                params![topic, name, parent],
            )
            .map_err(e)?;
            let score = work.get("topics").and_then(Json::as_array).and_then(|all| all.iter().find(|t| text(t, "id").as_deref() == Some(&url))).and_then(|t| t.get("score")).and_then(Json::as_f64);
            tx.execute(
                "INSERT OR REPLACE INTO source_topics(source_id, topic_id, score, is_primary) VALUES (?1, ?2, ?3, ?4)",
                params![id, topic, score, primary.as_deref() == Some(&topic)],
            )
            .map_err(e)?;
        }

        tx.execute("DELETE FROM source_keywords WHERE source_id = ?", [id]).map_err(e)?;
        for keyword in work.get("keywords").and_then(Json::as_array).into_iter().flatten() {
            let (Some(url), Some(name)) = (text(keyword, "id"), text(keyword, "display_name")) else { continue };
            let keyword_id = short_id(&url);
            tx.execute("INSERT INTO keywords(id, name) VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET name = excluded.name", params![keyword_id, name]).map_err(e)?;
            tx.execute(
                "INSERT OR REPLACE INTO source_keywords(source_id, keyword_id, score) VALUES (?1, ?2, ?3)",
                params![id, keyword_id, keyword.get("score").and_then(Json::as_f64)],
            )
            .map_err(e)?;
        }

        // Funders, with their award numbers where OpenAlex has them (`awards`, or the older `grants`).
        tx.execute("DELETE FROM source_grants WHERE source_id = ?", [id]).map_err(e)?;
        let funder = |url: Option<String>, name: Option<String>, ror: Option<String>| -> Result<Option<String>> {
            let (Some(url), Some(name)) = (url, name) else { return Ok(None) };
            let openalex = short_id(&url);
            let existing: Option<String> = tx.query_row("SELECT id FROM funders WHERE openalex_id = ?", [&openalex], |r| r.get(0)).optional().map_err(e)?;
            let funder = existing.unwrap_or_else(new_id);
            tx.execute(
                "INSERT INTO funders(id, name, name_key, openalex_id, ror) VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT(id) DO UPDATE SET name = excluded.name, name_key = excluded.name_key, ror = coalesce(excluded.ror, ror)",
                params![funder, name, name_key(&name), openalex, ror.map(|r| short_id(&r))],
            )
            .map_err(e)?;
            Ok(Some(funder))
        };
        let grant = |funder: &str, award: Option<String>, title: Option<String>| -> Result<()> {
            tx.execute(
                "INSERT OR IGNORE INTO source_grants(source_id, funder_id, award_id, title) VALUES (?1, ?2, ?3, ?4)",
                params![id, funder, award.unwrap_or_default(), title],
            )
            .map(|_| ())
            .map_err(e)
        };
        let mut funded = std::collections::HashSet::new();
        for award in work.get("awards").and_then(Json::as_array).into_iter().flatten() {
            if let Some(f) = funder(text(award, "funder_id"), text(award, "funder_display_name"), None)? {
                grant(&f, text(award, "funder_award_id"), text(award, "display_name"))?;
                funded.insert(f);
            }
        }
        for old in work.get("grants").and_then(Json::as_array).into_iter().flatten() {
            if let Some(f) = funder(text(old, "funder"), text(old, "funder_display_name"), None)? {
                grant(&f, text(old, "award_id"), None)?;
                funded.insert(f);
            }
        }
        for f in work.get("funders").and_then(Json::as_array).into_iter().flatten() {
            if let Some(f) = funder(text(f, "id"), text(f, "display_name"), text(f, "ror"))? {
                if !funded.contains(&f) {
                    grant(&f, None, None)?;
                }
            }
        }

        // What it cites: OpenAlex ids in order. Details come from `apply_openalex_cited`.
        let referenced: Vec<String> = work.get("referenced_works").and_then(Json::as_array).into_iter().flatten().filter_map(Json::as_str).map(short_id).collect();
        if work.get("referenced_works").is_some() {
            let keep = serde_json::to_string(&referenced).map_err(e)?;
            tx.execute("DELETE FROM source_cites WHERE source_id = ?1 AND openalex_id NOT IN (SELECT value FROM json_each(?2))", params![id, keep]).map_err(e)?;
            for (seq, cited) in referenced.iter().enumerate() {
                tx.execute(
                    "INSERT INTO source_cites(source_id, seq, openalex_id) VALUES (?1, ?2, ?3) ON CONFLICT(source_id, openalex_id) DO UPDATE SET seq = excluded.seq",
                    params![id, seq as i64, cited],
                )
                .map_err(e)?;
            }
            match_cites(&tx, id)?;
        }
        graph::sync_cite_links(&tx, id)?;
        graph::relink_citations(&tx, id)?;
        refresh_search(&tx, id)?;
        tx.commit().map_err(e)
    }

    /// OpenAlex ids of works a source cites whose title is not known yet.
    pub fn cites_without_details(&self, id: &str, limit: usize) -> Result<Vec<String>> {
        let db = self.read()?;
        let mut statement = db.prepare("SELECT openalex_id FROM source_cites WHERE source_id = ? AND title IS NULL ORDER BY seq LIMIT ?").map_err(e)?;
        statement
            .query_map(params![id, limit as i64], |r| r.get(0))
            .map_err(e)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(e)
    }

    /// Titles, authors, year and DOI of cited works (from a `works?filter=openalex:…` page).
    pub fn apply_openalex_cited(&self, id: &str, works: &[Json]) -> Result<()> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        for work in works {
            let Some(work_id) = text(work, "id").map(|w| short_id(&w)) else { continue };
            let names: Vec<String> = work
                .get("authorships")
                .and_then(Json::as_array)
                .into_iter()
                .flatten()
                .filter_map(|a| a.get("author").and_then(|author| text(author, "display_name")))
                .collect();
            let names: Vec<&str> = names.iter().map(String::as_str).collect();
            tx.execute(
                "UPDATE source_cites SET doi = ?3, title = ?4, byline = ?5, year = ?6, container = ?7 WHERE source_id = ?1 AND openalex_id = ?2",
                params![
                    id,
                    work_id,
                    text(work, "doi").map(|d| bare_doi(&d)),
                    text(work, "display_name").or_else(|| text(work, "title")).unwrap_or_default(),
                    Some(byline(&names)).filter(|b| !b.is_empty()),
                    work.get("publication_year").and_then(Json::as_i64),
                    work.get("primary_location").and_then(|l| l.get("source")).and_then(|s| text(s, "display_name")),
                ],
            )
            .map_err(e)?;
        }
        match_cites(&tx, id)?;
        graph::sync_cite_links(&tx, id)?;
        tx.commit().map_err(e)
    }

    /// Refreshes the cached counts (tier b) of a work already stored.
    pub fn apply_openalex_metrics(&self, id: &str, work: &Json) -> Result<()> {
        self.db()?
            .execute(
                "UPDATE sources SET cited_by_count = coalesce(?2, cited_by_count), fwci = coalesce(?3, fwci), retracted = coalesce(?4, retracted), metrics_at = ?5 WHERE id = ?1",
                params![
                    id,
                    work.get("cited_by_count").and_then(Json::as_i64),
                    work.get("fwci").and_then(Json::as_f64),
                    work.get("is_retracted").and_then(Json::as_bool).map(i64::from),
                    now_ms()
                ],
            )
            .map(|_| ())
            .map_err(e)
    }

    /// A person's OpenAlex author record: identifiers they lack, other spellings, last known
    /// institution and the cached counts.
    pub fn apply_openalex_author(&self, person_id: &str, author: &Json) -> Result<()> {
        let db = self.db()?;
        let tx = db.unchecked_transaction().map_err(e)?;
        let openalex = text(author, "id").map(|id| short_id(&id));
        let orcid = text(author, "orcid").and_then(|o| bare_orcid(&o));
        // Another row with these identifiers is the same person.
        for (column, value) in [("openalex_id", &openalex), ("orcid", &orcid)] {
            if let Some(value) = value {
                let other: Option<String> =
                    tx.query_row(&format!("SELECT id FROM people WHERE {column} = ?1 AND id <> ?2"), params![value, person_id], |r| r.get(0)).optional().map_err(e)?;
                if let Some(other) = other {
                    graph::merge_on(&tx, person_id, &other)?;
                }
            }
        }
        let institution = match author.get("last_known_institutions").and_then(Json::as_array).and_then(|a| a.first()) {
            Some(institution) => upsert_institution(&tx, institution)?,
            None => None,
        };
        let stats = author.get("summary_stats");
        tx.execute(
            "UPDATE people SET orcid = coalesce(orcid, ?2), openalex_id = coalesce(openalex_id, ?3), institution_id = coalesce(?4, institution_id),
               works_count = ?5, cited_by_count = ?6, h_index = ?7, i10_index = ?8, metrics_at = ?9, updated_at = ?9 WHERE id = ?1",
            params![
                person_id,
                orcid,
                openalex,
                institution,
                author.get("works_count").and_then(Json::as_i64),
                author.get("cited_by_count").and_then(Json::as_i64),
                stats.and_then(|s| s.get("h_index")).and_then(Json::as_i64),
                stats.and_then(|s| s.get("i10_index")).and_then(Json::as_i64),
                now_ms()
            ],
        )
        .map_err(e)?;
        for name in author.get("display_name_alternatives").and_then(Json::as_array).into_iter().flatten().filter_map(Json::as_str) {
            tx.execute(
                "INSERT OR IGNORE INTO person_names(person_id, name, name_key, confirmed) VALUES (?1, ?2, ?3, 0)",
                params![person_id, name, name_key(name)],
            )
            .map_err(e)?;
        }
        tx.commit().map_err(e)
    }

    /// A venue's OpenAlex source record: its cached counts and home page.
    pub fn apply_openalex_venue(&self, venue_id: &str, record: &Json) -> Result<()> {
        let stats = record.get("summary_stats");
        self.db()?
            .execute(
                "UPDATE venues SET openalex_id = coalesce(openalex_id, ?2), homepage = coalesce(?3, homepage), is_oa = coalesce(?4, is_oa), in_doaj = coalesce(?5, in_doaj),
                   works_count = ?6, cited_by_count = ?7, h_index = ?8, metrics_at = ?9 WHERE id = ?1",
                params![
                    venue_id,
                    text(record, "id").map(|id| short_id(&id)),
                    text(record, "homepage_url"),
                    record.get("is_oa").and_then(Json::as_bool).map(i64::from),
                    record.get("is_in_doaj").and_then(Json::as_bool).map(i64::from),
                    record.get("works_count").and_then(Json::as_i64),
                    record.get("cited_by_count").and_then(Json::as_i64),
                    stats.and_then(|s| s.get("h_index")).and_then(Json::as_i64),
                    now_ms()
                ],
            )
            .map(|_| ())
            .map_err(e)
    }
}

/// Points a source's cited works at library sources with the same OpenAlex id or DOI.
fn match_cites(db: &Connection, id: &str) -> Result<()> {
    db.execute(
        "UPDATE source_cites SET matched_source_id = (
           SELECT s.id FROM sources s WHERE s.trashed_at IS NULL AND s.id <> ?1
             AND (s.openalex_id = source_cites.openalex_id OR (source_cites.doi IS NOT NULL AND (lower(s.doi) = source_cites.doi OR lower(s.doi) = 'https://doi.org/' || source_cites.doi)))
           LIMIT 1)
         WHERE source_id = ?1",
        [id],
    )
    .map(|_| ())
    .map_err(e)
}

fn refresh_search(db: &Connection, id: &str) -> Result<()> {
    crate::refresh_fts(db, id)
}
