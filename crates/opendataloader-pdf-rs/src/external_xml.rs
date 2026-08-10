//! Opt-in retrieval of scientific XML associated with a PDF.
//!
//! PubMed XML is bibliographic/abstract XML. PMC OAI `pmc` records are full
//! JATS only when PMC permits full-text reuse. The official arXiv API returns
//! Atom metadata XML, not full article XML; arXiv full text is TeX source.

use std::collections::BTreeSet;
use std::fs;
use std::io::Read;
use std::path::Path;

use anyhow::{Context, Result};
use lopdf::{Document as LoDocument, Object};
use regex::Regex;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::model::Document;

const USER_AGENT: &str = "OpenDataLoader-PDF/0.1 (scientific XML resolver)";

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ScientificIdentifiers {
    pub dois: Vec<String>,
    pub arxiv_ids: Vec<String>,
    pub pmids: Vec<String>,
    pub pmcids: Vec<String>,
    pub evidence: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct XmlArtifact {
    pub kind: String,
    pub source: String,
    pub url: String,
    pub path: String,
    pub cached: bool,
    pub full_text: bool,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct XmlFetchManifest {
    pub identifiers: ScientificIdentifiers,
    pub selected_source: Option<String>,
    pub artifacts: Vec<XmlArtifact>,
    pub warnings: Vec<String>,
}

pub fn discover_identifiers(
    path: &Path,
    password: Option<&str>,
    converted: &Document,
) -> Result<ScientificIdentifiers> {
    let mut doc = LoDocument::load(path).with_context(|| format!("open {}", path.display()))?;
    if doc.is_encrypted() && password.is_none() {
        anyhow::bail!("{} is encrypted; a password is required", path.display());
    }
    if let Some(password) = password.filter(|_| doc.is_encrypted()) {
        doc.decrypt(password)
            .with_context(|| format!("decrypt {}", path.display()))?;
    }
    let mut samples = Vec::<(String, String)>::new();
    if let Ok(info_ref) = doc.trailer.get(b"Info") {
        if let Some(dict) = deref_dict(&doc, info_ref) {
            for (key, value) in dict.iter() {
                if let Some(text) = pdf_string(value) {
                    samples.push((format!("Info/{}", String::from_utf8_lossy(key)), text));
                }
            }
        }
    }
    if let Ok(root) = doc.trailer.get(b"Root").and_then(Object::as_reference) {
        if let Ok(catalog) = doc.get_dictionary(root) {
            if let Ok(metadata) = catalog.get(b"Metadata") {
                if let Some(stream) = deref_stream(&doc, metadata) {
                    if let Ok(bytes) = stream.decompressed_content() {
                        samples.push((
                            "XMP metadata".into(),
                            String::from_utf8_lossy(&bytes).into(),
                        ));
                    }
                }
            }
        }
    }
    if let Some(name) = path.file_name().and_then(|name| name.to_str()) {
        samples.push(("file name".into(), name.into()));
    }
    let first_page_text = converted
        .pages
        .iter()
        .take(2)
        .flat_map(|page| page.blocks.iter().map(|block| block.text()))
        .collect::<Vec<_>>()
        .join("\n");
    samples.push(("first two pages".into(), first_page_text));

    let doi_re = Regex::new(r"(?i)\b10\.\d{4,9}/[-._;()/:A-Z0-9]+")?;
    // In document text, require an explicit arXiv label. An unlabelled value
    // such as 2025.12345 can be an ordinary measurement or publisher number.
    let arxiv_re = Regex::new(r"(?i)\barxiv\s*:\s*(\d{4}\.\d{4,5})(?:v\d+)?\b")?;
    let old_arxiv_re = Regex::new(r"(?i)\barxiv\s*:\s*([a-z-]+(?:\.[A-Z]{2})?/\d{7})(?:v\d+)?\b")?;
    let arxiv_filename_re = Regex::new(r"(?i)(?:^|[^0-9])(\d{4}\.\d{4,5})(?:v\d+)?(?:[^0-9]|$)")?;
    let pmid_re = Regex::new(r"(?i)\bPMID\s*:?\s*(\d{6,9})\b")?;
    let pmcid_re = Regex::new(r"(?i)\b(PMC\d{5,10})\b")?;
    let mut dois = BTreeSet::new();
    let mut arxiv_ids = BTreeSet::new();
    let mut pmids = BTreeSet::new();
    let mut pmcids = BTreeSet::new();
    let mut evidence = BTreeSet::new();
    for (source, text) in samples {
        for found in doi_re.find_iter(&text) {
            let doi = clean_doi(found.as_str());
            if dois.insert(doi.clone()) {
                evidence.insert(format!("DOI {doi} from {source}"));
            }
        }
        for captures in arxiv_re.captures_iter(&text) {
            let id = captures[1].to_ascii_lowercase();
            if arxiv_ids.insert(id.clone()) {
                evidence.insert(format!("arXiv {id} from {source}"));
            }
        }
        for captures in old_arxiv_re.captures_iter(&text) {
            let id = captures[1].to_ascii_lowercase();
            if arxiv_ids.insert(id.clone()) {
                evidence.insert(format!("arXiv {id} from {source}"));
            }
        }
        if source == "file name" {
            if let Some(captures) = arxiv_filename_re.captures(&text) {
                let id = captures[1].to_ascii_lowercase();
                if arxiv_ids.insert(id.clone()) {
                    evidence.insert(format!("arXiv {id} from {source}"));
                }
            }
        }
        for captures in pmid_re.captures_iter(&text) {
            pmids.insert(captures[1].into());
        }
        for captures in pmcid_re.captures_iter(&text) {
            pmcids.insert(captures[1].to_ascii_uppercase());
        }
    }
    let mut dois: Vec<_> = dois.into_iter().collect();
    dois.sort_by_key(|doi| doi_priority(doi));
    Ok(ScientificIdentifiers {
        dois,
        arxiv_ids: arxiv_ids.into_iter().collect(),
        pmids: pmids.into_iter().collect(),
        pmcids: pmcids.into_iter().collect(),
        evidence: evidence.into_iter().collect(),
    })
}

pub fn fetch_for_pdf(
    path: &Path,
    password: Option<&str>,
    converted: &Document,
    output_dir: &Path,
    ncbi_email: Option<&str>,
    refresh: bool,
) -> Result<XmlFetchManifest> {
    fs::create_dir_all(output_dir).with_context(|| format!("create {}", output_dir.display()))?;
    let mut manifest = XmlFetchManifest {
        identifiers: discover_identifiers(path, password, converted)?,
        ..Default::default()
    };
    if !manifest.identifiers.arxiv_ids.is_empty() {
        manifest.selected_source = Some("arxiv".into());
        fetch_arxiv(&mut manifest, output_dir, refresh)?;
    } else if !manifest.identifiers.dois.is_empty()
        || !manifest.identifiers.pmids.is_empty()
        || !manifest.identifiers.pmcids.is_empty()
    {
        manifest.selected_source = Some("pubmed".into());
        fetch_ncbi(&mut manifest, output_dir, ncbi_email, refresh)?;
        if manifest.artifacts.is_empty() && !manifest.identifiers.dois.is_empty() {
            manifest
                .warnings
                .push("No PubMed record resolved; trying the official arXiv API by DOI".into());
            fetch_arxiv(&mut manifest, output_dir, refresh)?;
            if !manifest.artifacts.is_empty() {
                manifest.selected_source = Some("arxiv".into());
            }
        }
    } else {
        manifest
            .warnings
            .push("No DOI, arXiv ID, PMID, or PMCID discovered".into());
    }
    let manifest_path = output_dir.join("manifest.json");
    write_manifest(&manifest_path, &manifest)?;
    Ok(manifest)
}

pub fn write_manifest(path: &Path, manifest: &XmlFetchManifest) -> Result<()> {
    fs::write(path, serde_json::to_string_pretty(manifest)? + "\n")
        .with_context(|| format!("write {}", path.display()))
}

fn fetch_arxiv(manifest: &mut XmlFetchManifest, output: &Path, refresh: bool) -> Result<()> {
    let query = if let Some(id) = manifest.identifiers.arxiv_ids.first() {
        format!("id_list={id}")
    } else if let Some(doi) = manifest.identifiers.dois.first() {
        format!("search_query=doi:%22{}%22&max_results=1", encode(doi))
    } else {
        return Ok(());
    };
    let url = format!("https://export.arxiv.org/api/query?{query}");
    let path = output.join("arxiv-atom.xml");
    let cached = fetch_to(&url, &path, refresh)?;
    let body = fs::read_to_string(&path)?;
    if !body.contains("<entry>") && !body.contains("<entry ") {
        manifest
            .warnings
            .push("arXiv returned no matching entry".into());
        return Ok(());
    }
    manifest.artifacts.push(XmlArtifact {
        kind: "arxiv_atom".into(),
        source: "arxiv".into(),
        url,
        path: path.display().to_string(),
        cached,
        full_text: false,
    });
    manifest.warnings.push(
        "The official arXiv API returns Atom metadata XML, not full article XML; arXiv full text is TeX source"
            .into(),
    );
    Ok(())
}

fn fetch_ncbi(
    manifest: &mut XmlFetchManifest,
    output: &Path,
    email: Option<&str>,
    refresh: bool,
) -> Result<()> {
    if manifest.identifiers.pmids.is_empty() && manifest.identifiers.pmcids.is_empty() {
        for (index, doi) in manifest.identifiers.dois.clone().iter().enumerate() {
            let mut url = Url::parse("https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/")?;
            url.query_pairs_mut()
                .append_pair("ids", doi)
                .append_pair("format", "json")
                .append_pair("tool", "opendataloader_pdf");
            if let Some(email) = email {
                url.query_pairs_mut().append_pair("email", email);
            }
            let id_path = output.join(format!("pmc-id-converter-{}.json", index + 1));
            fetch_to(url.as_str(), &id_path, refresh)?;
            let response: IdConverterResponse = serde_json::from_slice(&fs::read(&id_path)?)?;
            if let Some(record) = response.records.into_iter().next() {
                if let Some(pmid) = record.pmid {
                    manifest.identifiers.pmids.push(pmid.to_string());
                }
                if let Some(pmcid) = record.pmcid {
                    manifest.identifiers.pmcids.push(pmcid);
                }
            }
            if !manifest.identifiers.pmids.is_empty() || !manifest.identifiers.pmcids.is_empty() {
                break;
            }
        }
    }
    if manifest.identifiers.pmids.is_empty() {
        for (index, doi) in manifest.identifiers.dois.clone().iter().enumerate() {
            let mut url = Url::parse("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi")?;
            url.query_pairs_mut()
                .append_pair("db", "pubmed")
                .append_pair("term", &format!("{doi}[DOI]"))
                .append_pair("retmode", "json")
                .append_pair("tool", "opendataloader_pdf");
            if let Some(email) = email {
                url.query_pairs_mut().append_pair("email", email);
            }
            let search_path = output.join(format!("pubmed-search-{}.json", index + 1));
            fetch_to(url.as_str(), &search_path, refresh)?;
            let response: PubmedSearchResponse = serde_json::from_slice(&fs::read(&search_path)?)?;
            manifest
                .identifiers
                .pmids
                .extend(response.esearchresult.idlist);
            if !manifest.identifiers.pmids.is_empty() {
                break;
            }
        }
    }
    if let Some(pmid) = manifest.identifiers.pmids.first() {
        let mut url = Url::parse("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi")?;
        url.query_pairs_mut()
            .append_pair("db", "pubmed")
            .append_pair("id", pmid)
            .append_pair("retmode", "xml")
            .append_pair("tool", "opendataloader_pdf");
        if let Some(email) = email {
            url.query_pairs_mut().append_pair("email", email);
        }
        let path = output.join("pubmed.xml");
        let cached = fetch_to(url.as_str(), &path, refresh)?;
        manifest.artifacts.push(XmlArtifact {
            kind: "pubmed_record".into(),
            source: "pubmed".into(),
            url: url.to_string(),
            path: path.display().to_string(),
            cached,
            full_text: false,
        });
    }
    if let Some(pmcid) = manifest.identifiers.pmcids.first() {
        let numeric = pmcid.trim_start_matches("PMC");
        let mut url = Url::parse("https://pmc.ncbi.nlm.nih.gov/api/oai/v1/mh/")?;
        url.query_pairs_mut()
            .append_pair("verb", "GetRecord")
            .append_pair(
                "identifier",
                &format!("oai:pubmedcentral.nih.gov:{numeric}"),
            )
            .append_pair("metadataPrefix", "pmc");
        let path = output.join("pmc-fulltext.xml");
        let cached = fetch_to(url.as_str(), &path, refresh)?;
        let body = fs::read_to_string(&path)?;
        if body.contains("<article") {
            manifest.artifacts.push(XmlArtifact {
                kind: "pmc_jats".into(),
                source: "pmc".into(),
                url: url.to_string(),
                path: path.display().to_string(),
                cached,
                full_text: true,
            });
        } else {
            manifest.warnings.push(format!(
                "PMC did not return reusable full-text JATS for {pmcid}"
            ));
        }
    }
    manifest.identifiers.pmids.sort();
    manifest.identifiers.pmids.dedup();
    manifest.identifiers.pmcids.sort();
    manifest.identifiers.pmcids.dedup();
    Ok(())
}

fn fetch_to(url: &str, path: &Path, refresh: bool) -> Result<bool> {
    if path.exists() && !refresh {
        return Ok(true);
    }
    let response = ureq::get(url)
        .set("User-Agent", USER_AGENT)
        .set(
            "Accept",
            "application/xml, application/json;q=0.9, */*;q=0.1",
        )
        .call()
        .with_context(|| format!("GET {url}"))?;
    let mut bytes = Vec::new();
    response.into_reader().read_to_end(&mut bytes)?;
    fs::write(path, bytes).with_context(|| format!("write {}", path.display()))?;
    Ok(false)
}

fn clean_doi(value: &str) -> String {
    value
        .trim()
        .trim_end_matches(|character: char| {
            matches!(character, '.' | ',' | ';' | ':' | ')' | ']' | '}')
        })
        .to_ascii_lowercase()
}

fn doi_priority(doi: &str) -> (bool, bool) {
    // Publisher metadata frequently includes both the article DOI and a
    // journal-level ISSN DOI. Article identifiers are the resolvable target.
    (
        doi.contains("(issn)"),
        doi.ends_with("/journal") || doi.ends_with("/issue"),
    )
}

fn encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn deref_dict<'a>(doc: &'a LoDocument, object: &'a Object) -> Option<&'a lopdf::Dictionary> {
    match object {
        Object::Dictionary(dict) => Some(dict),
        Object::Reference(id) => doc.get_dictionary(*id).ok(),
        _ => None,
    }
}

fn deref_stream<'a>(doc: &'a LoDocument, object: &'a Object) -> Option<&'a lopdf::Stream> {
    match object {
        Object::Stream(stream) => Some(stream),
        Object::Reference(id) => doc.get_object(*id).ok()?.as_stream().ok(),
        _ => None,
    }
}

fn pdf_string(object: &Object) -> Option<String> {
    match object {
        Object::String(bytes, _) => Some(String::from_utf8_lossy(bytes).into()),
        Object::Name(bytes) => Some(String::from_utf8_lossy(bytes).into()),
        _ => None,
    }
}

#[derive(Debug, Default, Deserialize)]
struct IdConverterResponse {
    #[serde(default)]
    records: Vec<IdConverterRecord>,
}

#[derive(Debug, Default, Deserialize)]
struct IdConverterRecord {
    pmid: Option<u64>,
    pmcid: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct PubmedSearchResponse {
    esearchresult: PubmedSearchResult,
}

#[derive(Debug, Default, Deserialize)]
struct PubmedSearchResult {
    #[serde(default)]
    idlist: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_doi_sentence_punctuation() {
        assert_eq!(clean_doi("10.1000/Test.123)."), "10.1000/test.123");
    }

    #[test]
    fn article_doi_sorts_before_journal_issn_doi() {
        let mut dois = ["10.1002/(issn)2769-2450", "10.1002/puh2.70198"];
        dois.sort_by_key(|doi| doi_priority(doi));
        assert_eq!(dois[0], "10.1002/puh2.70198");
    }
}
