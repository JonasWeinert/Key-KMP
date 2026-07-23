//! Document-scoped academic metadata orchestration for reader surfaces.
//!
//! This module deliberately owns no GPUI rendering. It turns PDF metadata
//! into the reusable `key_reference` DOI-or-title query and projects the
//! resulting provider state for any reader information surface.

use super::*;

#[derive(Clone, Debug)]
pub(crate) enum AcademicDetailsDisplay {
    Loading,
    Ready(AcademicPaperInfo),
}

#[derive(Clone, Debug)]
pub(crate) struct AcademicPaperInfo {
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<u32>,
    pub journal: Option<String>,
    pub doi: Option<String>,
    pub abstract_text: Option<String>,
    pub source: &'static str,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum AcademicLookupState {
    #[default]
    None,
    Loading,
    Ready,
    Failed,
}

#[derive(Default)]
pub(super) struct DocumentAcademicDetails {
    query: Option<ScholarlyQuery>,
    state: AcademicLookupState,
    revision: u64,
}

impl DocumentAcademicDetails {
    pub(super) fn configure(&mut self, metadata: &[String], title: Option<&str>) {
        self.query = ScholarlyQuery::from_document_metadata(metadata, title);
        self.state = AcademicLookupState::None;
        self.revision = self.revision.wrapping_add(1);
    }

    pub(super) fn clear(&mut self) {
        self.query = None;
        self.state = AcademicLookupState::None;
        self.revision = self.revision.wrapping_add(1);
    }

    pub(super) fn request(
        &mut self,
        fetcher: &ScholarlyFetcher,
        session: &mut ScholarlySession,
        generation: u64,
    ) {
        if let Some(query) = self.query.clone() {
            session.request_query(fetcher, generation, query);
            self.refresh(session);
        }
    }

    /// Records a provider update and reports whether an information surface
    /// needs to refresh.
    pub(super) fn refresh(&mut self, session: &ScholarlySession) -> bool {
        let state = self
            .query
            .as_ref()
            .and_then(|query| session.query_state(query))
            .map_or(AcademicLookupState::None, |state| match state {
                ScholarlyMetadataState::Loading => AcademicLookupState::Loading,
                ScholarlyMetadataState::Ready(_) => AcademicLookupState::Ready,
                ScholarlyMetadataState::Failed(_) => AcademicLookupState::Failed,
            });
        if self.state == state {
            return false;
        }
        self.state = state;
        self.revision = self.revision.wrapping_add(1);
        true
    }

    pub(super) fn revision(&self) -> u64 {
        self.revision
    }

    pub(super) fn display(&self, session: &ScholarlySession) -> Option<AcademicDetailsDisplay> {
        match self.state {
            AcademicLookupState::Loading => Some(AcademicDetailsDisplay::Loading),
            AcademicLookupState::Ready => {
                let ScholarlyMetadataState::Ready(metadata) = self
                    .query
                    .as_ref()
                    .and_then(|query| session.query_state(query))?
                else {
                    return None;
                };
                Some(AcademicDetailsDisplay::Ready(AcademicPaperInfo {
                    title: metadata.title.clone(),
                    authors: metadata.authors.clone(),
                    year: metadata.year,
                    journal: metadata
                        .journal_short
                        .clone()
                        .or_else(|| metadata.journal.clone()),
                    doi: metadata.doi.clone(),
                    abstract_text: metadata.abstract_text.clone(),
                    source: metadata.source.label(),
                }))
            }
            AcademicLookupState::None | AcademicLookupState::Failed => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn document_metadata_query_is_configured_without_a_reader_view() {
        let mut details = DocumentAcademicDetails::default();
        details.configure(
            &["doi:10.1000/document".to_owned()],
            Some("A title that would otherwise be searched"),
        );
        assert_eq!(details.state, AcademicLookupState::None);
        assert!(details.revision() > 0);
    }
}
