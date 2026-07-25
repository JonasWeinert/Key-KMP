//! Shared academic-paper presentation for reader information surfaces.

use crate::scholarly::ScholarlyMetadata;
use gpui::{AnyElement, Hsla, IntoElement, div, prelude::*, px};

#[derive(Clone, Debug)]
pub(crate) struct AcademicPaperInfo {
    pub title: String,
    pub authors: Vec<String>,
    pub year: Option<u32>,
    pub journal: Option<String>,
    pub doi: Option<String>,
    pub abstract_text: Option<String>,
    pub source: &'static str,
    pub match_label: &'static str,
}

impl From<&ScholarlyMetadata> for AcademicPaperInfo {
    fn from(metadata: &ScholarlyMetadata) -> Self {
        Self {
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
            match_label: metadata
                .certainty
                .map(|certainty| certainty.label())
                .unwrap_or("DOI match"),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum AcademicPaperViewVariant {
    InfoPanel,
    ReferenceHero,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct AcademicPaperViewTheme {
    pub text: Hsla,
    pub secondary_text: Hsla,
    pub accent: Hsla,
}

pub(crate) fn render_academic_paper_view(
    id: &'static str,
    paper: &AcademicPaperInfo,
    variant: AcademicPaperViewVariant,
    theme: AcademicPaperViewTheme,
) -> AnyElement {
    let citation = [
        (!paper.authors.is_empty()).then(|| paper.authors.join(", ")),
        paper.journal.clone(),
        paper.year.map(|year| year.to_string()),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ");
    let source = format!("{} · {}", paper.source, paper.match_label);
    let base = div().id(id).min_w_0().flex().flex_col();
    match variant {
        AcademicPaperViewVariant::InfoPanel => base
            .pt_3()
            .child(
                div()
                    .text_xs()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(theme.accent)
                    .child(source),
            )
            .child(
                div()
                    .mt_1()
                    .max_h(px(46.0))
                    .overflow_hidden()
                    .text_sm()
                    .line_height(px(21.0))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(theme.text)
                    .child(paper.title.clone()),
            )
            .when(!citation.is_empty(), |view| {
                view.child(
                    div()
                        .mt_1()
                        .max_h(px(34.0))
                        .overflow_hidden()
                        .text_xs()
                        .line_height(px(17.0))
                        .text_color(theme.secondary_text)
                        .child(citation),
                )
            })
            .when_some(paper.doi.clone(), |view, doi| {
                view.child(
                    div()
                        .mt_1()
                        .text_xs()
                        .text_color(theme.secondary_text)
                        .child(format!("DOI: {doi}")),
                )
            })
            .when_some(paper.abstract_text.clone(), |view, abstract_text| {
                view.child(
                    div()
                        .mt_2()
                        .max_h(px(51.0))
                        .overflow_hidden()
                        .text_xs()
                        .line_height(px(17.0))
                        .text_color(theme.secondary_text)
                        .child(abstract_text),
                )
            })
            .into_any_element(),
        AcademicPaperViewVariant::ReferenceHero => base
            .pr(px(70.0))
            .child(
                div()
                    .text_xs()
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(theme.accent)
                    .child(source),
            )
            .child(
                div()
                    .mt_2()
                    .text_size(px(if paper.title.chars().count() > 120 {
                        17.0
                    } else {
                        19.0
                    }))
                    .line_height(px(if paper.title.chars().count() > 120 {
                        23.0
                    } else {
                        25.0
                    }))
                    .font_weight(gpui::FontWeight::SEMIBOLD)
                    .text_color(theme.text)
                    .child(paper.title.clone()),
            )
            .when(!citation.is_empty(), |view| {
                view.child(
                    div()
                        .mt_2()
                        .text_xs()
                        .text_color(theme.secondary_text)
                        .child(citation),
                )
            })
            .into_any_element(),
    }
}
