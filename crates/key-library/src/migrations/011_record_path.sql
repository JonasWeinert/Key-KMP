BEGIN IMMEDIATE;
CREATE INDEX workspace_record_path ON workspace_records(json_extract(properties,'$.path')) WHERE kind!='source';
PRAGMA user_version=11;
COMMIT;
