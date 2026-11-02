BEGIN IMMEDIATE;
ALTER TABLE workspace_identity ADD COLUMN icon TEXT;
ALTER TABLE workspace_identity ADD COLUMN color TEXT;
PRAGMA user_version=13;
COMMIT;
