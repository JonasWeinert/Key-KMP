BEGIN IMMEDIATE;
-- Author rows are scoped to documents: equal display names do not imply equal people.
CREATE TABLE document_authors (
 document_hash TEXT NOT NULL REFERENCES documents(hash) ON DELETE CASCADE,
 ordinal INTEGER NOT NULL, name TEXT NOT NULL, authority_id TEXT,
 PRIMARY KEY(document_hash,ordinal)
);
CREATE INDEX authors_name ON document_authors(name COLLATE NOCASE,document_hash);
INSERT INTO document_authors SELECT hash, CAST(j.key AS INTEGER), j.value, NULL FROM documents, json_each(authors) j;
CREATE TRIGGER authors_insert AFTER INSERT ON documents BEGIN
 INSERT INTO document_authors SELECT new.hash,CAST(key AS INTEGER),value,NULL FROM json_each(new.authors);
END;
CREATE TRIGGER authors_update AFTER UPDATE OF authors ON documents BEGIN
 DELETE FROM document_authors WHERE document_hash=new.hash;
 INSERT INTO document_authors SELECT new.hash,CAST(key AS INTEGER),value,NULL FROM json_each(new.authors);
END;
CREATE TABLE metadata_observations (
 id INTEGER PRIMARY KEY, document_hash TEXT NOT NULL REFERENCES documents(hash) ON DELETE CASCADE,
 field TEXT NOT NULL, value TEXT NOT NULL CHECK(json_valid(value)), producer TEXT NOT NULL,
 observed_at INTEGER NOT NULL
);
CREATE INDEX observations_document ON metadata_observations(document_hash,field,observed_at);
CREATE TABLE document_labels (
 document_hash TEXT NOT NULL REFERENCES documents(hash) ON DELETE CASCADE,
 kind TEXT NOT NULL CHECK(kind IN ('tag','collection')), name TEXT NOT NULL COLLATE NOCASE,
 PRIMARY KEY(document_hash,kind,name)
);
CREATE INDEX labels_filter ON document_labels(kind,name,document_hash);
CREATE TABLE property_definitions (
 name TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('text','number','boolean'))
);
INSERT INTO property_definitions SELECT name,CASE json_type(value) WHEN 'text' THEN 'text' WHEN 'integer' THEN 'number' WHEN 'real' THEN 'number' ELSE 'boolean' END FROM document_properties GROUP BY name;
CREATE TABLE document_relations (
 document_hash TEXT NOT NULL REFERENCES documents(hash) ON DELETE CASCADE,
 kind TEXT NOT NULL, ordinal INTEGER NOT NULL, payload TEXT NOT NULL CHECK(json_valid(payload)),
 PRIMARY KEY(document_hash,kind,ordinal)
);
CREATE INDEX relation_page ON document_relations(kind,json_extract(payload,'$.page'),document_hash);
PRAGMA user_version=3;
COMMIT;
