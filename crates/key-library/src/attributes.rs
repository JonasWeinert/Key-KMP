use crate::{Library,Result,err};
impl Library {
    pub fn delete_workspace_attribute(&self,name:&str,delete_values:bool)->Result<usize>{
        if name.is_empty()||name.len()>128{return Err("Invalid attribute name".into())}
        let name=name.to_owned();
        self.writer.run(true,move|c|{
            let tx=c.transaction().map_err(err)?;
            tx.execute("DELETE FROM workspace_attributes WHERE name=?1",[&name]).map_err(err)?;
            tx.execute("DELETE FROM workspace_agent_properties WHERE name=?1",[&name]).map_err(err)?;
            let affected=if delete_values{
                // Existing triggers remove each value from extra_metadata_fts atomically.
                let count=tx.execute("DELETE FROM document_properties WHERE name=?1",[&name]).map_err(err)?;
                tx.execute("DELETE FROM property_definitions WHERE name=?1",[&name]).map_err(err)?;
                tx.execute("DELETE FROM workspace_property_provenance WHERE name=?1",[&name]).map_err(err)?;
                count
            }else{0};
            tx.commit().map_err(err)?;Ok(affected)
        })
    }
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn delete_attribute_clears_values_and_search_but_preserves_other_properties(){
        let temp=tempfile::tempdir().unwrap();let lib=Library::open(temp.path()).unwrap();let hash=crate::content_hash(b"paper");lib.register(&hash,"Paper",1).unwrap();
        lib.set_property(&hash,"Topic",&serde_json::json!("uniqueneedle")).unwrap();lib.set_property(&hash,"Rating",&serde_json::json!(4)).unwrap();
        assert_eq!(lib.delete_workspace_attribute("Topic",true).unwrap(),1);
        let c=lib.connection().unwrap();assert_eq!(c.query_row("SELECT count(*) FROM extra_metadata_fts WHERE extra_metadata_fts MATCH 'uniqueneedle'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        assert_eq!(c.query_row("SELECT count(*) FROM document_properties WHERE name='Rating'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    }
}
