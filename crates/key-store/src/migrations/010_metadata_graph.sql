-- The people, venues, publishers, institutions, topics, keywords and funders around the
-- sources get their own tables, linked to sources by id. A source keeps its creators JSON
-- and container title as the text it shows and cites; these tables say who and what that
-- text is, so a person or a journal can be shown, filtered and merged as one thing.
-- OpenAlex fills them (see graph.rs and openalex.rs); existing sources are backfilled from
-- their own creators and container titles when this migration runs.

CREATE TABLE institutions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  ror TEXT UNIQUE,
  openalex_id TEXT UNIQUE,
  country TEXT,
  type TEXT
);
CREATE INDEX institutions_name ON institutions(name_key);

CREATE TABLE people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,                       -- "Given Family" as best known
  family TEXT,
  given TEXT,
  name_key TEXT NOT NULL,                   -- normalised "given family", for matching
  family_key TEXT NOT NULL DEFAULT '',      -- normalised family name, for suggesting merges
  orcid TEXT UNIQUE,                        -- bare 0000-0000-0000-0000
  openalex_id TEXT UNIQUE,                  -- A123…
  institution_id TEXT REFERENCES institutions(id) ON DELETE SET NULL,  -- last known
  -- Cached from OpenAlex and refreshed when the person is viewed; `metrics_at` says when.
  works_count INTEGER,
  cited_by_count INTEGER,
  h_index INTEGER,
  i10_index INTEGER,
  metrics_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX people_name ON people(name_key);
CREATE INDEX people_family ON people(family_key);

-- Other spellings of a person's name. `confirmed` ones (from an accepted merge) also catch
-- the same spelling on sources added later; OpenAlex's alternatives only describe.
CREATE TABLE person_names (
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (person_id, name_key)
);
CREATE INDEX person_names_key ON person_names(name_key);

-- Each source's people in order: who they are, their role, the name as printed on the
-- source (the creators JSON, by position) and what OpenAlex says about them there.
CREATE TABLE source_people (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id),
  role TEXT NOT NULL DEFAULT 'author',
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  corresponding INTEGER NOT NULL DEFAULT 0,
  author_position TEXT,                     -- first | middle | last
  raw_affiliation TEXT,
  PRIMARY KEY (source_id, position)
);
CREATE INDEX source_people_person ON source_people(person_id);

-- Where each person was when they wrote the source.
CREATE TABLE source_person_institutions (
  source_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  institution_id TEXT NOT NULL REFERENCES institutions(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, position, institution_id),
  FOREIGN KEY (source_id, position) REFERENCES source_people(source_id, position) ON DELETE CASCADE
);
CREATE INDEX source_person_institutions_institution ON source_person_institutions(institution_id);

-- Name variants that might be one person. Suggested, never applied without the user.
CREATE TABLE person_merge_suggestions (
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,  -- the one to keep
  other_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,   -- folded into it
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  dismissed_at INTEGER,
  PRIMARY KEY (person_id, other_id)
);

CREATE TABLE publishers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  openalex_id TEXT UNIQUE,
  ror TEXT
);
CREATE INDEX publishers_name ON publishers(name_key);

-- Journals, repositories, conferences and book series.
CREATE TABLE venues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  issn_l TEXT,
  issns TEXT NOT NULL DEFAULT '[]',
  type TEXT,                                -- journal | repository | conference | book series …
  openalex_id TEXT UNIQUE,                  -- S123…
  publisher_id TEXT REFERENCES publishers(id) ON DELETE SET NULL,
  homepage TEXT,
  is_oa INTEGER,
  in_doaj INTEGER,
  works_count INTEGER,
  cited_by_count INTEGER,
  h_index INTEGER,
  metrics_at INTEGER
);
CREATE INDEX venues_name ON venues(name_key);
CREATE INDEX venues_issn ON venues(issn_l);

-- OpenAlex's domain → field → subfield → topic hierarchy. Ids keep OpenAlex's own:
-- T10017, subfields/1802 → S1802, fields/18 → F18, domains/2 → D2.
CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  level TEXT NOT NULL,                      -- domain | field | subfield | topic
  parent_id TEXT REFERENCES topics(id)
);
CREATE INDEX topics_parent ON topics(parent_id);
CREATE TABLE source_topics (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  score REAL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source_id, topic_id)
);
CREATE INDEX source_topics_topic ON source_topics(topic_id);

CREATE TABLE keywords (
  id TEXT PRIMARY KEY,                      -- OpenAlex's slug, e.g. open-access
  name TEXT NOT NULL
);
CREATE TABLE source_keywords (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  keyword_id TEXT NOT NULL REFERENCES keywords(id),
  score REAL,
  PRIMARY KEY (source_id, keyword_id)
);
CREATE INDEX source_keywords_keyword ON source_keywords(keyword_id);

CREATE TABLE funders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL,
  openalex_id TEXT UNIQUE,                  -- F123…
  ror TEXT
);
CREATE TABLE source_grants (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  funder_id TEXT NOT NULL REFERENCES funders(id),
  award_id TEXT NOT NULL DEFAULT '',        -- the funder's own number, when known
  title TEXT,
  PRIMARY KEY (source_id, funder_id, award_id)
);
CREATE INDEX source_grants_funder ON source_grants(funder_id);

-- The works a source cites, as OpenAlex lists them. Those in the library are linked
-- (`matched_source_id`); the others keep enough to be shown and added with one click.
-- The PDF reader's own bibliography (source_references) is matched the same way.
CREATE TABLE source_cites (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  openalex_id TEXT NOT NULL,
  doi TEXT,
  title TEXT,
  byline TEXT,                              -- "Piwowar, Priem et al."
  year INTEGER,
  container TEXT,
  matched_source_id TEXT,
  PRIMARY KEY (source_id, openalex_id)
);
CREATE INDEX source_cites_matched ON source_cites(matched_source_id) WHERE matched_source_id IS NOT NULL;
CREATE INDEX source_cites_work ON source_cites(openalex_id);
CREATE INDEX source_cites_doi ON source_cites(doi);

ALTER TABLE sources ADD COLUMN venue_id TEXT REFERENCES venues(id) ON DELETE SET NULL;
ALTER TABLE sources ADD COLUMN publisher_id TEXT REFERENCES publishers(id) ON DELETE SET NULL;
-- Stored from OpenAlex and filterable.
ALTER TABLE sources ADD COLUMN openalex_id TEXT;
ALTER TABLE sources ADD COLUMN work_type TEXT;             -- article | preprint | review | book-chapter …
ALTER TABLE sources ADD COLUMN oa_status TEXT;             -- gold | green | hybrid | bronze | diamond | closed
ALTER TABLE sources ADD COLUMN oa_url TEXT;
ALTER TABLE sources ADD COLUMN retracted INTEGER;
-- Cached from OpenAlex and refreshed when the source is viewed; `metrics_at` says when.
ALTER TABLE sources ADD COLUMN cited_by_count INTEGER;
ALTER TABLE sources ADD COLUMN fwci REAL;
ALTER TABLE sources ADD COLUMN metrics_at INTEGER;
-- Enrichment: pending | done | not_found | failed | off. NULL: nothing to look it up by yet.
ALTER TABLE sources ADD COLUMN enrich_status TEXT;
ALTER TABLE sources ADD COLUMN enrich_error TEXT;
ALTER TABLE sources ADD COLUMN enriched_at INTEGER;
ALTER TABLE sources ADD COLUMN enrich_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN enrich_after INTEGER;      -- retry no sooner than this
CREATE INDEX sources_venue ON sources(venue_id);
CREATE INDEX sources_publisher ON sources(publisher_id);
CREATE INDEX sources_openalex ON sources(openalex_id);
CREATE INDEX sources_cited_by ON sources(cited_by_count);
CREATE INDEX sources_enrich ON sources(enrich_status) WHERE enrich_status = 'pending';

-- A select property's values have their own rows, so renaming one renames it on every
-- source. Sources keep the value's text in their properties JSON too, for display.
CREATE TABLE property_options (
  id TEXT PRIMARY KEY,
  property TEXT NOT NULL REFERENCES property_definitions(name) ON UPDATE CASCADE ON DELETE CASCADE,
  value TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  UNIQUE (property, value)
);
CREATE TABLE source_property_options (
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  option_id TEXT NOT NULL REFERENCES property_options(id) ON DELETE CASCADE,
  PRIMARY KEY (source_id, option_id)
);
CREATE INDEX source_property_options_option ON source_property_options(option_id);
