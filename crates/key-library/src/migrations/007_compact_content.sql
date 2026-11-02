BEGIN IMMEDIATE;
-- Public content hashes and passage IDs remain stable. High-cardinality rows
-- reference integer identities; the digest is stored once as 32 bytes.
CREATE TABLE content_keys (
 id INTEGER PRIMARY KEY,
 digest BLOB NOT NULL UNIQUE CHECK(length(digest)=32)
);
INSERT INTO content_keys(digest) SELECT unhex(hash) FROM documents;
CREATE TRIGGER content_key_insert AFTER INSERT ON documents BEGIN
 INSERT OR IGNORE INTO content_keys(digest) VALUES(unhex(new.hash));
END;
CREATE TRIGGER content_key_delete AFTER DELETE ON documents BEGIN
 DELETE FROM content_keys WHERE digest=unhex(old.hash);
END;
CREATE TABLE artifact_namespaces (
 id INTEGER PRIMARY KEY, kind TEXT NOT NULL, version TEXT NOT NULL, UNIQUE(kind,version)
);
INSERT INTO artifact_namespaces(kind,version) SELECT DISTINCT kind,version FROM artifacts;
CREATE TABLE artifact_data (
 document_id INTEGER NOT NULL REFERENCES content_keys(id) ON DELETE CASCADE,
 namespace_id INTEGER NOT NULL REFERENCES artifact_namespaces(id),
 key TEXT NOT NULL, payload BLOB NOT NULL,
 PRIMARY KEY(document_id,namespace_id,key)
) WITHOUT ROWID;
INSERT INTO artifact_data SELECT c.id,n.id,a.key,a.payload FROM artifacts a
 JOIN content_keys c ON c.digest=unhex(a.document_hash)
 JOIN artifact_namespaces n ON n.kind=a.kind AND n.version=a.version;
CREATE TABLE block_data (
 id INTEGER PRIMARY KEY,
 document_id INTEGER NOT NULL REFERENCES content_keys(id) ON DELETE CASCADE,
 block_key TEXT NOT NULL, text TEXT NOT NULL, UNIQUE(document_id,block_key)
);
INSERT INTO block_data(document_id,block_key,text) SELECT k.id,b.block_key,b.text
 FROM text_blocks b JOIN content_keys k ON k.digest=unhex(b.document_hash);
CREATE TABLE passage_data (
 id INTEGER PRIMARY KEY, external_id TEXT NOT NULL UNIQUE,
 block_id INTEGER NOT NULL REFERENCES block_data(id) ON DELETE CASCADE,
 page INTEGER NOT NULL, context_start INTEGER NOT NULL, context_end INTEGER NOT NULL,
 target_start INTEGER NOT NULL,target_end INTEGER NOT NULL,rects BLOB NOT NULL
);
CREATE INDEX passage_block ON passage_data(block_id);
INSERT INTO passage_data(external_id,block_id,page,context_start,context_end,target_start,target_end,rects)
 SELECT c.id,b.id,c.page,c.context_start,c.context_end,c.target_start,c.target_end,c.rects
 FROM chunks c JOIN content_keys k ON k.digest=unhex(c.document_hash)
 JOIN block_data b ON b.document_id=k.id AND b.block_key=c.block_key;
DROP TABLE chunks;
DROP TABLE text_blocks;
DROP TABLE artifacts;
-- Read compatibility for diagnostics and older application query paths.
CREATE VIEW artifacts AS SELECT lower(hex(c.digest)) document_hash,n.kind,n.version,a.key,a.payload
 FROM artifact_data a JOIN content_keys c ON c.id=a.document_id JOIN artifact_namespaces n ON n.id=a.namespace_id;
CREATE VIEW text_blocks AS SELECT lower(hex(c.digest)) document_hash,b.block_key,b.text
 FROM block_data b JOIN content_keys c ON c.id=b.document_id;
CREATE VIEW chunks AS SELECT p.external_id id,lower(hex(c.digest)) document_hash,b.block_key,p.page,
 p.context_start,p.context_end,p.target_start,p.target_end,p.rects
 FROM passage_data p JOIN block_data b ON b.id=p.block_id JOIN content_keys c ON c.id=b.document_id;
PRAGMA user_version=7;
COMMIT;
