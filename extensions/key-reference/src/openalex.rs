//! Raw OpenAlex API requests for library enrichment. The caller paces requests, retries
//! and decides what a status means; this only builds the URL (with the polite-pool
//! `mailto` and an optional API key) and fetches it through the bounded public-JSON client.
use crate::link_preview::fetch_public_json_response;
use key_safe_http::CancellationToken;
use std::time::Duration;
use url::Url;

const MAX_OPENALEX_BYTES: usize = 8 * 1024 * 1024;

/// What OpenAlex answered: the status, how long it asked us to wait, and the body.
#[derive(Clone, Debug)]
pub struct OpenAlexResponse {
    pub status: u16,
    pub retry_after: Option<Duration>,
    pub body: Vec<u8>,
}

/// GET `https://api.openalex.org/<path>?<query>&mailto=…&api_key=…`.
pub fn openalex_get(path: &str, query: &[(&str, &str)], mailto: Option<&str>, api_key: Option<&str>) -> Result<OpenAlexResponse, String> {
    let mut url = Url::parse("https://api.openalex.org/").map_err(|error| error.to_string())?;
    url.set_path(path.trim_start_matches('/'));
    {
        let mut pairs = url.query_pairs_mut();
        for (key, value) in query {
            pairs.append_pair(key, value);
        }
        if let Some(mailto) = mailto.filter(|m| m.contains('@')) {
            pairs.append_pair("mailto", mailto);
        }
        if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
            pairs.append_pair("api_key", key.trim());
        }
    }
    let response = fetch_public_json_response(url.as_str(), MAX_OPENALEX_BYTES, &CancellationToken::active()).map_err(|error| format!("OpenAlex: {error}"))?;
    let retry_after = response.header("retry-after").and_then(|h| h.value_str()).and_then(|v| v.trim().parse::<u64>().ok()).map(Duration::from_secs);
    Ok(OpenAlexResponse { status: response.status(), retry_after, body: response.body().to_vec() })
}
