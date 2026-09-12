BEGIN IMMEDIATE;
CREATE INDEX workspace_entry_type ON workspace_records(json_extract(properties,'$.sourceType'));
CREATE TABLE workspace_agent_properties(name TEXT PRIMARY KEY,config TEXT NOT NULL CHECK(json_valid(config)),updated_at INTEGER NOT NULL);
CREATE TABLE workspace_attributes(name TEXT PRIMARY KEY,config TEXT NOT NULL CHECK(json_valid(config)),updated_at INTEGER NOT NULL);
CREATE TABLE workspace_property_provenance(document_hash TEXT NOT NULL REFERENCES documents(hash) ON DELETE CASCADE,name TEXT NOT NULL,payload TEXT NOT NULL CHECK(json_valid(payload)),PRIMARY KEY(document_hash,name));
-- Historical import time cannot be reconstructed from mutable updated_at.
ALTER TABLE documents ADD COLUMN added_at INTEGER;
CREATE TRIGGER documents_added_at AFTER INSERT ON documents
WHEN NEW.added_at IS NULL BEGIN
 UPDATE documents SET added_at=CAST(unixepoch('subsec')*1000 AS INTEGER) WHERE hash=NEW.hash;
END;
PRAGMA user_version=12;
COMMIT;
