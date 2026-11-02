BEGIN IMMEDIATE;
CREATE VIRTUAL TABLE extra_metadata_fts USING fts5(document_hash UNINDEXED,kind UNINDEXED,key,value);
INSERT INTO extra_metadata_fts SELECT document_hash,'property',name,json_extract(value,'$') FROM document_properties;
INSERT INTO extra_metadata_fts SELECT document_hash,kind,name,name FROM document_labels;
CREATE TRIGGER property_search_insert AFTER INSERT ON document_properties BEGIN
 INSERT INTO extra_metadata_fts VALUES(new.document_hash,'property',new.name,json_extract(new.value,'$'));
END;
CREATE TRIGGER property_search_update AFTER UPDATE ON document_properties BEGIN
 DELETE FROM extra_metadata_fts WHERE document_hash=old.document_hash AND kind='property' AND key=old.name;
 INSERT INTO extra_metadata_fts VALUES(new.document_hash,'property',new.name,json_extract(new.value,'$'));
END;
CREATE TRIGGER property_search_delete AFTER DELETE ON document_properties BEGIN
 DELETE FROM extra_metadata_fts WHERE document_hash=old.document_hash AND kind='property' AND key=old.name;
END;
CREATE TRIGGER label_search_insert AFTER INSERT ON document_labels BEGIN
 INSERT INTO extra_metadata_fts VALUES(new.document_hash,new.kind,new.name,new.name);
END;
CREATE TRIGGER label_search_delete AFTER DELETE ON document_labels BEGIN
 DELETE FROM extra_metadata_fts WHERE document_hash=old.document_hash AND kind=old.kind AND key=old.name;
END;
PRAGMA user_version=6;
COMMIT;
