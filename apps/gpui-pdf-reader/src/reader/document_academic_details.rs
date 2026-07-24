//! Document-scoped academic metadata orchestration for reader surfaces.
//!
//! This module deliberately owns no GPUI rendering. It turns PDF metadata
//! into the reusable `key_reference` DOI-or-title query and projects the
//! resulting provider state for any reader information surface.

use super::*;
use crate::academic_paper_view::AcademicPaperInfo;

#[derive(Clone, Debug)]
pub(crate) enum AcademicDetailsDisplay {
    Loading,
    Ready(AcademicPaperInfo),
    Unavailable(String),
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum AcademicLookupState {
    #[default]
    Scanning,
    Loading,
    Ready,
    Failed,
}

#[derive(Default)]
pub(super) struct DocumentAcademicDetails {
    query: Option<ScholarlyQuery>,
    metadata: Vec<String>,
    title: Option<String>,
    external_urls: Vec<String>,
    state: AcademicLookupState,
    revision: u64,
}

impl DocumentAcademicDetails {
    pub(super) fn configure(
        &mut self,
        metadata: &[String],
        title: Option<&str>,
        external_urls: Vec<String>,
    ) {
        self.metadata = metadata.to_vec();
        self.title = title.map(str::to_owned);
        self.external_urls = external_urls;
        self.query = ScholarlyQuery::from_document_evidence(
            &self.metadata,
            None,
            &self.external_urls,
            self.title.as_deref(),
        );
        self.state = AcademicLookupState::Scanning;
        self.revision = self.revision.wrapping_add(1);
    }

    pub(super) fn clear(&mut self) {
        self.query = None;
        self.metadata.clear();
        self.title = None;
        self.external_urls.clear();
        self.state = AcademicLookupState::Scanning;
        self.revision = self.revision.wrapping_add(1);
    }

    /// Completes the first-page evidence pass before dispatching the lookup.
    pub(super) fn scan_first_page(
        &mut self,
        text: &str,
        fetcher: &ScholarlyFetcher,
        session: &mut ScholarlySession,
        generation: u64,
    ) {
        self.query = ScholarlyQuery::from_document_evidence(
            &self.metadata,
            Some(text),
            &self.external_urls,
            self.title.as_deref(),
        );
        if let Some(query) = self.query.clone() {
            session.request_query(fetcher, generation, query);
        } else {
            self.state = AcademicLookupState::Failed;
            self.revision = self.revision.wrapping_add(1);
        }
        self.refresh(session);
    }

    /// Records a provider update and reports whether an information surface
    /// needs to refresh.
    pub(super) fn refresh(&mut self, session: &ScholarlySession) -> bool {
        let Some(state) = self
            .query
            .as_ref()
            .and_then(|query| session.query_state(query))
            .map(|state| match state {
                ScholarlyMetadataState::Loading => AcademicLookupState::Loading,
                ScholarlyMetadataState::Ready(_) => AcademicLookupState::Ready,
                ScholarlyMetadataState::Failed(_) => AcademicLookupState::Failed,
            })
        else {
            return false;
        };
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
                Some(AcademicDetailsDisplay::Ready(AcademicPaperInfo::from(
                    metadata.as_ref(),
                )))
            }
            AcademicLookupState::Scanning => Some(AcademicDetailsDisplay::Loading),
            AcademicLookupState::Failed if self.query.is_none() => {
                Some(AcademicDetailsDisplay::Unavailable(
                    "No DOI or usable document title was found in this PDF.".to_owned(),
                ))
            }
            AcademicLookupState::Failed => {
                let message = self
                    .query
                    .as_ref()
                    .and_then(|query| session.query_state(query))
                    .and_then(|state| match state {
                        ScholarlyMetadataState::Failed(message) => Some(message.clone()),
                        ScholarlyMetadataState::Loading | ScholarlyMetadataState::Ready(_) => None,
                    })
                    .unwrap_or_else(|| {
                        "No academic paper record was found for this PDF.".to_owned()
                    });
                Some(AcademicDetailsDisplay::Unavailable(message))
            }
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
            Vec::new(),
        );
        assert_eq!(details.state, AcademicLookupState::Scanning);
        assert!(details.revision() > 0);
    }
}
