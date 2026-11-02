use serde::{Deserialize, Serialize};

fn is_false(value: &bool) -> bool {
    !*value
}

#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Serialize)]
pub struct BBox {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl BBox {
    pub fn right(self) -> f32 {
        self.x + self.width
    }
    pub fn bottom(self) -> f32 {
        self.y + self.height
    }
    pub fn center_x(self) -> f32 {
        self.x + self.width * 0.5
    }
    pub fn center_y(self) -> f32 {
        self.y + self.height * 0.5
    }
    pub fn area(self) -> f32 {
        self.width.max(0.0) * self.height.max(0.0)
    }
    pub fn union(self, other: Self) -> Self {
        let x = self.x.min(other.x);
        let y = self.y.min(other.y);
        let right = self.right().max(other.right());
        let bottom = self.bottom().max(other.bottom());
        Self {
            x,
            y,
            width: right - x,
            height: bottom - y,
        }
    }
    pub fn contains_center(self, other: Self) -> bool {
        let x = other.center_x();
        let y = other.center_y();
        x >= self.x && x <= self.right() && y >= self.y && y <= self.bottom()
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Span {
    pub text: String,
    pub bbox: BBox,
    pub font_size: f32,
    pub font_weight: u16,
    pub font_name: String,
    pub rotation: f32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct TextLine {
    pub text: String,
    pub bbox: BBox,
    pub font_size: f32,
    pub font_weight: u16,
    pub spans: Vec<Span>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct TableCell {
    pub row: usize,
    pub column: usize,
    pub row_span: usize,
    pub column_span: usize,
    pub text: String,
    pub bbox: BBox,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ReferenceItem {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub text: String,
    pub bbox: BBox,
    #[serde(default)]
    pub continued: bool,
    pub lines: Vec<TextLine>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ListItem {
    pub marker: String,
    pub level: usize,
    pub text: String,
    pub bbox: BBox,
    pub lines: Vec<TextLine>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Citation {
    pub block_index: usize,
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub style: String,
    pub bbox: BBox,
    pub confidence: f32,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub evidence: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_target_page: Option<usize>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub reference_labels: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub target_ids: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub external_urls: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct InternalLink {
    pub bbox: BBox,
    pub target_page: usize,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct NoteReference {
    pub block_index: usize,
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub note_id: String,
    pub bbox: BBox,
}

/// A logical prose sentence. `bbox` is the convenient union while `rects`
/// preserves the separate line fragments for wrapped sentences.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Sentence {
    pub block_index: usize,
    /// UTF-8 byte offsets into the containing paragraph's `text`.
    pub start: usize,
    pub end: usize,
    pub text: String,
    pub bbox: BBox,
    pub rects: Vec<BBox>,
}

/// A semantic region supported by PDF logical structure or marked content.
/// It is kept separate from text blocks because figures and artifacts may be
/// composed from several text, path, image, or Form XObject page objects.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct SemanticRegion {
    pub id: String,
    pub role: String,
    pub bbox: BBox,
    pub confidence: f32,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alt_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub caption: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub target_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub external_url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct MarkedObjectGeometry {
    pub mcid: i64,
    pub bbox: BBox,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct NoteItem {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub text: String,
    pub bbox: BBox,
    pub lines: Vec<TextLine>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Paragraph {
        bbox: BBox,
        text: String,
        lines: Vec<TextLine>,
    },
    Heading {
        bbox: BBox,
        text: String,
        level: u8,
        lines: Vec<TextLine>,
    },
    Table {
        bbox: BBox,
        rows: usize,
        columns: usize,
        cells: Vec<TableCell>,
        ruled: bool,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        semantic_table_id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        semantic_confidence: Option<f32>,
        #[serde(skip_serializing_if = "is_false", default)]
        continues_from_previous_page: bool,
        #[serde(skip_serializing_if = "is_false", default)]
        continues_on_next_page: bool,
    },
    List {
        bbox: BBox,
        ordered: bool,
        text: String,
        lines: Vec<TextLine>,
        items: Vec<ListItem>,
    },
    Equation {
        bbox: BBox,
        /// Geometry-reconstructed TeX-like representation. `text` preserves
        /// PDFium's raw extraction for auditability.
        #[serde(skip_serializing_if = "Option::is_none", default)]
        latex: Option<String>,
        text: String,
        #[serde(skip_serializing_if = "Option::is_none", default)]
        label: Option<String>,
        lines: Vec<TextLine>,
    },
    Algorithm {
        bbox: BBox,
        title: String,
        text: String,
        lines: Vec<TextLine>,
    },
    Header {
        bbox: BBox,
        text: String,
        lines: Vec<TextLine>,
    },
    Footer {
        bbox: BBox,
        text: String,
        lines: Vec<TextLine>,
    },
    PageNumber {
        bbox: BBox,
        text: String,
        value: usize,
        lines: Vec<TextLine>,
    },
    ReferenceList {
        bbox: BBox,
        numbering_style: String,
        continued_from_previous: bool,
        continues_on_next: bool,
        items: Vec<ReferenceItem>,
    },
    Footnote {
        bbox: BBox,
        item: NoteItem,
    },
    EndnoteList {
        bbox: BBox,
        items: Vec<NoteItem>,
    },
}

impl Block {
    pub fn bbox(&self) -> BBox {
        match self {
            Self::Paragraph { bbox, .. }
            | Self::Heading { bbox, .. }
            | Self::Table { bbox, .. }
            | Self::List { bbox, .. }
            | Self::Equation { bbox, .. }
            | Self::Algorithm { bbox, .. }
            | Self::Header { bbox, .. }
            | Self::Footer { bbox, .. }
            | Self::PageNumber { bbox, .. }
            | Self::ReferenceList { bbox, .. }
            | Self::Footnote { bbox, .. }
            | Self::EndnoteList { bbox, .. } => *bbox,
        }
    }
    pub fn text(&self) -> String {
        match self {
            Self::Paragraph { text, .. }
            | Self::Heading { text, .. }
            | Self::Header { text, .. }
            | Self::Footer { text, .. }
            | Self::PageNumber { text, .. } => text.clone(),
            Self::Table { cells, .. } => cells
                .iter()
                .map(|c| c.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            Self::List { text, .. } => text.clone(),
            Self::Equation { text, .. } => text.clone(),
            Self::Algorithm { text, .. } => text.clone(),
            Self::ReferenceList { items, .. } => items
                .iter()
                .map(|item| item.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
            Self::Footnote { item, .. } => item.text.clone(),
            Self::EndnoteList { items, .. } => items
                .iter()
                .map(|item| item.text.as_str())
                .collect::<Vec<_>>()
                .join(" "),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
pub struct Rule {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
    pub width: f32,
}

impl Rule {
    pub fn horizontal(self) -> bool {
        (self.y1 - self.y2).abs() <= 1.5 && (self.x2 - self.x1).abs() > 4.0
    }
    pub fn vertical(self) -> bool {
        (self.x1 - self.x2).abs() <= 1.5 && (self.y2 - self.y1).abs() > 4.0
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Page {
    pub number: usize,
    pub width: f32,
    pub height: f32,
    pub blocks: Vec<Block>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub citations: Vec<Citation>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub note_references: Vec<NoteReference>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub sentences: Vec<Sentence>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub semantic_regions: Vec<SemanticRegion>,
    #[serde(skip)]
    pub(crate) internal_links: Vec<InternalLink>,
    #[serde(skip)]
    pub(crate) marked_objects: Vec<MarkedObjectGeometry>,
    /// Raster image or image-bearing form regions extracted from the PDF page.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub images: Vec<BBox>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub lines: Vec<TextLine>,
    /// Retained internally for fraction bars, radical vincula, and formula
    /// fences after table reconstruction has consumed the same evidence.
    #[serde(skip)]
    pub(crate) rules: Vec<Rule>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Document {
    pub file_name: String,
    pub number_of_pages: usize,
    pub pages: Vec<Page>,
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub page_labels: Vec<String>,
    /// Best-effort raw tagged-PDF evidence. This is deliberately diagnostic:
    /// visible layout remains authoritative when tags and page geometry
    /// disagree.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub structure: Option<crate::tagged_pdf::PdfStructureReport>,
}
