//! Raw tagged-PDF inspection and conservative fusion with reconstructed tables.
//!
//! PDFium remains the source of visible text and geometry. `lopdf` is used for
//! information that PDFium's public page-scoped API does not preserve: exact
//! indirect object identity, mixed `/K` order, full MCR/OBJR dictionaries,
//! RoleMap/ClassMap, ParentTree diagnostics, and recovery from broken indexes.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::path::Path;

use anyhow::{Context, Result};
use lopdf::{content::Content, Dictionary, Document as LoDocument, Object, ObjectId};
use serde::{Deserialize, Serialize};

use crate::model::{BBox, Block, Page, SemanticRegion, TableCell};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum TableReconciliationMode {
    GeometryOnly,
    TreeOnly,
    #[default]
    Fused,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct PdfStructureReport {
    pub pdf_version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub producer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub creator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub producer_family: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub page_labels: Vec<String>,
    pub marked: bool,
    pub has_struct_tree_root: bool,
    pub has_parent_tree: bool,
    pub has_role_map: bool,
    pub has_class_map: bool,
    pub recovery_used: bool,
    pub structure_elements: usize,
    pub parent_tree_entries: usize,
    pub tag_counts: BTreeMap<String, usize>,
    pub unusual_tag_counts: BTreeMap<String, usize>,
    pub attribute_key_counts: BTreeMap<String, usize>,
    pub structure_key_counts: BTreeMap<String, usize>,
    /// Inventory of every direct or nested `/K` child kind across the full
    /// structure graph, not only recognized table nodes.
    pub kid_kind_counts: BTreeMap<String, usize>,
    pub object_type_counts: BTreeMap<String, usize>,
    pub catalog_features: BTreeMap<String, bool>,
    pub role_map: BTreeMap<String, String>,
    pub namespaces: BTreeMap<String, usize>,
    pub marked_content_tags: BTreeMap<String, usize>,
    pub form_xobjects: usize,
    pub form_marked_sequences: usize,
    pub pages: Vec<PageStructureEvidence>,
    /// Complete retained logical structure graph. Unlike `tables`, this keeps
    /// every structure element and its exact ordered `/K` children.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub nodes: Vec<StructureNodeEvidence>,
    pub tables: Vec<TaggedTableEvidence>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub anomalies: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub reconciliations: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct PageStructureEvidence {
    pub page: usize,
    pub object_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub struct_parents: Option<i64>,
    pub content_streams: usize,
    pub marked_sequences: usize,
    pub artifacts: usize,
    pub mcids: Vec<i64>,
    pub tags: BTreeMap<String, usize>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub regions: Vec<MarkedContentRegionEvidence>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct StructureNodeEvidence {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    pub raw_role: String,
    pub canonical_role: String,
    pub tree_order: usize,
    pub depth: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox_pdf: Option<[f32; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    pub attributes: BTreeMap<String, String>,
    pub children: Vec<StructureChildEvidence>,
    pub content_refs: Vec<MarkedContentRef>,
    pub object_refs: Vec<ObjectReference>,
    pub recovered: bool,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct StructureChildEvidence {
    pub order: usize,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcid: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub object_id: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct MarkedContentRegionEvidence {
    pub tag: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mcid: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox_pdf: Option<[f32; 4]>,
    pub source: String,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct TaggedTableEvidence {
    pub id: String,
    pub raw_role: String,
    pub canonical_role: String,
    pub source: String,
    pub tree_order: usize,
    pub pages: Vec<usize>,
    pub rows: usize,
    pub cells: usize,
    pub header_cells: usize,
    pub row_spans: usize,
    pub column_spans: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox_pdf: Option<[f32; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt_text: Option<String>,
    pub child_roles: BTreeMap<String, usize>,
    pub content_refs: Vec<MarkedContentRef>,
    pub object_refs: Vec<ObjectReference>,
    pub cells_detail: Vec<TaggedCellEvidence>,
    pub confidence: f32,
    pub evidence: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct TaggedCellEvidence {
    pub id: String,
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<usize>,
    pub row_span: usize,
    pub column_span: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bbox_pdf: Option<[f32; 4]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual_text: Option<String>,
    pub content_refs: Vec<MarkedContentRef>,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct MarkedContentRef {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<usize>,
    pub owner: String,
    pub mcid: i64,
    pub child_order: usize,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct ObjectReference {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<usize>,
    pub object_id: String,
    pub child_order: usize,
}

struct Inspector<'a> {
    doc: &'a LoDocument,
    pages_by_id: HashMap<ObjectId, usize>,
    role_map: BTreeMap<String, String>,
    namespace_role_maps: HashMap<ObjectId, BTreeMap<String, String>>,
    class_map: Option<&'a Dictionary>,
    struct_ids: BTreeSet<ObjectId>,
    reverse_children: HashMap<ObjectId, Vec<ObjectId>>,
    tag_counts: BTreeMap<String, usize>,
    unusual_tag_counts: BTreeMap<String, usize>,
    attribute_key_counts: BTreeMap<String, usize>,
    structure_key_counts: BTreeMap<String, usize>,
    kid_kind_counts: BTreeMap<String, usize>,
    anomalies: Vec<String>,
}

pub fn inspect(path: &Path, password: Option<&str>) -> Result<PdfStructureReport> {
    let mut doc =
        LoDocument::load(path).with_context(|| format!("raw-parse {}", path.display()))?;
    if doc.is_encrypted() {
        doc.decrypt(password.unwrap_or(""))
            .context("decrypt raw PDF structure")?;
    }
    inspect_document(&doc)
}

fn inspect_document(doc: &LoDocument) -> Result<PdfStructureReport> {
    let catalog = root_dictionary(doc)?;
    let struct_root = catalog
        .get(b"StructTreeRoot")
        .ok()
        .and_then(|object| deref_dict(doc, object));
    let role_map = struct_root
        .and_then(|root| root.get(b"RoleMap").ok())
        .and_then(|object| deref_dict(doc, object))
        .map(read_name_map)
        .unwrap_or_default();
    let class_map = struct_root
        .and_then(|root| root.get(b"ClassMap").ok())
        .and_then(|object| deref_dict(doc, object));
    let (namespaces, namespace_role_maps) = read_namespaces(doc);
    let pages = doc.get_pages();
    let pages_by_id = pages
        .iter()
        .map(|(number, id)| (*id, *number as usize))
        .collect::<HashMap<_, _>>();
    let struct_ids = scan_structure_ids(doc);
    let reverse_children = build_reverse_children(doc, &struct_ids);
    let mut inspector = Inspector {
        doc,
        pages_by_id,
        role_map: role_map.clone(),
        namespace_role_maps,
        class_map,
        struct_ids,
        reverse_children,
        tag_counts: BTreeMap::new(),
        unusual_tag_counts: BTreeMap::new(),
        attribute_key_counts: BTreeMap::new(),
        structure_key_counts: BTreeMap::new(),
        kid_kind_counts: BTreeMap::new(),
        anomalies: Vec::new(),
    };
    inspector.inventory_structure_elements();

    let mut recovery_used = false;
    let mut roots = struct_root
        .and_then(|root| root.get(b"K").ok())
        .map(|object| referenced_structure_ids(doc, object))
        .unwrap_or_default();
    if roots.is_empty() && !inspector.struct_ids.is_empty() {
        recovery_used = true;
        roots = inspector.recovery_roots();
        inspector.anomalies.push(
            "structure roots recovered by scanning StructElem objects and reverse /P links".into(),
        );
    }

    let mut table_ids = Vec::<(usize, ObjectId, String)>::new();
    let mut visited = HashSet::new();
    let mut order = 0;
    let graph_roots = roots.clone();
    for root in roots {
        inspector.find_tables(root, &mut visited, &mut order, &mut table_ids, false);
    }
    // Orphaned table-like nodes remain useful even when the main `/K` graph is
    // broken. Add them after the ordered tree walk and mark their source.
    for id in inspector.struct_ids.clone() {
        if visited.contains(&id) {
            continue;
        }
        if inspector
            .element_role(id)
            .is_some_and(|(_, canonical)| is_table_role(&canonical))
        {
            recovery_used = true;
            order += 1;
            table_ids.push((order, id, "orphan_scan".into()));
        }
    }

    let tables = table_ids
        .into_iter()
        .filter_map(|(tree_order, id, source)| inspector.build_table(id, tree_order, source))
        .collect::<Vec<_>>();
    let nodes = inspector.build_structure_graph(&graph_roots);
    let (page_reports, marked_content_tags, form_xobjects, form_marked_sequences) =
        inspect_content_streams(doc, &pages);
    let parent_tree = struct_root
        .and_then(|root| root.get(b"ParentTree").ok())
        .and_then(|object| deref_object(doc, object));
    let parent_tree_entries = parent_tree
        .map(|object| count_number_tree_entries(doc, object, &mut HashSet::new()))
        .unwrap_or(0);
    if struct_root.is_some() && parent_tree.is_none() {
        inspector
            .anomalies
            .push("StructTreeRoot exists without a readable ParentTree".into());
    }

    let info = doc
        .trailer
        .get(b"Info")
        .ok()
        .and_then(|object| deref_dict(doc, object));
    let marked = catalog
        .get(b"MarkInfo")
        .ok()
        .and_then(|object| deref_dict(doc, object))
        .and_then(|dict| dict.get(b"Marked").ok())
        .and_then(|object| object.as_bool().ok())
        .unwrap_or(false);

    let producer = info.and_then(|dict| dict_string(dict, b"Producer"));
    let creator = info.and_then(|dict| dict_string(dict, b"Creator"));
    let page_labels = read_page_labels(doc, catalog, pages.len());
    Ok(PdfStructureReport {
        pdf_version: doc.version.clone(),
        producer_family: producer_family(producer.as_deref(), creator.as_deref()),
        producer,
        creator,
        language: dict_string(catalog, b"Lang"),
        page_labels,
        marked,
        has_struct_tree_root: struct_root.is_some(),
        has_parent_tree: parent_tree.is_some(),
        has_role_map: !role_map.is_empty(),
        has_class_map: class_map.is_some(),
        recovery_used,
        structure_elements: inspector.struct_ids.len(),
        parent_tree_entries,
        tag_counts: inspector.tag_counts,
        unusual_tag_counts: inspector.unusual_tag_counts,
        attribute_key_counts: inspector.attribute_key_counts,
        structure_key_counts: inspector.structure_key_counts,
        kid_kind_counts: inspector.kid_kind_counts,
        object_type_counts: object_type_inventory(doc),
        catalog_features: catalog_feature_inventory(catalog),
        role_map,
        namespaces,
        marked_content_tags,
        form_xobjects,
        form_marked_sequences,
        pages: page_reports,
        nodes,
        tables,
        anomalies: inspector.anomalies,
        reconciliations: Vec::new(),
    })
}

impl Inspector<'_> {
    fn build_structure_graph(&self, roots: &[ObjectId]) -> Vec<StructureNodeEvidence> {
        let mut positions = HashMap::<ObjectId, (usize, usize, bool)>::new();
        let mut order = 0;
        for root in roots {
            self.assign_tree_positions(*root, 0, false, &mut order, &mut positions);
        }
        for id in &self.struct_ids {
            if !positions.contains_key(id) {
                self.assign_tree_positions(*id, 0, true, &mut order, &mut positions);
            }
        }
        let mut ids = self.struct_ids.iter().copied().collect::<Vec<_>>();
        ids.sort_by_key(|id| positions.get(id).map_or(usize::MAX, |value| value.0));
        ids.into_iter()
            .filter_map(|id| self.build_structure_node(id, &positions))
            .collect()
    }

    fn assign_tree_positions(
        &self,
        id: ObjectId,
        depth: usize,
        recovered: bool,
        order: &mut usize,
        positions: &mut HashMap<ObjectId, (usize, usize, bool)>,
    ) {
        if positions.contains_key(&id) {
            return;
        }
        *order += 1;
        positions.insert(id, (*order, depth, recovered));
        let explicit = self.explicit_struct_children(id);
        for child in &explicit {
            self.assign_tree_positions(*child, depth + 1, recovered, order, positions);
        }
        if let Some(reverse) = self.reverse_children.get(&id) {
            for child in reverse {
                if !explicit.contains(child) {
                    self.assign_tree_positions(*child, depth + 1, true, order, positions);
                }
            }
        }
    }

    fn build_structure_node(
        &self,
        id: ObjectId,
        positions: &HashMap<ObjectId, (usize, usize, bool)>,
    ) -> Option<StructureNodeEvidence> {
        let dict = self.doc.get_dictionary(id).ok()?;
        let (raw_role, canonical_role) = self.element_role(id)?;
        let (tree_order, depth, recovered) = positions.get(&id).copied().unwrap_or_default();
        let inherited_page = dict.get(b"Pg").ok().and_then(object_reference);
        let mut children = Vec::new();
        if let Ok(kids) = dict.get(b"K") {
            self.structure_children(kids, inherited_page, &mut children);
        }
        let mut refs = Vec::new();
        let mut objects = Vec::new();
        self.collect_content_refs(id, None, 0, &mut HashSet::new(), &mut refs, &mut objects);
        deduplicate_content_refs(&mut refs);
        let attributes = self
            .attribute_dicts(dict)
            .into_iter()
            .flat_map(|attributes| attributes.iter())
            .map(|(key, value)| (name(key), compact_object(value)))
            .collect();
        Some(StructureNodeEvidence {
            id: object_id(id),
            parent_id: dict
                .get(b"P")
                .ok()
                .and_then(object_reference)
                .filter(|parent| self.struct_ids.contains(parent))
                .map(object_id),
            raw_role,
            canonical_role,
            tree_order,
            depth,
            page: self.element_page(dict),
            bbox_pdf: self.element_bbox(dict),
            title: dict_string(dict, b"T"),
            alt_text: dict_string(dict, b"Alt"),
            actual_text: dict_string(dict, b"ActualText"),
            language: dict_string(dict, b"Lang"),
            attributes,
            children,
            content_refs: refs,
            object_refs: objects,
            recovered,
        })
    }

    fn structure_children(
        &self,
        value: &Object,
        inherited_page: Option<ObjectId>,
        output: &mut Vec<StructureChildEvidence>,
    ) {
        if let Object::Array(values) = value {
            for child in values {
                self.structure_children(child, inherited_page, output);
            }
            return;
        }
        let order = output.len() + 1;
        let mut evidence = StructureChildEvidence {
            order,
            ..Default::default()
        };
        match value {
            Object::Integer(mcid) => {
                evidence.kind = "mcid".into();
                evidence.mcid = Some(*mcid);
                evidence.page = inherited_page.and_then(|id| self.pages_by_id.get(&id).copied());
                evidence.owner = inherited_page.map(object_id);
            }
            Object::Reference(id) if self.struct_ids.contains(id) => {
                evidence.kind = "structure".into();
                evidence.node_id = Some(object_id(*id));
            }
            Object::Reference(id) => {
                if let Ok(object) = self.doc.get_object(*id) {
                    self.structure_children(object, inherited_page, output);
                    return;
                }
                evidence.kind = "reference".into();
                evidence.object_id = Some(object_id(*id));
            }
            Object::Dictionary(dict) => {
                let kind = dict_name(dict, b"Type").unwrap_or_default();
                let page = dict
                    .get(b"Pg")
                    .ok()
                    .and_then(object_reference)
                    .or(inherited_page);
                if kind == "MCR" || dict.get(b"MCID").is_ok() {
                    evidence.kind = "mcr".into();
                    evidence.mcid = dict
                        .get(b"MCID")
                        .ok()
                        .and_then(|object| object.as_i64().ok());
                    evidence.page = page.and_then(|id| self.pages_by_id.get(&id).copied());
                    evidence.owner = dict
                        .get(b"Stm")
                        .ok()
                        .and_then(object_reference)
                        .or(page)
                        .map(object_id);
                } else if kind == "OBJR" || dict.get(b"Obj").is_ok() {
                    evidence.kind = "objr".into();
                    evidence.page = page.and_then(|id| self.pages_by_id.get(&id).copied());
                    evidence.object_id = dict
                        .get(b"Obj")
                        .ok()
                        .and_then(object_reference)
                        .map(object_id);
                } else {
                    evidence.kind = "dictionary".into();
                }
            }
            _ => evidence.kind = "other".into(),
        }
        output.push(evidence);
    }

    fn inventory_structure_elements(&mut self) {
        for id in self.struct_ids.clone() {
            let Ok(dict) = self.doc.get_dictionary(id) else {
                continue;
            };
            for (key, _) in dict.iter() {
                increment(&mut self.structure_key_counts, name(key));
            }
            if let Ok(kids) = dict.get(b"K") {
                inventory_kinds(self.doc, &self.struct_ids, kids, &mut self.kid_kind_counts);
            }
            if let Some((raw, canonical)) = self.element_role(id) {
                increment(&mut self.tag_counts, canonical.clone());
                if !is_standard_structure_role(&canonical) || raw != canonical {
                    increment(&mut self.unusual_tag_counts, raw);
                }
            }
            let attribute_keys = self
                .attribute_dicts(dict)
                .into_iter()
                .flat_map(|attrs| attrs.iter().map(|(key, _)| name(key)))
                .collect::<Vec<_>>();
            for key in attribute_keys {
                increment(&mut self.attribute_key_counts, key);
            }
        }
    }

    fn recovery_roots(&self) -> Vec<ObjectId> {
        self.struct_ids
            .iter()
            .filter(|id| {
                self.doc
                    .get_dictionary(**id)
                    .ok()
                    .and_then(|dict| dict.get(b"P").ok())
                    .and_then(object_reference)
                    .is_none_or(|parent| !self.struct_ids.contains(&parent))
            })
            .copied()
            .collect()
    }

    fn find_tables(
        &self,
        id: ObjectId,
        visited: &mut HashSet<ObjectId>,
        order: &mut usize,
        tables: &mut Vec<(usize, ObjectId, String)>,
        recovered_edge: bool,
    ) {
        if !visited.insert(id) {
            return;
        }
        *order += 1;
        if self
            .element_role(id)
            .is_some_and(|(_, canonical)| is_table_role(&canonical))
        {
            tables.push((
                *order,
                id,
                if recovered_edge {
                    "reverse_parent_recovery"
                } else {
                    "struct_tree"
                }
                .into(),
            ));
        }
        let explicit = self.explicit_struct_children(id);
        for child in &explicit {
            self.find_tables(*child, visited, order, tables, recovered_edge);
        }
        if let Some(reverse) = self.reverse_children.get(&id) {
            for child in reverse {
                if !explicit.contains(child) {
                    self.find_tables(*child, visited, order, tables, true);
                }
            }
        }
    }

    fn build_table(
        &self,
        id: ObjectId,
        tree_order: usize,
        source: String,
    ) -> Option<TaggedTableEvidence> {
        let dict = self.doc.get_dictionary(id).ok()?;
        let (raw_role, canonical_role) = self.element_role(id)?;
        let mut descendants = Vec::new();
        self.descendants(id, &mut HashSet::new(), &mut descendants);
        let mut child_roles = BTreeMap::new();
        let mut cells_detail = Vec::new();
        let mut rows = 0;
        for child in &descendants {
            if let Some((_, role)) = self.element_role(*child) {
                increment(&mut child_roles, role.clone());
                if is_row_role(&role) {
                    rows += 1;
                }
                if is_cell_role(&role) {
                    if let Some(cell) = self.build_cell(*child, &role) {
                        cells_detail.push(cell);
                    }
                }
            }
        }
        let mut refs = Vec::new();
        let mut obj_refs = Vec::new();
        self.collect_content_refs(id, None, 0, &mut HashSet::new(), &mut refs, &mut obj_refs);
        deduplicate_content_refs(&mut refs);
        let pages = refs
            .iter()
            .filter_map(|reference| reference.page)
            .chain(cells_detail.iter().filter_map(|cell| cell.page))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>();
        let bbox_pdf = self.element_bbox(dict).or_else(|| {
            cells_detail
                .iter()
                .filter_map(|cell| cell.bbox_pdf)
                .reduce(union_pdf_bbox)
        });
        let header_cells = cells_detail.iter().filter(|cell| cell.role == "TH").count();
        let row_spans = cells_detail.iter().filter(|cell| cell.row_span > 1).count();
        let column_spans = cells_detail
            .iter()
            .filter(|cell| cell.column_span > 1)
            .count();
        let mut evidence = vec![format!("role:{canonical_role}")];
        let mut confidence: f32 = if canonical_role == "Table" {
            0.82
        } else {
            0.56
        };
        if rows > 0 {
            confidence += 0.07;
            evidence.push(format!("rows:{rows}"));
        }
        if !cells_detail.is_empty() {
            confidence += 0.07;
            evidence.push(format!("cells:{}", cells_detail.len()));
        }
        if bbox_pdf.is_some() {
            confidence += 0.03;
            evidence.push("bbox".into());
        }
        if pages.len() > 1 {
            confidence += 0.01;
            evidence.push(format!("cross_page:{}", pages.len()));
        }
        Some(TaggedTableEvidence {
            id: object_id(id),
            raw_role,
            canonical_role,
            source,
            tree_order,
            pages,
            rows,
            cells: cells_detail.len(),
            header_cells,
            row_spans,
            column_spans,
            bbox_pdf,
            title: dict_string(dict, b"T"),
            alt_text: dict_string(dict, b"Alt"),
            child_roles,
            content_refs: refs,
            object_refs: obj_refs,
            cells_detail,
            confidence: confidence.min(0.99),
            evidence,
        })
    }

    fn build_cell(&self, id: ObjectId, role: &str) -> Option<TaggedCellEvidence> {
        let dict = self.doc.get_dictionary(id).ok()?;
        let mut refs = Vec::new();
        let mut objects = Vec::new();
        self.collect_content_refs(id, None, 0, &mut HashSet::new(), &mut refs, &mut objects);
        deduplicate_content_refs(&mut refs);
        let attrs = self.attribute_dicts(dict);
        let row_span = attribute_number(&attrs, b"RowSpan").unwrap_or(1).max(1) as usize;
        let column_span = attribute_number(&attrs, b"ColSpan").unwrap_or(1).max(1) as usize;
        let scope = attribute_name_or_string(&attrs, b"Scope");
        let bbox_pdf = self.element_bbox(dict);
        let page = refs
            .iter()
            .find_map(|reference| reference.page)
            .or_else(|| self.element_page(dict));
        Some(TaggedCellEvidence {
            id: object_id(id),
            role: role.into(),
            page,
            row_span,
            column_span,
            scope,
            bbox_pdf,
            actual_text: dict_string(dict, b"ActualText").or_else(|| dict_string(dict, b"Alt")),
            content_refs: refs,
        })
    }

    fn descendants(&self, id: ObjectId, visited: &mut HashSet<ObjectId>, out: &mut Vec<ObjectId>) {
        if !visited.insert(id) {
            return;
        }
        let mut children = self.explicit_struct_children(id);
        if let Some(reverse) = self.reverse_children.get(&id) {
            for child in reverse {
                if !children.contains(child) {
                    children.push(*child);
                }
            }
        }
        for child in children {
            out.push(child);
            self.descendants(child, visited, out);
        }
    }

    fn explicit_struct_children(&self, id: ObjectId) -> Vec<ObjectId> {
        self.doc
            .get_dictionary(id)
            .ok()
            .and_then(|dict| dict.get(b"K").ok())
            .map(|object| referenced_structure_ids(self.doc, object))
            .unwrap_or_default()
    }

    fn collect_content_refs(
        &self,
        id: ObjectId,
        inherited_page: Option<ObjectId>,
        mut order: usize,
        visited: &mut HashSet<ObjectId>,
        refs: &mut Vec<MarkedContentRef>,
        objects: &mut Vec<ObjectReference>,
    ) {
        if !visited.insert(id) {
            return;
        }
        let Ok(dict) = self.doc.get_dictionary(id) else {
            return;
        };
        let page = dict
            .get(b"Pg")
            .ok()
            .and_then(object_reference)
            .or(inherited_page);
        if let Ok(kids) = dict.get(b"K") {
            let values = match kids {
                Object::Array(values) => values.as_slice(),
                value => std::slice::from_ref(value),
            };
            for value in values {
                order += 1;
                self.collect_k_value(value, page, order, visited, refs, objects);
            }
        }
    }

    fn collect_k_value(
        &self,
        value: &Object,
        inherited_page: Option<ObjectId>,
        order: usize,
        visited: &mut HashSet<ObjectId>,
        refs: &mut Vec<MarkedContentRef>,
        objects: &mut Vec<ObjectReference>,
    ) {
        match value {
            Object::Integer(mcid) => refs.push(MarkedContentRef {
                page: inherited_page.and_then(|id| self.pages_by_id.get(&id).copied()),
                owner: inherited_page
                    .map(object_id)
                    .unwrap_or_else(|| "unknown".into()),
                mcid: *mcid,
                child_order: order,
            }),
            Object::Reference(id) => {
                let Ok(object) = self.doc.get_object(*id) else {
                    return;
                };
                if object.as_dict().ok().is_some_and(is_structure_dict) {
                    self.collect_content_refs(*id, inherited_page, order, visited, refs, objects);
                } else {
                    self.collect_k_value(object, inherited_page, order, visited, refs, objects);
                }
            }
            Object::Dictionary(dict) => {
                let kind = dict_name(dict, b"Type").unwrap_or_default();
                if kind == "MCR" || dict.get(b"MCID").is_ok() {
                    let page = dict
                        .get(b"Pg")
                        .ok()
                        .and_then(object_reference)
                        .or(inherited_page);
                    let owner = dict
                        .get(b"Stm")
                        .ok()
                        .and_then(object_reference)
                        .or(page)
                        .map(object_id)
                        .unwrap_or_else(|| "unknown".into());
                    if let Some(mcid) = dict
                        .get(b"MCID")
                        .ok()
                        .and_then(|object| object.as_i64().ok())
                    {
                        refs.push(MarkedContentRef {
                            page: page.and_then(|id| self.pages_by_id.get(&id).copied()),
                            owner,
                            mcid,
                            child_order: order,
                        });
                    }
                } else if kind == "OBJR" || dict.get(b"Obj").is_ok() {
                    if let Some(id) = dict.get(b"Obj").ok().and_then(object_reference) {
                        let page = dict
                            .get(b"Pg")
                            .ok()
                            .and_then(object_reference)
                            .or(inherited_page)
                            .and_then(|id| self.pages_by_id.get(&id).copied());
                        objects.push(ObjectReference {
                            page,
                            object_id: object_id(id),
                            child_order: order,
                        });
                    }
                }
            }
            Object::Array(values) => {
                for (offset, value) in values.iter().enumerate() {
                    self.collect_k_value(
                        value,
                        inherited_page,
                        order + offset,
                        visited,
                        refs,
                        objects,
                    );
                }
            }
            _ => {}
        }
    }

    fn element_role(&self, id: ObjectId) -> Option<(String, String)> {
        let dict = self.doc.get_dictionary(id).ok()?;
        let raw = dict_name(dict, b"S")?;
        let mut canonical = raw.clone();
        let mut seen = HashSet::new();
        let namespace_map = dict
            .get(b"NS")
            .ok()
            .and_then(object_reference)
            .and_then(|namespace| self.namespace_role_maps.get(&namespace));
        while let Some(mapped) = namespace_map
            .and_then(|map| map.get(&canonical))
            .or_else(|| self.role_map.get(&canonical))
        {
            if !seen.insert(canonical.clone()) {
                break;
            }
            canonical = mapped.clone();
        }
        Some((raw, canonical))
    }

    fn element_page(&self, dict: &Dictionary) -> Option<usize> {
        dict.get(b"Pg")
            .ok()
            .and_then(object_reference)
            .and_then(|id| self.pages_by_id.get(&id).copied())
    }

    fn attribute_dicts<'a>(&'a self, dict: &'a Dictionary) -> Vec<&'a Dictionary> {
        let mut out = Vec::new();
        if let Ok(attrs) = dict.get(b"A") {
            collect_dictionaries(self.doc, attrs, &mut out);
        }
        if let (Some(class_map), Ok(classes)) = (self.class_map, dict.get(b"C")) {
            let values = match classes {
                Object::Array(values) => values.as_slice(),
                value => std::slice::from_ref(value),
            };
            for class in values {
                if let Ok(name) = class.as_name() {
                    if let Ok(attrs) = class_map.get(name) {
                        collect_dictionaries(self.doc, attrs, &mut out);
                    }
                }
            }
        }
        out
    }

    fn element_bbox(&self, dict: &Dictionary) -> Option<[f32; 4]> {
        dict.get(b"BBox")
            .ok()
            .and_then(pdf_bbox)
            .or_else(|| attribute_bbox(&self.attribute_dicts(dict)))
    }
}

/// Merge only strongly aligned geometric fragments on pages for which one
/// tagged table supplies independent semantic identity. Untagged documents are
/// byte-for-byte unaffected by this pass.
pub fn reconcile(
    report: &mut PdfStructureReport,
    pages: &mut [Page],
    mode: TableReconciliationMode,
    tree_trust_threshold: f32,
) {
    let trust_scores = report
        .tables
        .iter()
        .map(|table| (table.id.clone(), table_trust_score(report, table, pages)))
        .collect::<HashMap<_, _>>();
    let column_envelopes = report
        .tables
        .iter()
        .map(|table| (table.id.clone(), table_column_envelopes(table, pages)))
        .collect::<HashMap<_, _>>();
    if mode == TableReconciliationMode::TreeOnly {
        for page in pages.iter_mut() {
            page.blocks
                .retain(|block| !matches!(block, Block::Table { .. }));
        }
    }
    for page in pages.iter_mut() {
        let semantic = report
            .tables
            .iter()
            .filter(|table| table.pages.contains(&page.number) && table.confidence >= 0.65)
            .cloned()
            .collect::<Vec<_>>();
        if semantic.is_empty() {
            continue;
        }
        for tagged in &semantic {
            let trust = trust_scores.get(&tagged.id).copied().unwrap_or(0.0);
            let envelopes = column_envelopes
                .get(&tagged.id)
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let repaired = match mode {
                TableReconciliationMode::GeometryOnly => false,
                TableReconciliationMode::TreeOnly => {
                    trust >= tree_trust_threshold
                        && create_table_from_mcid_geometry(page, tagged, trust, envelopes)
                }
                TableReconciliationMode::Fused => {
                    (trust >= tree_trust_threshold
                        && create_table_from_mcid_geometry(page, tagged, trust, envelopes))
                        || repair_tagged_grid(page, tagged)
                        || repair_tagged_grid_from_structure(page, tagged)
                }
            };
            if repaired {
                report.reconciliations.push(format!(
                    "page {}: rebuilt table using {}x{} tagged table {} (trust {:.3}, mode {:?})",
                    page.number,
                    tagged.rows,
                    tagged.cells / tagged.rows.max(1),
                    tagged.id,
                    trust,
                    mode,
                ));
            }
        }
        let table_indices = page
            .blocks
            .iter()
            .enumerate()
            .filter_map(|(index, block)| matches!(block, Block::Table { .. }).then_some(index))
            .collect::<Vec<_>>();
        for tagged in &semantic {
            if mode == TableReconciliationMode::TreeOnly {
                continue;
            }
            let candidates = if let Some(raw_bbox) = tagged.bbox_pdf {
                let tagged_bbox = pdf_bbox_to_page(raw_bbox, page.height);
                table_indices
                    .iter()
                    .copied()
                    .filter(|index| {
                        overlap_fraction(page.blocks[*index].bbox(), tagged_bbox) >= 0.2
                    })
                    .collect::<Vec<_>>()
            } else if report
                .tables
                .iter()
                .filter(|table| table.pages.contains(&page.number) && table.confidence >= 0.65)
                .count()
                == 1
            {
                best_vertical_run(page, &table_indices, tagged)
            } else {
                Vec::new()
            };
            if candidates.len() < 2 {
                continue;
            }
            if let Some(merged) = merge_table_fragments(page, &candidates) {
                let first = candidates[0];
                let remove = candidates[1..].iter().copied().collect::<HashSet<_>>();
                let mut replacement = Some(merged);
                let mut blocks = Vec::with_capacity(page.blocks.len() - remove.len());
                for (index, block) in page.blocks.drain(..).enumerate() {
                    if index == first {
                        blocks.push(replacement.take().expect("one merged replacement"));
                    } else if !remove.contains(&index) {
                        blocks.push(block);
                    }
                }
                page.blocks = blocks;
                report.reconciliations.push(format!(
                    "page {}: merged {} aligned geometric fragments using tagged table {}",
                    page.number,
                    candidates.len(),
                    tagged.id
                ));
                break;
            }
        }
        for tagged in &semantic {
            assign_semantic_identity(page, tagged, semantic.len() == 1);
        }
    }
    reconcile_general_structure(report, pages);
    suppress_repeated_visual_headers(report, pages);
}

fn reconcile_general_structure(report: &mut PdfStructureReport, pages: &mut [Page]) {
    let mut bbox_frequency = HashMap::<String, usize>::new();
    for node in &report.nodes {
        if let Some(bbox) = node.bbox_pdf {
            *bbox_frequency.entry(bbox_key(bbox)).or_insert(0) += 1;
        }
    }
    for page in pages {
        let nodes = report
            .nodes
            .iter()
            .filter(|node| node.page == Some(page.number))
            .collect::<Vec<_>>();
        for node in nodes {
            let mcid_bbox = structure_node_mcid_bbox(node, page);
            let attribute_bbox = node.bbox_pdf.and_then(|raw_bbox| {
                (bbox_frequency
                    .get(&bbox_key(raw_bbox))
                    .copied()
                    .unwrap_or(0)
                    <= 1)
                    .then(|| pdf_bbox_to_page(raw_bbox, page.height))
            });
            let Some(bbox) = mcid_bbox.or(attribute_bbox) else {
                continue;
            };
            if !valid_page_bbox(bbox, page) {
                continue;
            }
            let role = node.canonical_role.as_str();
            let visible_support = page
                .blocks
                .iter()
                .filter(|block| overlap_fraction(block.bbox(), bbox) >= 0.5)
                .count()
                + page
                    .images
                    .iter()
                    .filter(|image| overlap_fraction(**image, bbox) >= 0.35)
                    .count();
            if visible_support == 0 && mcid_bbox.is_none() {
                continue;
            }
            let (confidence, source) = if mcid_bbox.is_some() {
                (0.94, "pdfium_page_object_mcid")
            } else if node.content_refs.is_empty() {
                (0.7, "structure_tree_bbox")
            } else {
                (0.84, "structure_tree_bbox")
            };
            page.semantic_regions.push(SemanticRegion {
                id: node.id.clone(),
                role: role.into(),
                bbox,
                confidence,
                source: source.into(),
                alt_text: node
                    .alt_text
                    .clone()
                    .or_else(|| is_figure_role(role).then(|| node.title.clone()).flatten()),
                label: None,
                caption: (role == "Caption")
                    .then(|| node.actual_text.clone().or_else(|| node.title.clone()))
                    .flatten(),
                target_id: (role == "Caption")
                    .then(|| node.parent_id.clone())
                    .flatten(),
                external_url: None,
            });
            if is_figure_role(role)
                && !page
                    .images
                    .iter()
                    .any(|image| overlap_fraction(*image, bbox) >= 0.8)
            {
                page.images.push(bbox);
            }
            if let Some(level) = heading_level(role) {
                apply_tagged_heading(page, bbox, level, node);
            }
        }
        if let Some(evidence) = report.pages.iter().find(|item| item.page == page.number) {
            for (index, region) in evidence.regions.iter().enumerate() {
                let mcid_bbox = region.mcid.and_then(|mcid| marked_object_bbox(page, mcid));
                let attribute_bbox = region
                    .bbox_pdf
                    .map(|bbox| pdf_bbox_to_page(bbox, page.height));
                let Some(bbox) = mcid_bbox.or(attribute_bbox) else {
                    continue;
                };
                if !valid_page_bbox(bbox, page) {
                    continue;
                }
                page.semantic_regions.push(SemanticRegion {
                    id: format!("page-{}-mark-{}", page.number, index + 1),
                    role: region.tag.clone(),
                    bbox,
                    confidence: if mcid_bbox.is_some() { 0.88 } else { 0.62 },
                    source: if mcid_bbox.is_some() {
                        "pdfium_page_object_mcid".into()
                    } else {
                        region.source.clone()
                    },
                    alt_text: None,
                    label: None,
                    caption: None,
                    target_id: None,
                    external_url: None,
                });
            }
        }
        deduplicate_semantic_regions(&mut page.semantic_regions);
        suppress_geometric_tables_inside_figures(page, &mut report.reconciliations);
    }
}

fn suppress_geometric_tables_inside_figures(page: &mut Page, log: &mut Vec<String>) {
    let figures = page
        .semantic_regions
        .iter()
        .filter(|region| is_figure_role(&region.role) && region.confidence >= 0.85)
        .map(|region| region.bbox)
        .collect::<Vec<_>>();
    if figures.is_empty() {
        return;
    }
    let before = page.blocks.len();
    page.blocks.retain(|block| match block {
        Block::Table {
            semantic_table_id: None,
            bbox,
            ..
        } => !figures
            .iter()
            .any(|figure| overlap_fraction(*bbox, *figure) >= 0.82),
        _ => true,
    });
    let removed = before - page.blocks.len();
    if removed > 0 {
        log.push(format!(
            "page {}: suppressed {} geometric table candidate(s) inside tagged figure regions",
            page.number, removed
        ));
    }
}

fn structure_node_mcid_bbox(node: &StructureNodeEvidence, page: &Page) -> Option<BBox> {
    node.content_refs
        .iter()
        .filter(|reference| reference.page == Some(page.number))
        .filter_map(|reference| marked_object_bbox(page, reference.mcid))
        .reduce(BBox::union)
}

fn marked_object_bbox(page: &Page, mcid: i64) -> Option<BBox> {
    page.marked_objects
        .iter()
        .filter(|object| object.mcid == mcid)
        .map(|object| object.bbox)
        .reduce(BBox::union)
}

fn apply_tagged_heading(page: &mut Page, bbox: BBox, level: u8, node: &StructureNodeEvidence) {
    let expected = node
        .actual_text
        .as_deref()
        .or(node.title.as_deref())
        .map(normalize_match_text);
    let candidate = page.blocks.iter().enumerate().find_map(|(index, block)| {
        if overlap_fraction(block.bbox(), bbox) < 0.72 {
            return None;
        }
        let matches_text = expected
            .as_ref()
            .is_none_or(|text| normalize_match_text(&block.text()).contains(text));
        (matches_text && matches!(block, Block::Paragraph { .. } | Block::Heading { .. }))
            .then_some(index)
    });
    let Some(index) = candidate else { return };
    let replacement = match &page.blocks[index] {
        Block::Paragraph { bbox, text, lines }
        | Block::Heading {
            bbox, text, lines, ..
        } => Some(Block::Heading {
            bbox: *bbox,
            text: text.clone(),
            level,
            lines: lines.clone(),
        }),
        _ => None,
    };
    if let Some(replacement) = replacement {
        page.blocks[index] = replacement;
    }
}

fn heading_level(role: &str) -> Option<u8> {
    role.strip_prefix('H')
        .and_then(|value| value.parse::<u8>().ok())
        .filter(|level| (1..=6).contains(level))
}

fn is_figure_role(role: &str) -> bool {
    matches!(role, "Figure" | "Formula" | "Chart" | "Diagram")
}

fn bbox_key(bbox: [f32; 4]) -> String {
    format!(
        "{:.1}:{:.1}:{:.1}:{:.1}",
        bbox[0], bbox[1], bbox[2], bbox[3]
    )
}

fn valid_page_bbox(bbox: BBox, page: &Page) -> bool {
    bbox.width >= 2.0
        && bbox.height >= 2.0
        && bbox.x >= -2.0
        && bbox.y >= -2.0
        && bbox.right() <= page.width + 2.0
        && bbox.bottom() <= page.height + 2.0
}

fn deduplicate_semantic_regions(regions: &mut Vec<SemanticRegion>) {
    let mut kept = Vec::<SemanticRegion>::new();
    for region in regions.drain(..) {
        if kept.iter().any(|other| {
            other.role == region.role && overlap_fraction(other.bbox, region.bbox) >= 0.92
        }) {
            continue;
        }
        kept.push(region);
    }
    *regions = kept;
}

fn suppress_repeated_visual_headers(report: &mut PdfStructureReport, pages: &mut [Page]) {
    let mut headers = HashMap::<String, Vec<String>>::new();
    for page in pages.iter() {
        for block in &page.blocks {
            if let Block::Table {
                cells,
                semantic_table_id: Some(id),
                continues_from_previous_page: false,
                ..
            } = block
            {
                let row = cells
                    .iter()
                    .filter(|cell| cell.row == 0 && !cell.text.trim().is_empty())
                    .map(|cell| normalize_match_text(&cell.text))
                    .collect::<Vec<_>>();
                if row.len() >= 2 {
                    headers.entry(id.clone()).or_insert(row);
                }
            }
        }
    }
    for page in pages.iter_mut() {
        let continuation = page.blocks.iter().find_map(|block| {
            if let Block::Table {
                bbox,
                semantic_table_id: Some(id),
                continues_from_previous_page: true,
                ..
            } = block
            {
                Some((id.clone(), *bbox))
            } else {
                None
            }
        });
        let Some((id, table_bbox)) = continuation else {
            continue;
        };
        let Some(header) = headers.get(&id) else {
            continue;
        };
        let remove = page
            .blocks
            .iter()
            .enumerate()
            .filter_map(|(index, block)| {
                if matches!(block, Block::Table { .. }) {
                    return None;
                }
                let bbox = block.bbox();
                let nearby_above = bbox.bottom() <= table_bbox.y + 3.0
                    && table_bbox.y - bbox.bottom() <= page.height * 0.12;
                (nearby_above && header.contains(&normalize_match_text(&block.text())))
                    .then_some(index)
            })
            .collect::<HashSet<_>>();
        if !remove.is_empty() {
            page.blocks = page
                .blocks
                .drain(..)
                .enumerate()
                .filter_map(|(index, block)| (!remove.contains(&index)).then_some(block))
                .collect();
            report.reconciliations.push(format!(
                "page {}: suppressed {} repeated visual header blocks for tagged table {}",
                page.number,
                remove.len(),
                id
            ));
        }
    }
}

fn normalize_match_text(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

/// Scores whether a table subtree is coherent enough to create a table rather
/// than merely annotate a geometric candidate. The score intentionally mixes
/// independent sources: logical hierarchy, ParentTree/page ownership, marked
/// content, and PDFium-visible MCID geometry.
fn table_trust_score(
    report: &PdfStructureReport,
    tagged: &TaggedTableEvidence,
    pages: &[Page],
) -> f32 {
    let mut score = 0.0_f32;
    if tagged.canonical_role == "Table" {
        score += 0.15;
    }
    if tagged.rows >= 2 && tagged.cells >= tagged.rows {
        score += 0.10;
    }
    if tagged.rows > 0
        && tagged.cells.is_multiple_of(tagged.rows)
        && (2..=50).contains(&(tagged.cells / tagged.rows))
    {
        score += 0.12;
    }
    if report.has_parent_tree {
        score += 0.10;
    }
    if report.marked {
        score += 0.05;
    }
    let cell_count = tagged.cells_detail.len().max(1) as f32;
    let referenced = tagged
        .cells_detail
        .iter()
        .filter(|cell| !cell.content_refs.is_empty())
        .count() as f32
        / cell_count;
    score += 0.12 * referenced;
    let visible = tagged
        .cells_detail
        .iter()
        .filter(|cell| {
            cell.content_refs.iter().any(|reference| {
                reference
                    .page
                    .and_then(|number| {
                        pages
                            .iter()
                            .find(|page| page.number == number)
                            .and_then(|page| marked_object_bbox(page, reference.mcid))
                    })
                    .is_some()
            })
        })
        .count() as f32
        / cell_count;
    score += 0.18 * visible;
    if !tagged.pages.is_empty()
        && tagged
            .pages
            .iter()
            .all(|number| pages.iter().any(|page| page.number == *number))
    {
        score += 0.08;
    }
    if tagged.header_cells > 0 {
        score += 0.04;
    }
    if tagged
        .cells_detail
        .iter()
        .any(|cell| cell.scope.is_some() || cell.row_span > 1 || cell.column_span > 1)
        || report.has_class_map
    {
        score += 0.03;
    }
    if tagged.child_roles.get("TR").copied() == Some(tagged.rows)
        && tagged.child_roles.get("TD").copied().unwrap_or(0)
            + tagged.child_roles.get("TH").copied().unwrap_or(0)
            == tagged.cells
    {
        score += 0.03;
    }
    score.min(1.0)
}

/// Builds page-local table fragments directly from the document-wide logical
/// rows. Cell rectangles are the union of all descendant MCID page objects;
/// geometry supplies placement and text, while the tree supplies membership,
/// row order, spans, and cross-page identity.
fn create_table_from_mcid_geometry(
    page: &mut Page,
    tagged: &TaggedTableEvidence,
    trust: f32,
    document_columns: &[Option<BBox>],
) -> bool {
    if tagged.rows < 2
        || tagged.cells == 0
        || !tagged.cells.is_multiple_of(tagged.rows)
        || page.blocks.iter().any(|block| {
            matches!(block, Block::Table { semantic_table_id: Some(id), .. } if id == &tagged.id)
        })
    {
        return false;
    }
    let columns = tagged.cells / tagged.rows;
    let selected_rows = tagged
        .cells_detail
        .chunks(columns)
        .enumerate()
        .filter(|(_, row)| {
            row.iter().any(|cell| {
                cell.content_refs
                    .iter()
                    .any(|reference| reference.page == Some(page.number))
            })
        })
        .collect::<Vec<_>>();
    if selected_rows.is_empty() {
        return false;
    }

    let mut geometries = Vec::<Vec<Option<BBox>>>::new();
    for (_, row) in &selected_rows {
        geometries.push(
            row.iter()
                .map(|cell| {
                    cell.content_refs
                        .iter()
                        .filter(|reference| reference.page == Some(page.number))
                        .filter_map(|reference| marked_object_bbox(page, reference.mcid))
                        .reduce(BBox::union)
                        .or_else(|| {
                            (cell.page == Some(page.number))
                                .then_some(cell.bbox_pdf)
                                .flatten()
                                .map(|bbox| pdf_bbox_to_page(bbox, page.height))
                        })
                })
                .collect(),
        );
    }
    let visible_cells = geometries
        .iter()
        .flatten()
        .filter(|bbox| bbox.is_some())
        .count();
    // A row can cross a page boundary with visible continuation content in a
    // single cell while its siblings are blank on that page. The document-wide
    // trust score has already established the complete row structure.
    if visible_cells == 0 || (trust < 0.9 && visible_cells * 2 < selected_rows.len() * columns) {
        return false;
    }
    let Some(mut table_bbox) = geometries
        .iter()
        .flatten()
        .filter_map(|bbox| *bbox)
        .reduce(BBox::union)
    else {
        return false;
    };
    if document_columns.len() == columns {
        if let Some(column_bbox) = document_columns
            .iter()
            .filter_map(|bbox| *bbox)
            .reduce(BBox::union)
        {
            let right = table_bbox.right().max(column_bbox.right());
            table_bbox.x = table_bbox.x.min(column_bbox.x);
            table_bbox.width = right - table_bbox.x;
        }
    }
    if !valid_page_bbox(table_bbox, page) {
        return false;
    }

    let mut column_boxes = document_columns.to_vec();
    column_boxes.resize(columns, None);
    for row in &geometries {
        for (column, bbox) in row.iter().enumerate() {
            if let Some(bbox) = bbox {
                column_boxes[column] =
                    Some(column_boxes[column].map_or(*bbox, |current| current.union(*bbox)));
            }
        }
    }
    let mut cells = Vec::with_capacity(selected_rows.len() * columns);
    for (local_row, ((_, semantic_row), geometry_row)) in
        selected_rows.iter().zip(&geometries).enumerate()
    {
        let row_bbox = geometry_row
            .iter()
            .filter_map(|bbox| *bbox)
            .reduce(BBox::union)
            .unwrap_or(table_bbox);
        for (column, (semantic, geometry)) in semantic_row.iter().zip(geometry_row).enumerate() {
            let bbox = geometry.unwrap_or_else(|| {
                let column_bbox = column_boxes[column].unwrap_or(BBox {
                    x: table_bbox.x + table_bbox.width * column as f32 / columns as f32,
                    y: table_bbox.y,
                    width: table_bbox.width / columns as f32,
                    height: table_bbox.height,
                });
                BBox {
                    x: column_bbox.x,
                    y: row_bbox.y,
                    width: column_bbox.width,
                    height: row_bbox.height,
                }
            });
            let mut matching_lines = page
                .lines
                .iter()
                .filter(|line| {
                    let x = line.bbox.x + line.bbox.width / 2.0;
                    let y = line.bbox.y + line.bbox.height / 2.0;
                    x >= bbox.x - 1.0
                        && x <= bbox.right() + 1.0
                        && y >= bbox.y - 1.0
                        && y <= bbox.bottom() + 1.0
                })
                .collect::<Vec<_>>();
            matching_lines.sort_by(|left, right| {
                left.bbox
                    .y
                    .total_cmp(&right.bbox.y)
                    .then(left.bbox.x.total_cmp(&right.bbox.x))
            });
            let text = matching_lines
                .iter()
                .map(|line| line.text.trim())
                .filter(|text| !text.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            cells.push(TableCell {
                row: local_row,
                column,
                row_span: semantic.row_span.max(1),
                column_span: semantic.column_span.max(1),
                text,
                bbox,
            });
        }
    }

    let replacement = Block::Table {
        bbox: table_bbox,
        rows: selected_rows.len(),
        columns,
        cells,
        ruled: false,
        semantic_table_id: Some(tagged.id.clone()),
        semantic_confidence: Some(trust),
        continues_from_previous_page: tagged
            .pages
            .first()
            .is_some_and(|number| *number < page.number),
        continues_on_next_page: tagged
            .pages
            .last()
            .is_some_and(|number| *number > page.number),
    };
    let remove = page
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| {
            (overlap_fraction(block.bbox(), table_bbox) >= 0.45).then_some(index)
        })
        .collect::<HashSet<_>>();
    let first = remove.iter().copied().min().unwrap_or(page.blocks.len());
    let mut replacement = Some(replacement);
    let mut blocks = Vec::with_capacity(page.blocks.len() + usize::from(remove.is_empty()));
    for (index, block) in page.blocks.drain(..).enumerate() {
        if index == first {
            blocks.push(replacement.take().expect("one MCID table replacement"));
        }
        if !remove.contains(&index) {
            blocks.push(block);
        }
    }
    if let Some(replacement) = replacement {
        blocks.push(replacement);
    }
    page.blocks = blocks;
    true
}

fn table_column_envelopes(tagged: &TaggedTableEvidence, pages: &[Page]) -> Vec<Option<BBox>> {
    if tagged.rows == 0 || !tagged.cells.is_multiple_of(tagged.rows) {
        return Vec::new();
    }
    let columns = tagged.cells / tagged.rows;
    let mut envelopes = vec![None::<BBox>; columns];
    for (index, cell) in tagged.cells_detail.iter().enumerate() {
        let column = index % columns;
        for reference in &cell.content_refs {
            let Some(page) = reference
                .page
                .and_then(|number| pages.iter().find(|page| page.number == number))
            else {
                continue;
            };
            let Some(bbox) = marked_object_bbox(page, reference.mcid) else {
                continue;
            };
            envelopes[column] = Some(envelopes[column].map_or(bbox, |current| current.union(bbox)));
        }
    }
    envelopes
}

/// Uses semantic dimensions only when the visible extraction already exposes
/// enough independent row and column anchors to locate every grid line. This
/// repairs a common failure where wrapped text causes one ruled table to be
/// emitted as several partial tables and paragraphs; tags supply identity and
/// dimensions, while visible line geometry still supplies all cell content.
fn repair_tagged_grid(page: &mut Page, tagged: &TaggedTableEvidence) -> bool {
    let Some(raw_bbox) = tagged.bbox_pdf else {
        return false;
    };
    if tagged.confidence < 0.8
        || tagged.rows < 2
        || tagged.cells < tagged.rows
        || !tagged.cells.is_multiple_of(tagged.rows)
    {
        return false;
    }
    let columns = tagged.cells / tagged.rows;
    if columns < 2 {
        return false;
    }
    let bbox = pdf_bbox_to_page(raw_bbox, page.height);
    let geometric_indices = page
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| {
            (matches!(block, Block::Table { .. }) && overlap_fraction(block.bbox(), bbox) >= 0.2)
                .then_some(index)
        })
        .collect::<Vec<_>>();
    if geometric_indices.is_empty() {
        return false;
    }
    let mut x_anchors = Vec::new();
    let mut y_anchors = Vec::new();
    let ruled = geometric_indices
        .iter()
        .any(|index| matches!(page.blocks[*index], Block::Table { ruled: true, .. }));
    for index in &geometric_indices {
        if let Block::Table { cells, .. } = &page.blocks[*index] {
            for cell in cells {
                x_anchors.push(cell.bbox.x);
                y_anchors.push(cell.bbox.y);
            }
        }
    }
    let x_anchors = cluster_anchors(x_anchors, 3.0);
    let y_anchors = cluster_anchors(y_anchors, 3.0);
    if x_anchors.len() != columns || y_anchors.len() != tagged.rows {
        return false;
    }

    let mut grouped = vec![Vec::<&crate::model::TextLine>::new(); tagged.rows * columns];
    for line in &page.lines {
        let center_x = line.bbox.x + line.bbox.width / 2.0;
        let center_y = line.bbox.y + line.bbox.height / 2.0;
        if center_x < bbox.x - 4.0
            || center_x > bbox.right() + 4.0
            || center_y < bbox.y - 10.0
            || center_y > bbox.bottom() + 6.0
        {
            continue;
        }
        let column = anchor_interval(line.bbox.x, &x_anchors);
        let row = anchor_interval(line.bbox.y, &y_anchors);
        grouped[row * columns + column].push(line);
    }
    let populated = grouped.iter().filter(|lines| !lines.is_empty()).count();
    if populated * 4 < tagged.cells * 3 {
        return false;
    }

    let mut cells = Vec::with_capacity(tagged.cells);
    for row in 0..tagged.rows {
        for column in 0..columns {
            let index = row * columns + column;
            let lines = &mut grouped[index];
            lines.sort_by(|left, right| {
                left.bbox
                    .y
                    .total_cmp(&right.bbox.y)
                    .then(left.bbox.x.total_cmp(&right.bbox.x))
            });
            let mut text = String::new();
            let mut cell_bbox = BBox {
                x: x_anchors[column],
                y: y_anchors[row],
                width: x_anchors.get(column + 1).copied().unwrap_or(bbox.right())
                    - x_anchors[column],
                height: y_anchors.get(row + 1).copied().unwrap_or(bbox.bottom()) - y_anchors[row],
            };
            for line in lines.iter() {
                if !text.is_empty() && !text.ends_with('-') {
                    text.push(' ');
                }
                text.push_str(line.text.trim());
                cell_bbox = cell_bbox.union(line.bbox);
            }
            let semantic_cell = tagged.cells_detail.get(index);
            cells.push(TableCell {
                row,
                column,
                row_span: semantic_cell.map_or(1, |cell| cell.row_span.max(1)),
                column_span: semantic_cell.map_or(1, |cell| cell.column_span.max(1)),
                text,
                bbox: cell_bbox,
            });
        }
    }
    let replacement = Block::Table {
        bbox,
        rows: tagged.rows,
        columns,
        cells,
        ruled,
        semantic_table_id: Some(tagged.id.clone()),
        semantic_confidence: Some(tagged.confidence),
        continues_from_previous_page: tagged
            .pages
            .first()
            .is_some_and(|page_number| *page_number < page.number),
        continues_on_next_page: tagged
            .pages
            .last()
            .is_some_and(|page_number| *page_number > page.number),
    };
    let remove = page
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| {
            (overlap_fraction(block.bbox(), bbox) >= 0.55).then_some(index)
        })
        .collect::<Vec<_>>();
    let Some(first) = remove.iter().copied().min() else {
        return false;
    };
    let remove = remove.into_iter().collect::<HashSet<_>>();
    let mut replacement = Some(replacement);
    page.blocks = page
        .blocks
        .drain(..)
        .enumerate()
        .filter_map(|(index, block)| {
            if index == first {
                replacement.take()
            } else if remove.contains(&index) {
                None
            } else {
                Some(block)
            }
        })
        .collect();
    true
}

/// Fallback for tagged tables whose borders are not exposed as usable PDFium
/// path objects (for example LibreOffice filled/clipped borders). Structure
/// order gives the number of cells on this page; repeated text baselines and
/// large inter-span gaps provide independent visible row/column anchors.
fn repair_tagged_grid_from_structure(page: &mut Page, tagged: &TaggedTableEvidence) -> bool {
    if tagged.confidence < 0.85 || tagged.rows < 2 || !tagged.cells.is_multiple_of(tagged.rows) {
        return false;
    }
    let columns = tagged.cells / tagged.rows;
    let page_cells = tagged
        .cells_detail
        .iter()
        .filter(|cell| cell.page == Some(page.number))
        .count();
    if columns < 2 || page_cells < columns || page_cells % columns != 0 {
        return false;
    }
    let page_rows = page_cells / columns;
    let has_header_cells = tagged
        .cells_detail
        .iter()
        .any(|cell| cell.page == Some(page.number) && cell.role == "TH");
    let mut row_groups = Vec::<Vec<&crate::model::TextLine>>::new();
    let mut sorted_lines = page.lines.iter().collect::<Vec<_>>();
    sorted_lines.sort_by(|left, right| left.bbox.y.total_cmp(&right.bbox.y));
    for line in sorted_lines {
        if let Some(group) = row_groups
            .last_mut()
            .filter(|group| (group[0].bbox.center_y() - line.bbox.center_y()).abs() <= 3.0)
        {
            group.push(line);
        } else {
            row_groups.push(vec![line]);
        }
    }
    if !has_header_cells {
        row_groups.retain(|group| {
            let characters = group
                .iter()
                .map(|line| line.text.chars().count())
                .sum::<usize>();
            let bold = group
                .iter()
                .map(|line| line.text.chars().count() * usize::from(line.font_weight >= 600))
                .sum::<usize>();
            characters == 0 || bold * 2 < characters
        });
    }
    if row_groups.len() < page_rows {
        return false;
    }
    let starts = 0..=row_groups.len() - page_rows;
    let header_start = has_header_cells
        .then(|| {
            starts.clone().find(|start| {
                let group = &row_groups[*start];
                group.len() >= columns
            })
        })
        .flatten();
    let best_start = header_start.unwrap_or_else(|| {
        starts
            .max_by_key(|start| {
                row_groups[*start..*start + page_rows]
                    .iter()
                    .map(|group| {
                        let span_count = group.iter().map(|line| line.spans.len()).sum::<usize>();
                        span_count + group.len() * 6
                    })
                    .sum::<usize>()
            })
            .unwrap_or(0)
    });
    let selected = &row_groups[best_start..best_start + page_rows];

    let mut candidates = Vec::<f32>::new();
    for group in selected {
        let mut spans = group
            .iter()
            .flat_map(|line| line.spans.iter())
            .collect::<Vec<_>>();
        spans.sort_by(|left, right| left.bbox.x.total_cmp(&right.bbox.x));
        if let Some(first) = spans.first() {
            candidates.push(first.bbox.x);
        }
        for pair in spans.windows(2) {
            let gap = pair[1].bbox.x - pair[0].bbox.right();
            if gap > 6.0_f32.max(pair[0].font_size.min(pair[1].font_size) * 0.55) {
                candidates.push(pair[1].bbox.x);
            }
        }
    }
    let mut anchors = cluster_anchor_counts(candidates, 3.0);
    anchors.sort_by(|left, right| right.1.cmp(&left.1).then(left.0.total_cmp(&right.0)));
    anchors.truncate(columns);
    let mut x_anchors = anchors.into_iter().map(|(x, _)| x).collect::<Vec<_>>();
    x_anchors.sort_by(f32::total_cmp);
    if x_anchors.len() != columns {
        return false;
    }

    let mut cells = Vec::with_capacity(page_cells);
    let mut table_bbox: Option<BBox> = None;
    let page_cell_offset = tagged
        .cells_detail
        .iter()
        .position(|cell| cell.page == Some(page.number))
        .unwrap_or(0);
    for (row, group) in selected.iter().enumerate() {
        let mut by_column = vec![Vec::<&crate::model::Span>::new(); columns];
        for span in group.iter().flat_map(|line| line.spans.iter()) {
            let column = anchor_interval(span.bbox.x, &x_anchors);
            by_column[column].push(span);
        }
        for (column, spans) in by_column.iter_mut().enumerate() {
            spans.sort_by(|left, right| {
                left.bbox
                    .y
                    .total_cmp(&right.bbox.y)
                    .then(left.bbox.x.total_cmp(&right.bbox.x))
            });
            let mut text = String::new();
            let mut bbox = BBox {
                x: x_anchors[column],
                y: group[0].bbox.y,
                width: 0.0,
                height: group[0].bbox.height,
            };
            for span in spans.iter() {
                if !text.is_empty() {
                    text.push(' ');
                }
                text.push_str(span.text.trim());
                bbox = bbox.union(span.bbox);
            }
            table_bbox = Some(table_bbox.map_or(bbox, |current| current.union(bbox)));
            let semantic = tagged
                .cells_detail
                .get(page_cell_offset + row * columns + column);
            cells.push(TableCell {
                row,
                column,
                row_span: semantic.map_or(1, |cell| cell.row_span.max(1)),
                column_span: semantic.map_or(1, |cell| cell.column_span.max(1)),
                text,
                bbox,
            });
        }
    }
    let Some(bbox) = table_bbox else { return false };
    if cells.iter().filter(|cell| !cell.text.is_empty()).count() * 4 < page_cells * 3 {
        return false;
    }
    let replacement = Block::Table {
        bbox,
        rows: page_rows,
        columns,
        cells,
        ruled: false,
        semantic_table_id: Some(tagged.id.clone()),
        semantic_confidence: Some(tagged.confidence * 0.92),
        continues_from_previous_page: tagged
            .pages
            .first()
            .is_some_and(|number| *number < page.number),
        continues_on_next_page: tagged
            .pages
            .last()
            .is_some_and(|number| *number > page.number),
    };
    let remove = page
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| (overlap_fraction(block.bbox(), bbox) >= 0.5).then_some(index))
        .collect::<HashSet<_>>();
    let first = remove.iter().copied().min().unwrap_or(page.blocks.len());
    let mut replacement = Some(replacement);
    let mut blocks = Vec::with_capacity(page.blocks.len() + usize::from(remove.is_empty()));
    for (index, block) in page.blocks.drain(..).enumerate() {
        if index == first {
            blocks.push(replacement.take().expect("one semantic table replacement"));
        }
        if !remove.contains(&index) {
            blocks.push(block);
        }
    }
    if let Some(replacement) = replacement {
        blocks.push(replacement);
    }
    page.blocks = blocks;
    true
}

fn cluster_anchors(mut values: Vec<f32>, tolerance: f32) -> Vec<f32> {
    values.sort_by(f32::total_cmp);
    let mut clusters = Vec::<(f32, usize)>::new();
    for value in values {
        if let Some((mean, count)) = clusters
            .last_mut()
            .filter(|(mean, _)| value - *mean <= tolerance)
        {
            *mean = (*mean * *count as f32 + value) / (*count as f32 + 1.0);
            *count += 1;
        } else {
            clusters.push((value, 1));
        }
    }
    clusters.into_iter().map(|(mean, _)| mean).collect()
}

fn cluster_anchor_counts(mut values: Vec<f32>, tolerance: f32) -> Vec<(f32, usize)> {
    values.sort_by(f32::total_cmp);
    let mut clusters = Vec::<(f32, usize)>::new();
    for value in values {
        if let Some((mean, count)) = clusters
            .last_mut()
            .filter(|(mean, _)| value - *mean <= tolerance)
        {
            *mean = (*mean * *count as f32 + value) / (*count as f32 + 1.0);
            *count += 1;
        } else {
            clusters.push((value, 1));
        }
    }
    clusters
}

fn anchor_interval(value: f32, anchors: &[f32]) -> usize {
    anchors
        .partition_point(|anchor| *anchor <= value + 2.0)
        .saturating_sub(1)
        .min(anchors.len().saturating_sub(1))
}

fn assign_semantic_identity(page: &mut Page, tagged: &TaggedTableEvidence, allow_unlocated: bool) {
    let table_indices = page
        .blocks
        .iter()
        .enumerate()
        .filter_map(|(index, block)| matches!(block, Block::Table { .. }).then_some(index))
        .collect::<Vec<_>>();
    if table_indices.is_empty() {
        return;
    }
    let selected = if let Some(raw_bbox) = tagged.bbox_pdf {
        let bbox = pdf_bbox_to_page(raw_bbox, page.height);
        table_indices.into_iter().max_by(|left, right| {
            overlap_fraction(page.blocks[*left].bbox(), bbox)
                .total_cmp(&overlap_fraction(page.blocks[*right].bbox(), bbox))
        })
    } else if allow_unlocated {
        table_indices.into_iter().max_by(|left, right| {
            page.blocks[*left]
                .bbox()
                .area()
                .total_cmp(&page.blocks[*right].bbox().area())
        })
    } else {
        None
    };
    let Some(index) = selected else { return };
    let position = tagged
        .pages
        .iter()
        .position(|number| *number == page.number);
    let Block::Table {
        semantic_table_id,
        semantic_confidence,
        continues_from_previous_page,
        continues_on_next_page,
        ..
    } = &mut page.blocks[index]
    else {
        return;
    };
    *semantic_table_id = Some(tagged.id.clone());
    *semantic_confidence = Some(tagged.confidence);
    *continues_from_previous_page = position.is_some_and(|value| value > 0);
    *continues_on_next_page = position.is_some_and(|value| value + 1 < tagged.pages.len());
}

fn best_vertical_run(page: &Page, indices: &[usize], tagged: &TaggedTableEvidence) -> Vec<usize> {
    let mut best = Vec::new();
    let mut current = Vec::new();
    for index in indices {
        let bbox = page.blocks[*index].bbox();
        let compatible = current.last().is_none_or(|previous: &usize| {
            let previous_bbox = page.blocks[*previous].bbox();
            horizontal_overlap(previous_bbox, bbox) >= 0.68
                && bbox.y - previous_bbox.bottom() <= page.height * 0.18
                && table_columns(&page.blocks[*previous]) == table_columns(&page.blocks[*index])
        });
        if !compatible {
            if current.len() > best.len() {
                best = std::mem::take(&mut current);
            } else {
                current.clear();
            }
        }
        current.push(*index);
    }
    if current.len() > best.len() {
        best = current;
    }
    let rows = best
        .iter()
        .map(|index| table_rows(&page.blocks[*index]))
        .sum::<usize>();
    if best.len() >= 2 && (tagged.rows == 0 || rows <= tagged.rows.saturating_add(best.len() * 2)) {
        best
    } else {
        Vec::new()
    }
}

fn merge_table_fragments(page: &Page, indices: &[usize]) -> Option<Block> {
    let mut bbox = page.blocks[*indices.first()?].bbox();
    let columns = table_columns(&page.blocks[indices[0]]);
    if columns == 0
        || indices
            .iter()
            .any(|index| table_columns(&page.blocks[*index]) != columns)
    {
        return None;
    }
    let ruled = indices
        .iter()
        .any(|index| matches!(page.blocks[*index], Block::Table { ruled: true, .. }));
    let mut row_offset = 0;
    let mut cells = Vec::<TableCell>::new();
    for index in indices {
        let Block::Table {
            bbox: fragment_bbox,
            rows,
            cells: fragment_cells,
            ..
        } = &page.blocks[*index]
        else {
            return None;
        };
        bbox = bbox.union(*fragment_bbox);
        cells.extend(fragment_cells.iter().cloned().map(|mut cell| {
            cell.row += row_offset;
            cell
        }));
        row_offset += *rows;
    }
    Some(Block::Table {
        bbox,
        rows: row_offset,
        columns,
        cells,
        ruled,
        semantic_table_id: None,
        semantic_confidence: None,
        continues_from_previous_page: false,
        continues_on_next_page: false,
    })
}

fn inspect_content_streams(
    doc: &LoDocument,
    pages: &BTreeMap<u32, ObjectId>,
) -> (
    Vec<PageStructureEvidence>,
    BTreeMap<String, usize>,
    usize,
    usize,
) {
    let mut all_tags = BTreeMap::new();
    let mut reports = Vec::new();
    for (page_number, page_id) in pages {
        let content_ids = doc.get_page_contents(*page_id);
        let mut tags = BTreeMap::new();
        let mut mcids = BTreeSet::new();
        let mut marked_sequences = 0;
        let mut artifacts = 0;
        let mut regions = Vec::new();
        let property_dicts = page_property_dictionaries(doc, *page_id);
        if let Ok(content) = doc.get_and_decode_page_content(*page_id) {
            inventory_marked_content(
                doc,
                &content,
                &property_dicts,
                MarkedInventory {
                    tags: &mut tags,
                    mcids: &mut mcids,
                    sequences: &mut marked_sequences,
                    artifacts: &mut artifacts,
                    regions: &mut regions,
                },
                "page_content",
            );
        }
        for (tag, count) in &tags {
            *all_tags.entry(tag.clone()).or_insert(0) += count;
        }
        let struct_parents = doc
            .get_dictionary(*page_id)
            .ok()
            .and_then(|dict| dict.get(b"StructParents").ok())
            .and_then(|object| object.as_i64().ok());
        reports.push(PageStructureEvidence {
            page: *page_number as usize,
            object_id: object_id(*page_id),
            struct_parents,
            content_streams: content_ids.len(),
            marked_sequences,
            artifacts,
            mcids: mcids.into_iter().collect(),
            tags,
            regions,
        });
    }
    let page_streams = pages
        .values()
        .flat_map(|page_id| doc.get_page_contents(*page_id))
        .collect::<HashSet<_>>();
    let mut form_xobjects = 0;
    let mut form_marked_sequences = 0;
    for (id, object) in &doc.objects {
        let Object::Stream(stream) = object else {
            continue;
        };
        if page_streams.contains(id)
            || dict_name(&stream.dict, b"Subtype").as_deref() != Some("Form")
        {
            continue;
        }
        form_xobjects += 1;
        let Ok(decoded) = stream.decompressed_content() else {
            continue;
        };
        let Ok(content) = Content::decode(&decoded) else {
            continue;
        };
        let property_dicts = stream
            .dict
            .get(b"Resources")
            .ok()
            .and_then(|object| deref_dict(doc, object))
            .and_then(|resources| resources.get(b"Properties").ok())
            .and_then(|object| deref_dict(doc, object))
            .into_iter()
            .collect::<Vec<_>>();
        let mut tags = BTreeMap::new();
        let mut mcids = BTreeSet::new();
        let mut sequences = 0;
        let mut artifacts = 0;
        let mut regions = Vec::new();
        inventory_marked_content(
            doc,
            &content,
            &property_dicts,
            MarkedInventory {
                tags: &mut tags,
                mcids: &mut mcids,
                sequences: &mut sequences,
                artifacts: &mut artifacts,
                regions: &mut regions,
            },
            "form_xobject",
        );
        form_marked_sequences += sequences;
        for (tag, count) in tags {
            *all_tags.entry(format!("form:{tag}")).or_insert(0) += count;
        }
    }
    (reports, all_tags, form_xobjects, form_marked_sequences)
}

struct MarkedInventory<'a> {
    tags: &'a mut BTreeMap<String, usize>,
    mcids: &'a mut BTreeSet<i64>,
    sequences: &'a mut usize,
    artifacts: &'a mut usize,
    regions: &'a mut Vec<MarkedContentRegionEvidence>,
}

fn inventory_marked_content(
    doc: &LoDocument,
    content: &Content,
    property_dicts: &[&Dictionary],
    inventory: MarkedInventory<'_>,
    source: &str,
) {
    for operation in &content.operations {
        if operation.operator != "BDC" && operation.operator != "BMC" {
            continue;
        }
        *inventory.sequences += 1;
        let tag = operation
            .operands
            .first()
            .and_then(|object| object.as_name().ok())
            .map(name)
            .unwrap_or_else(|| "unknown".into());
        increment(inventory.tags, tag.clone());
        if tag == "Artifact" {
            *inventory.artifacts += 1;
        }
        let properties = operation.operands.get(1).and_then(|operand| match operand {
            Object::Dictionary(properties) => Some(properties),
            Object::Name(property_name) => property_dicts
                .iter()
                .find_map(|dict| dict.get(property_name).ok())
                .and_then(|object| deref_dict(doc, object)),
            _ => None,
        });
        if let Some(properties) = properties {
            let mcid = properties
                .get(b"MCID")
                .ok()
                .and_then(|object| object.as_i64().ok());
            if let Some(mcid) = mcid {
                inventory.mcids.insert(mcid);
            }
            let bbox_pdf = properties.get(b"BBox").ok().and_then(pdf_bbox);
            if mcid.is_some() || bbox_pdf.is_some() {
                inventory.regions.push(MarkedContentRegionEvidence {
                    tag,
                    mcid,
                    bbox_pdf,
                    source: source.into(),
                });
            }
        }
    }
}

fn page_property_dictionaries(doc: &LoDocument, page_id: ObjectId) -> Vec<&Dictionary> {
    let Ok((direct, inherited_ids)) = doc.get_page_resources(page_id) else {
        return Vec::new();
    };
    direct
        .into_iter()
        .chain(
            inherited_ids
                .iter()
                .filter_map(|id| doc.get_dictionary(*id).ok()),
        )
        .filter_map(|resources| resources.get(b"Properties").ok())
        .filter_map(|object| deref_dict(doc, object))
        .collect()
}

fn root_dictionary(doc: &LoDocument) -> Result<&Dictionary> {
    let root = doc
        .trailer
        .get(b"Root")
        .context("PDF trailer has no Root")?;
    deref_dict(doc, root).context("PDF Root is not a dictionary")
}

fn deref_object<'a>(doc: &'a LoDocument, object: &'a Object) -> Option<&'a Object> {
    doc.dereference(object).ok().map(|(_, object)| object)
}

fn deref_dict<'a>(doc: &'a LoDocument, object: &'a Object) -> Option<&'a Dictionary> {
    deref_object(doc, object)?.as_dict().ok()
}

fn scan_structure_ids(doc: &LoDocument) -> BTreeSet<ObjectId> {
    let mut ids = doc
        .objects
        .iter()
        .filter_map(|(id, object)| {
            object
                .as_dict()
                .ok()
                .filter(|dict| dict_name(dict, b"Type").as_deref() == Some("StructElem"))
                .map(|_| *id)
        })
        .collect::<BTreeSet<_>>();
    // Some malformed producers omit `/Type /StructElem`. Recover those nodes
    // only when their `/P` actually reaches a known StructElem or
    // StructTreeRoot; a loose `/S` + `/P` test misclassifies graphics-state
    // dictionaries such as `/S /Transparency`.
    loop {
        let mut added = false;
        for (id, object) in &doc.objects {
            if ids.contains(id) {
                continue;
            }
            let Ok(dict) = object.as_dict() else { continue };
            if dict.get(b"S").is_err() || dict.get(b"K").is_err() {
                continue;
            }
            let parent_is_structure =
                dict.get(b"P")
                    .ok()
                    .and_then(object_reference)
                    .is_some_and(|parent| {
                        ids.contains(&parent)
                            || doc
                                .get_dictionary(parent)
                                .ok()
                                .and_then(|parent| dict_name(parent, b"Type"))
                                .as_deref()
                                == Some("StructTreeRoot")
                    });
            if parent_is_structure {
                ids.insert(*id);
                added = true;
            }
        }
        if !added {
            break;
        }
    }
    ids
}

fn is_structure_dict(dict: &Dictionary) -> bool {
    dict_name(dict, b"Type").as_deref() == Some("StructElem")
        || (dict.get(b"S").is_ok() && (dict.get(b"P").is_ok() || dict.get(b"K").is_ok()))
}

fn build_reverse_children(
    doc: &LoDocument,
    ids: &BTreeSet<ObjectId>,
) -> HashMap<ObjectId, Vec<ObjectId>> {
    let mut result = HashMap::<ObjectId, Vec<ObjectId>>::new();
    for id in ids {
        if let Some(parent) = doc
            .get_dictionary(*id)
            .ok()
            .and_then(|dict| dict.get(b"P").ok())
            .and_then(object_reference)
        {
            result.entry(parent).or_default().push(*id);
        }
    }
    result
}

fn referenced_structure_ids(doc: &LoDocument, object: &Object) -> Vec<ObjectId> {
    let values = match object {
        Object::Array(values) => values.as_slice(),
        value => std::slice::from_ref(value),
    };
    values
        .iter()
        .filter_map(|value| {
            let id = object_reference(value)?;
            doc.get_dictionary(id)
                .ok()
                .filter(|dict| is_structure_dict(dict))
                .map(|_| id)
        })
        .collect()
}

fn inventory_kinds(
    doc: &LoDocument,
    struct_ids: &BTreeSet<ObjectId>,
    object: &Object,
    counts: &mut BTreeMap<String, usize>,
) {
    match object {
        Object::Array(values) => {
            increment(counts, "array".into());
            for value in values {
                inventory_kinds(doc, struct_ids, value, counts);
            }
        }
        Object::Integer(_) => increment(counts, "integer_mcid".into()),
        Object::Reference(id) if struct_ids.contains(id) => {
            increment(counts, "structure_element_ref".into())
        }
        Object::Reference(id) => {
            let kind = doc
                .get_object(*id)
                .ok()
                .and_then(|value| value.as_dict().ok())
                .and_then(|dict| dict_name(dict, b"Type"))
                .map(|kind| format!("indirect_{}", kind.to_ascii_lowercase()))
                .unwrap_or_else(|| "other_indirect_ref".into());
            increment(counts, kind);
        }
        Object::Dictionary(dict) => {
            let kind = dict_name(dict, b"Type")
                .map(|kind| format!("direct_{}", kind.to_ascii_lowercase()))
                .unwrap_or_else(|| "direct_dictionary".into());
            increment(counts, kind);
            if dict.get(b"Pg").is_ok() {
                increment(counts, "with_page_ref".into());
            }
            if dict.get(b"Stm").is_ok() {
                increment(counts, "with_stream_ref".into());
            }
        }
        Object::Null => increment(counts, "null".into()),
        _ => increment(counts, "other".into()),
    }
}

fn read_name_map(dict: &Dictionary) -> BTreeMap<String, String> {
    dict.iter()
        .filter_map(|(key, value)| role_map_target(value).map(|mapped| (name(key), mapped)))
        .collect()
}

/// PDF 2.0 moves many custom-to-standard role mappings into Namespace
/// dictionaries (`/Type /Namespace`, `/RoleMapNS`) referenced by individual
/// structure elements through `/NS`.  The mapping value is commonly an array
/// whose first item is the target role and whose second item identifies the
/// target namespace, rather than the bare name used by PDF 1.7 `/RoleMap`.
fn read_namespaces(
    doc: &LoDocument,
) -> (
    BTreeMap<String, usize>,
    HashMap<ObjectId, BTreeMap<String, String>>,
) {
    let mut inventory = BTreeMap::new();
    let mut maps = HashMap::new();
    for (id, object) in &doc.objects {
        let Ok(dict) = object.as_dict() else { continue };
        if dict_name(dict, b"Type").as_deref() != Some("Namespace") {
            continue;
        }
        let uri = dict_string(dict, b"NS").unwrap_or_else(|| "(missing namespace URI)".into());
        increment(&mut inventory, uri);
        let role_map = dict
            .get(b"RoleMapNS")
            .ok()
            .and_then(|value| deref_dict(doc, value))
            .map(read_name_map)
            .unwrap_or_default();
        maps.insert(*id, role_map);
    }
    (inventory, maps)
}

fn role_map_target(value: &Object) -> Option<String> {
    match value {
        Object::Name(mapped) => Some(name(mapped)),
        // ISO 32000-2 RoleMapNS values are [role-name target-namespace].
        Object::Array(values) => values
            .iter()
            .find_map(|value| value.as_name().ok().map(name)),
        _ => None,
    }
}

fn object_type_inventory(doc: &LoDocument) -> BTreeMap<String, usize> {
    let mut result = BTreeMap::new();
    for object in doc.objects.values() {
        let dict = match object {
            Object::Dictionary(dict) => Some(dict),
            Object::Stream(stream) => Some(&stream.dict),
            _ => None,
        };
        let Some(dict) = dict else { continue };
        let kind = dict_name(dict, b"Type")
            .or_else(|| dict_name(dict, b"Subtype").map(|value| format!("Subtype:{value}")))
            .unwrap_or_else(|| {
                if matches!(object, Object::Stream(_)) {
                    "Stream".into()
                } else {
                    "Dictionary".into()
                }
            });
        increment(&mut result, kind);
    }
    result
}

fn catalog_feature_inventory(catalog: &Dictionary) -> BTreeMap<String, bool> {
    [
        "StructTreeRoot",
        "MarkInfo",
        "Lang",
        "Metadata",
        "Outlines",
        "Names",
        "Dests",
        "PageLabels",
        "Threads",
        "OCProperties",
        "AcroForm",
        "ViewerPreferences",
        "PieceInfo",
        "OutputIntents",
        "SpiderInfo",
    ]
    .into_iter()
    .map(|key| (key.to_owned(), catalog.get(key.as_bytes()).is_ok()))
    .collect()
}

fn read_page_labels(doc: &LoDocument, catalog: &Dictionary, page_count: usize) -> Vec<String> {
    let Some(root) = catalog
        .get(b"PageLabels")
        .ok()
        .and_then(|object| deref_dict(doc, object))
    else {
        return Vec::new();
    };
    let mut definitions = BTreeMap::<usize, (String, String, usize)>::new();
    collect_page_label_definitions(doc, root, &mut definitions, &mut HashSet::new());
    if definitions.is_empty() {
        return Vec::new();
    }
    (0..page_count)
        .map(|index| {
            let (start_index, (prefix, style, start)) = definitions
                .range(..=index)
                .next_back()
                .map(|(key, value)| (*key, value.clone()))
                .unwrap_or((0, (String::new(), "D".into(), 1)));
            let number = start + index.saturating_sub(start_index);
            format!("{}{}", prefix, format_page_label_number(&style, number))
        })
        .collect()
}

fn collect_page_label_definitions(
    doc: &LoDocument,
    dictionary: &Dictionary,
    output: &mut BTreeMap<usize, (String, String, usize)>,
    visited: &mut HashSet<ObjectId>,
) {
    if let Ok(nums) = dictionary.get(b"Nums").and_then(Object::as_array) {
        for pair in nums.chunks_exact(2) {
            let Ok(index) = pair[0].as_i64() else {
                continue;
            };
            let Some(label) = deref_dict(doc, &pair[1]) else {
                continue;
            };
            let prefix = dict_string(label, b"P").unwrap_or_default();
            let style = label
                .get(b"S")
                .ok()
                .and_then(|value| value.as_name().ok())
                .map(name)
                .unwrap_or_default();
            let start = label
                .get(b"St")
                .ok()
                .and_then(|value| value.as_i64().ok())
                .unwrap_or(1)
                .max(1) as usize;
            output.insert(index.max(0) as usize, (prefix, style, start));
        }
    }
    if let Ok(kids) = dictionary.get(b"Kids").and_then(Object::as_array) {
        for kid in kids {
            if let Ok(id) = kid.as_reference() {
                if !visited.insert(id) {
                    continue;
                }
            }
            if let Some(child) = deref_dict(doc, kid) {
                collect_page_label_definitions(doc, child, output, visited);
            }
        }
    }
}

fn format_page_label_number(style: &str, number: usize) -> String {
    match style {
        "r" => roman_number(number).to_ascii_lowercase(),
        "R" => roman_number(number),
        "a" => alpha_number(number).to_ascii_lowercase(),
        "A" => alpha_number(number),
        "" => String::new(),
        _ => number.to_string(),
    }
}

fn roman_number(mut value: usize) -> String {
    let mut output = String::new();
    for (amount, symbol) in [
        (1000, "M"),
        (900, "CM"),
        (500, "D"),
        (400, "CD"),
        (100, "C"),
        (90, "XC"),
        (50, "L"),
        (40, "XL"),
        (10, "X"),
        (9, "IX"),
        (5, "V"),
        (4, "IV"),
        (1, "I"),
    ] {
        while value >= amount {
            output.push_str(symbol);
            value -= amount;
        }
    }
    output
}

fn alpha_number(mut value: usize) -> String {
    if value == 0 {
        return String::new();
    }
    let mut output = String::new();
    while value > 0 {
        value -= 1;
        output.insert(0, (b'A' + (value % 26) as u8) as char);
        value /= 26;
    }
    output
}

fn producer_family(producer: Option<&str>, creator: Option<&str>) -> Option<String> {
    let joined =
        format!("{} {}", producer.unwrap_or(""), creator.unwrap_or("")).to_ascii_lowercase();
    let family = if joined.contains("microsoft") || joined.contains("word") {
        "microsoft_office"
    } else if joined.contains("google docs") || joined.contains("skia/pdf") {
        "google_docs_or_chromium"
    } else if joined.contains("libreoffice") || joined.contains("openoffice") {
        "libreoffice"
    } else if joined.contains("latex")
        || joined.contains("tex")
        || joined.contains("luahbtex")
        || joined.contains("pdftex")
        || joined.contains("xetex")
    {
        "tex"
    } else if joined.contains("indesign") {
        "adobe_indesign"
    } else if joined.contains("acrobat") || joined.contains("distiller") {
        "adobe_pdf"
    } else if joined.contains("prince") {
        "prince_xml"
    } else if joined.contains("wkhtmltopdf") {
        "wkhtmltopdf"
    } else if joined.contains("itext") {
        "itext"
    } else if joined.contains("aspose") {
        "aspose"
    } else if joined.contains("quarkxpress") {
        "quarkxpress"
    } else if joined.trim().is_empty() {
        return None;
    } else {
        "other"
    };
    Some(family.into())
}

fn collect_dictionaries<'a>(
    doc: &'a LoDocument,
    object: &'a Object,
    out: &mut Vec<&'a Dictionary>,
) {
    match object {
        Object::Dictionary(dict) => out.push(dict),
        Object::Reference(id) => {
            if let Ok(object) = doc.get_object(*id) {
                collect_dictionaries(doc, object, out);
            }
        }
        Object::Array(values) => {
            for value in values {
                // Revision numbers can follow attribute dictionaries in `/A`
                // arrays; non-dictionary values are intentionally ignored.
                collect_dictionaries(doc, value, out);
            }
        }
        _ => {}
    }
}

fn attribute_number(dicts: &[&Dictionary], key: &[u8]) -> Option<i64> {
    dicts.iter().find_map(|dict| {
        dict.get(key).ok().and_then(|object| match object {
            Object::Integer(value) => Some(*value),
            Object::Real(value) => Some(*value as i64),
            _ => None,
        })
    })
}

fn attribute_name_or_string(dicts: &[&Dictionary], key: &[u8]) -> Option<String> {
    dicts.iter().find_map(|dict| {
        dict.get(key).ok().and_then(|object| {
            object
                .as_name()
                .ok()
                .map(name)
                .or_else(|| object.as_str().ok().map(decode_pdf_string))
        })
    })
}

fn attribute_bbox(dicts: &[&Dictionary]) -> Option<[f32; 4]> {
    dicts
        .iter()
        .find_map(|dict| dict.get(b"BBox").ok().and_then(pdf_bbox))
}

fn pdf_bbox(object: &Object) -> Option<[f32; 4]> {
    let values = object.as_array().ok()?;
    if values.len() != 4 {
        return None;
    }
    Some([
        values[0].as_float().ok()?,
        values[1].as_float().ok()?,
        values[2].as_float().ok()?,
        values[3].as_float().ok()?,
    ])
}

fn union_pdf_bbox(a: [f32; 4], b: [f32; 4]) -> [f32; 4] {
    [
        a[0].min(b[0]),
        a[1].min(b[1]),
        a[2].max(b[2]),
        a[3].max(b[3]),
    ]
}

fn dict_name(dict: &Dictionary, key: &[u8]) -> Option<String> {
    dict.get(key).ok()?.as_name().ok().map(name)
}

fn dict_string(dict: &Dictionary, key: &[u8]) -> Option<String> {
    dict.get(key).ok()?.as_str().ok().map(decode_pdf_string)
}

fn decode_pdf_string(bytes: &[u8]) -> String {
    if bytes.starts_with(&[0xfe, 0xff]) {
        let words = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_be_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&words)
    } else if bytes.starts_with(&[0xff, 0xfe]) {
        let words = bytes[2..]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&words)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

fn object_reference(object: &Object) -> Option<ObjectId> {
    object.as_reference().ok()
}

fn object_id(id: ObjectId) -> String {
    format!("{} {} R", id.0, id.1)
}

fn name(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

fn compact_object(object: &Object) -> String {
    match object {
        Object::Null => "null".into(),
        Object::Boolean(value) => value.to_string(),
        Object::Integer(value) => value.to_string(),
        Object::Real(value) => value.to_string(),
        Object::Name(value) => format!("/{}", name(value)),
        Object::String(value, _) => String::from_utf8_lossy(value).into_owned(),
        Object::Reference(id) => object_id(*id),
        Object::Array(values) => values
            .iter()
            .map(compact_object)
            .collect::<Vec<_>>()
            .join(" "),
        Object::Dictionary(_) => "dictionary".into(),
        Object::Stream(_) => "stream".into(),
    }
}

fn increment(map: &mut BTreeMap<String, usize>, key: String) {
    *map.entry(key).or_insert(0) += 1;
}

fn is_table_role(role: &str) -> bool {
    role == "Table"
        || matches!(
            role.to_ascii_lowercase().as_str(),
            "table" | "tabular" | "grid" | "datatable"
        )
}

fn is_row_role(role: &str) -> bool {
    role == "TR" || matches!(role.to_ascii_lowercase().as_str(), "row" | "tablerow")
}

fn is_cell_role(role: &str) -> bool {
    matches!(role, "TH" | "TD")
        || matches!(
            role.to_ascii_lowercase().as_str(),
            "cell" | "tablecell" | "headercell"
        )
}

fn is_standard_structure_role(role: &str) -> bool {
    matches!(
        role,
        "Document"
            | "Part"
            | "Art"
            | "Sect"
            | "Div"
            | "BlockQuote"
            | "Caption"
            | "TOC"
            | "TOCI"
            | "Index"
            | "NonStruct"
            | "Private"
            | "P"
            | "H"
            | "H1"
            | "H2"
            | "H3"
            | "H4"
            | "H5"
            | "H6"
            | "L"
            | "LI"
            | "Lbl"
            | "LBody"
            | "Table"
            | "TR"
            | "TH"
            | "TD"
            | "THead"
            | "TBody"
            | "TFoot"
            | "Span"
            | "Quote"
            | "Note"
            | "Reference"
            | "BibEntry"
            | "Code"
            | "Link"
            | "Annot"
            | "Ruby"
            | "Warichu"
            | "Figure"
            | "Formula"
            | "Form"
    )
}

fn count_number_tree_entries(
    doc: &LoDocument,
    object: &Object,
    visited: &mut HashSet<ObjectId>,
) -> usize {
    if let Some(id) = object_reference(object) {
        if !visited.insert(id) {
            return 0;
        }
        return doc
            .get_object(id)
            .ok()
            .map(|object| count_number_tree_entries(doc, object, visited))
            .unwrap_or(0);
    }
    match object {
        Object::Dictionary(dict) => {
            let nums = dict
                .get(b"Nums")
                .ok()
                .and_then(|object| object.as_array().ok())
                .map(|values| values.len() / 2)
                .unwrap_or(0);
            let kids = dict
                .get(b"Kids")
                .ok()
                .and_then(|object| object.as_array().ok())
                .map(|values| {
                    values
                        .iter()
                        .map(|value| count_number_tree_entries(doc, value, visited))
                        .sum()
                })
                .unwrap_or(0);
            nums + kids
        }
        Object::Array(values) => values
            .iter()
            .map(|value| count_number_tree_entries(doc, value, visited))
            .sum(),
        _ => 0,
    }
}

fn deduplicate_content_refs(refs: &mut Vec<MarkedContentRef>) {
    refs.sort_by(|a, b| {
        a.page
            .cmp(&b.page)
            .then(a.owner.cmp(&b.owner))
            .then(a.mcid.cmp(&b.mcid))
            .then(a.child_order.cmp(&b.child_order))
    });
    refs.dedup_by(|a, b| a.page == b.page && a.owner == b.owner && a.mcid == b.mcid);
}

fn pdf_bbox_to_page(bbox: [f32; 4], page_height: f32) -> BBox {
    BBox {
        x: bbox[0],
        y: page_height - bbox[3],
        width: bbox[2] - bbox[0],
        height: bbox[3] - bbox[1],
    }
}

fn overlap_fraction(a: BBox, b: BBox) -> f32 {
    let left = a.x.max(b.x);
    let top = a.y.max(b.y);
    let right = a.right().min(b.right());
    let bottom = a.bottom().min(b.bottom());
    let intersection = (right - left).max(0.0) * (bottom - top).max(0.0);
    intersection / a.area().min(b.area()).max(1.0)
}

fn horizontal_overlap(a: BBox, b: BBox) -> f32 {
    (a.right().min(b.right()) - a.x.max(b.x)).max(0.0) / a.width.min(b.width).max(1.0)
}

fn table_columns(block: &Block) -> usize {
    match block {
        Block::Table { columns, .. } => *columns,
        _ => 0,
    }
}

fn table_rows(block: &Block) -> usize {
    match block {
        Block::Table { rows, .. } => *rows,
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{dictionary, Stream};

    #[test]
    fn scans_role_mapped_table_and_recovers_without_parent_tree() {
        let mut doc = LoDocument::with_version("1.7");
        let page_id = doc.new_object_id();
        let cell_id = doc.add_object(dictionary! {
            "Type" => "StructElem",
            "S" => "MyCell",
            "Pg" => page_id,
            "K" => 7,
            "A" => dictionary! { "O" => "Table", "ColSpan" => 2 },
        });
        let row_id = doc.add_object(dictionary! {
            "Type" => "StructElem", "S" => "MyRow", "K" => vec![cell_id.into()],
        });
        let table_id = doc.add_object(dictionary! {
            "Type" => "StructElem", "S" => "MyGrid", "K" => vec![row_id.into()],
        });
        let struct_root_id = doc.add_object(dictionary! {
            "Type" => "StructTreeRoot",
            "K" => vec![table_id.into()],
            "RoleMap" => dictionary! {
                "MyGrid" => "Table", "MyRow" => "TR", "MyCell" => "TD",
            },
        });
        let content_id = doc.add_object(Stream::new(
            dictionary! {},
            b"/TD <</MCID 7>> BDC EMC".to_vec(),
        ));
        doc.objects.insert(
            page_id,
            Object::Dictionary(dictionary! {
                "Type" => "Page", "Contents" => content_id,
            }),
        );
        let pages_id = doc.add_object(dictionary! {
            "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
        });
        doc.get_dictionary_mut(page_id)
            .unwrap()
            .set("Parent", pages_id);
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog", "Pages" => pages_id, "StructTreeRoot" => struct_root_id,
        });
        doc.trailer.set("Root", catalog_id);

        let report = inspect_document(&doc).unwrap();
        assert_eq!(report.tables.len(), 1);
        assert_eq!(report.tables[0].canonical_role, "Table");
        assert_eq!(report.tables[0].rows, 1);
        assert_eq!(report.tables[0].cells, 1);
        assert_eq!(report.tables[0].column_spans, 1);
        assert_eq!(report.tables[0].content_refs[0].mcid, 7);
        assert_eq!(report.nodes.len(), 3);
        assert_eq!(report.nodes[0].canonical_role, "Table");
        assert_eq!(report.nodes[0].children[0].kind, "structure");
        assert_eq!(report.nodes[2].children[0].kind, "mcid");
        assert!(!report.has_parent_tree);
    }

    #[test]
    fn resolves_pdf2_namespace_roles_and_preserves_mcr_objr_and_class_attributes() {
        let mut doc = LoDocument::with_version("2.0");
        let page_id = doc.new_object_id();
        let stream_owner = doc.add_object(Stream::new(dictionary! {}, Vec::new()));
        let annotation_id = doc.add_object(dictionary! { "Type" => "Annot" });
        let standard_namespace = doc.add_object(dictionary! {
            "Type" => "Namespace", "NS" => Object::string_literal("http://iso.org/pdf2/ssn"),
        });
        let custom_namespace = doc.add_object(dictionary! {
            "Type" => "Namespace",
            "NS" => Object::string_literal("https://example.test/custom"),
            "RoleMapNS" => dictionary! {
                "data-grid" => vec![Object::Name(b"Table".to_vec()), standard_namespace.into()],
                "data-row" => vec![Object::Name(b"TR".to_vec()), standard_namespace.into()],
                "data-cell" => vec![Object::Name(b"TD".to_vec()), standard_namespace.into()],
            },
        });
        let class_map = dictionary! {
            "wide-cell" => dictionary! { "O" => "Table", "ColSpan" => 3, "Scope" => "Column" },
        };
        let cell_id = doc.add_object(dictionary! {
            "Type" => "StructElem", "S" => "data-cell", "NS" => custom_namespace,
            "Pg" => page_id, "C" => "wide-cell",
            "K" => vec![
                Object::Dictionary(dictionary! {
                    "Type" => "MCR", "Pg" => page_id, "Stm" => stream_owner, "MCID" => 4,
                }),
                Object::Dictionary(dictionary! {
                    "Type" => "OBJR", "Pg" => page_id, "Obj" => annotation_id,
                }),
            ],
        });
        let row_id = doc.add_object(dictionary! {
            "Type" => "StructElem", "S" => "data-row", "NS" => custom_namespace,
            "K" => vec![cell_id.into()],
        });
        let table_id = doc.add_object(dictionary! {
            "Type" => "StructElem", "S" => "data-grid", "NS" => custom_namespace,
            "K" => vec![row_id.into()],
        });
        let parent_tree_leaf = doc.add_object(dictionary! {
            "Nums" => vec![Object::Integer(0), table_id.into()],
        });
        let parent_tree = doc.add_object(dictionary! { "Kids" => vec![parent_tree_leaf.into()] });
        let struct_root_id = doc.add_object(dictionary! {
            "Type" => "StructTreeRoot", "K" => vec![table_id.into()],
            "ClassMap" => class_map, "ParentTree" => parent_tree,
        });
        doc.objects.insert(
            page_id,
            Object::Dictionary(dictionary! { "Type" => "Page", "Contents" => stream_owner }),
        );
        let pages_id = doc.add_object(dictionary! {
            "Type" => "Pages", "Kids" => vec![page_id.into()], "Count" => 1,
        });
        doc.get_dictionary_mut(page_id)
            .unwrap()
            .set("Parent", pages_id);
        let catalog_id = doc.add_object(dictionary! {
            "Type" => "Catalog", "Pages" => pages_id, "StructTreeRoot" => struct_root_id,
        });
        doc.trailer.set("Root", catalog_id);

        let report = inspect_document(&doc).unwrap();
        assert_eq!(
            report.namespaces.get("https://example.test/custom"),
            Some(&1)
        );
        assert_eq!(report.parent_tree_entries, 1);
        assert_eq!(report.tables.len(), 1);
        let table = &report.tables[0];
        assert_eq!(table.canonical_role, "Table");
        assert_eq!(table.cells_detail[0].column_span, 3);
        assert_eq!(table.cells_detail[0].scope.as_deref(), Some("Column"));
        assert_eq!(table.content_refs[0].owner, object_id(stream_owner));
        assert_eq!(table.object_refs[0].object_id, object_id(annotation_id));
    }

    #[test]
    fn merges_only_aligned_same_column_fragments() {
        let table = |y: f32, text: &str| Block::Table {
            bbox: BBox {
                x: 40.0,
                y,
                width: 500.0,
                height: 40.0,
            },
            rows: 1,
            columns: 2,
            cells: vec![TableCell {
                row: 0,
                column: 0,
                row_span: 1,
                column_span: 1,
                text: text.into(),
                bbox: BBox {
                    x: 40.0,
                    y,
                    width: 200.0,
                    height: 20.0,
                },
            }],
            ruled: true,
            semantic_table_id: None,
            semantic_confidence: None,
            continues_from_previous_page: false,
            continues_on_next_page: false,
        };
        let mut pages = vec![Page {
            number: 1,
            width: 612.0,
            height: 792.0,
            blocks: vec![table(100.0, "a"), table(170.0, "b")],
            citations: vec![],
            note_references: vec![],
            sentences: vec![],
            semantic_regions: vec![],
            internal_links: vec![],
            marked_objects: vec![],
            images: vec![],
            lines: vec![],
            rules: vec![],
        }];
        let mut report = PdfStructureReport {
            tables: vec![TaggedTableEvidence {
                id: "10 0 R".into(),
                canonical_role: "Table".into(),
                raw_role: "Table".into(),
                pages: vec![1],
                rows: 2,
                confidence: 0.9,
                ..Default::default()
            }],
            ..Default::default()
        };
        reconcile(&mut report, &mut pages, TableReconciliationMode::Fused, 0.9);
        assert_eq!(pages[0].blocks.len(), 1);
        assert!(matches!(pages[0].blocks[0], Block::Table { rows: 2, .. }));
        assert_eq!(report.reconciliations.len(), 1);
    }
}
