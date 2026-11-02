# Standalone scholarly access resolver: implementation plan

Planning baseline: 13 September 2026. No resolver implementation yet.

## Objective and scope

Build `key-scholar-access`, a standalone Rust crate that takes a DOI (or an already-known article/PDF URL), discovers candidate full-text locations, and constructs institution-specific access links. Export the same engine to browser WASM. A minimal React test app renders its results; a thin native CLI exercises the same public API.

All domain logic belongs in Rust: DOI parsing, provider requests and response parsing, institution search/filtering, caching policy, publisher identification, PDF extraction, authentication-link construction, candidate ranking, and download validation. React owns presentation and browser navigation only.

V1 uses Crossref, OpenAlex, SeamlessAccess metadata, and a curated publisher registry informed by Zotero translators and publisher/federation documentation. It does not require an entitlement database. Later holdings adapters can operate on institution + ISSN + publication date without redesigning the resolver.

## Conversation reviewed

Read all 45 available turns across five pages of “OpenURL resolver access,” including its attached screenshot. The conversation evolved from OpenURL/EZproxy enumeration to publisher-initiated SAML, then a working direct SeamlessAccess search prototype, and finally possible holdings sources.

Carry forward:

- The user reported the final direct-metadata T&F prototype worked. Its reference DOI is `10.1080/10810730.2011.571340`.
- LSE's identity is `https://lse.ac.uk/idp`; Tübingen's is `https://idp.uni-tuebingen.de/shibboleth`.
- Show institution name and logo; keep technical identifiers in diagnostics. Cache all valid discovered institutions, not just selections.
- The publisher initiates SAML. SeamlessAccess supplies institution metadata; it does not grant access or proxy PDFs.
- Wiley's `/epdf/` browser viewer is distinct from a raw PDF download.
- Earlier guessed widget APIs, logo fields, OpenAthens customer IDs, and universal proxy assumptions were superseded or remained unverified. Do not implement them as facts.
- EZB, SFX, KB+, GOKb, KBART, LibKey and OCLC were discussed as future entitlement sources. Their coverage and present API contracts require separate verification before implementation.

## Evidence collected in this planning pass

Cloned upstream research checkouts outside the product repository:

| Repository | Checkout | Revision |
| --- | --- | --- |
| Zotero translators | `/tmp/gpuipdf-zotero-translators` | `c83003773b65359e41466e1d419b2d1df5512af7` |
| Zotero connectors | `/tmp/gpuipdf-zotero-connectors` | `1d4fac3779aeec9ca7975d8a771c177f34fbd982` |

Parsed 748 translator metadata headers. A preliminary scan of implementation sections found explicit PDF signals in 221 files. This is a triage count, not supported-publisher coverage: some translators delegate to generic translators, and some apparent PDF code is conditional or obsolete. The exhaustive semantic audit remains phase 1.

Inspected PDF paths in T&F, Wiley, ScienceDirect, Springer Link, SAGE, Cambridge Core, ACM, IEEE, Silverchair, JSTOR, and Embedded Metadata. Inspected Connector architecture and cookie-handling paths: extension capabilities are part of its behavior and cannot be assumed in an ordinary webpage.

Live anonymous GET checks, with `Origin: http://localhost:5173`, returned HTTP 200 and `Access-Control-Allow-Origin: *` for:

- SeamlessAccess searches for London School of Economics and Tübingen.
- Crossref's work record for the reference DOI.
- OpenAlex's work record for the same DOI.

LSE search returns both the production IdP and a hidden test IdP. The actual logo field is `entity_icon_url.url`; `hidden` is currently a string. The SHA1 `id` is not the SAML entity ID.

Crossref supplies the T&F landing URL through `resource.primary.URL`; its top-level `URL` points back to DOI.org. Its PDF-shaped `link` has `content-type: unspecified` and `intended-application: similarity-checking`. Preserve those annotations rather than declaring a verified general-purpose download. OpenAlex returns journal identifiers and locations, but no OA PDF for this example.

These are HTTP/header checks, not a completed browser/WASM or authenticated download test. Raw responses and the preliminary inventory are in `/tmp/gpuipdf-*.json` for this session.

Current [OpenAlex authentication documentation](https://help.openalex.org/api/authentication/) permits basic anonymous queries and optional keys for larger budgets. That matches the live check; older announcements about mandatory keys should not drive the implementation. [Crossref documents its public metadata API](https://www.crossref.org/documentation/retrieve-metadata/rest-api/) and full-text link annotations.

## Crate and host boundaries

Proposed layout:

```text
crates/key-scholar-access/
  Cargo.toml                  # rlib + cdylib, explicit package metadata
  src/
    lib.rs                    # stable public Rust API
    model.rs                  # serializable inputs, results, errors, evidence
    doi.rs
    metadata/{crossref,openalex}.rs
    institution/{mod,seamlessaccess}.rs
    publisher/{mod,registry,...}.rs
    discovery/{mod,html,...}.rs
    auth/{mod,atypon,elsevier,...}.rs
    resolve.rs
    download.rs
    cache.rs
    transport/{mod,native,web}.rs
    bindings.rs               # wasm-bindgen wrapper only
    bin/scholar-access.rs     # optional CLI feature
  data/publishers.json
  tests/fixtures/
apps/scholar-access-test/     # isolated React + TypeScript test harness
docs/scholarly-access/       # source audit and coverage reports
```

One crate initially, with optional `native`, `web`, and `cli` features and target-specific dependencies. Keep pure model/parsing/URL logic usable without a runtime. Compile native and `wasm32-unknown-unknown` from the first milestone. Use explicit package fields so it remains extractable/publishable outside this workspace. Do not depend on GPUI, Tauri, PDFium, the office apps, or a sibling crate for core behavior.

The workspace currently uses blocking `zed-reqwest`; `key-safe-http` also depends on OS DNS, threads, and files. It cannot serve as the browser transport unchanged. Define an async transport boundary with a native HTTP implementation and a Rust `web-sys` Fetch implementation. Reuse security principles from `key-safe-http`, without importing its native machinery into the portable core. Select actual HTTP/parser crate versions after native/WASM and license checks.

Transport responses carry status, headers, final URL and bounded body access. Capabilities describe whether redirects can be inspected, credentials supplied, and bodies streamed. Avoid unconditional `Send` requirements on browser futures. Inject a clock/cache and cancellation handling so retries and expiry are deterministic in tests.

Use Rust implementations for native persistence and browser storage. A compact versioned file cache is sufficient initially; IndexedDB is appropriate for accumulating browser institution records. Store entity metadata by entity ID with timestamps, provider origin, expiry, and bounded retention. Query-result caches are separate. Do not persist transient SAML exchanges, session-specific PDF tokens, or API keys in shared records.

## Public behavior

Expose conceptual operations:

```text
search_institutions(query, locale) -> institution results
resolve(request) -> resolution with ranked candidates and diagnostics
discover_from_document(url, html) -> candidates
build_access_link(candidate, institution) -> access route
probe(candidate) -> verification evidence
download(candidate, sink) -> download receipt
```

The WASM wrapper exports async equivalents and serializable results with generated TypeScript types. Host code need not interpret provider JSON or construct URLs. Browser save/navigation calls are platform effects, not duplicate resolver logic.

Model these separately:

- `Work`: DOI, title, journal identifiers, partial online/print dates, provider identifiers, source provenance and conflicts.
- `Institution`: entity ID, localized names, domains/scopes, logo, discovery status, source and freshness. Do not equate a SAML entity ID with a ROR ID or an OpenAthens customer domain.
- `Candidate`: target URL, kind (raw-PDF candidate, viewer, article), publication version, OA evidence, discovery method, prerequisites and durability.
- `AccessRoute`: direct, publisher SAML, known proxy, or article fallback; each points to a candidate.
- `Verification`: unverified, PDF header observed, complete PDF downloaded, HTML/interstitial observed, HTTP failure, or inspection unavailable. A CORS/network failure is not proof of denied access.
- `Entitlement`: unknown by default; future provider-scoped evidence has institution, platform, coverage, date, source and freshness. Authentication success and PDF retrieval are different observations.
- `NextAction`: open URL in browser, provide document context, retry later, choose another candidate, or save available bytes.

A result can be partially useful when a provider is unavailable. Return diagnostics with the usable routes rather than failing the whole operation. API failure categories include malformed DOI, not found by provider, unsupported platform, rate limited, network/inspection unavailable, login/interstitial, unexpected response and cancellation.

## Resolution pipeline

1. Normalize bare DOI, `doi:` input, DOI.org URL, or explicitly recognized proxy-wrapped DOI URL. Preserve original input, validate structure, percent-decode carefully, and encode path/query components at their respective layers. Test punctuation and encoded delimiters; do not blindly trim meaningful DOI characters.
2. Query Crossref and OpenAlex with independent timeouts and bounded retries. Merge fields with provenance; keep print/online date precision and all relevant ISSNs. Crossref absence is not proof a DOI is invalid.
3. Collect publisher landing URLs and OA locations. Prefer actual resource URLs over DOI.org aliases. Follow DOI resolution when metadata is missing or conflicts, subject to transport capability.
4. Identify the hosting platform using observed URLs and corroborating metadata. DOI prefixes are hints only: titles transfer, and publisher names are not hostnames.
5. Generate candidates from explicit metadata, verified platform URL rules, HTML metadata/link extraction, and bounded publisher-specific intermediate requests. Use supplied HTML when the host already has it. Resolve relative URLs against the document URL and reject unrelated supplements as the primary paper.
6. Rank by evidence, source/version preference, verification and required interaction. Default to a usable OA published version when available, then an institutional publisher route, while retaining labeled alternatives such as accepted manuscripts. Never silently substitute a different work/version.
7. Compose publisher SAML links with the selected entity ID. Allow optional explicitly configured EZproxy/OpenAthens routes; never guess their institutional identifiers. Keep authentication recipes separate from PDF extraction recipes.
8. Probe/download only where supported. Use bounded GET inspection rather than treating HEAD or a `.pdf` suffix as proof. Check status, MIME type and PDF signature; a header probe is not full-document validation. Stream complete native downloads to a temporary destination, enforce limits, then finalize a receipt. Browser downloads may instead require navigation.

URLs fetched natively must use permitted HTTP(S) schemes and destinations, with redirect limits, public-address validation, size/time budgets and no credential forwarding to unrelated hosts. Atypon relative targets must remain on the configured publisher origin. Signed query strings must not be reordered or decoded opportunistically. The browser cannot expose every redirect hop; return that limitation explicitly.

## Publisher audit and implementation strategy

The research source is primarily [Zotero translators](https://github.com/zotero/translators); [Zotero Connectors](https://github.com/zotero/zotero-connectors) explains browser/network orchestration. Neither is a drop-in Rust library.

Phase 1 must produce a record for every translator, including non-relevant ones: translator ID, revision, target/priority, helper dependencies, PDF discovery steps, runtime prerequisites, attachment kind, URL durability, test cases, license notice, and disposition. Initial regex scans only locate work. Read the actual function paths and follow generic-translator dependencies before classifying support.

Classify into deterministic URL construction, HTML metadata/selectors, embedded JSON, extra HTTP requests, browser execution/session dependencies, and no applicable PDF support. Review useful generic families as well as publisher names. Use an AST-capable inventory tool where needed; never execute arbitrary upstream translator code inside the product or automatically convert its JavaScript regexes into Rust regexes.

Observed initial rules:

| Platform | Upstream observation | Planned treatment |
| --- | --- | --- |
| T&F | `/doi/pdf/{doi}` attachment construction | First complete DOI + institution slice |
| Wiley | `citation_pdf_url`, replacing `/pdf/` with `/pdfdirect/` | Raw-download candidate; label `/epdf/` separately |
| SAGE | `/doi/pdf/{doi}` | Simple candidate once host is established |
| Springer Link | `/content/pdf/{encoded DOI}.pdf` | Constructed candidate; verify current host aliases |
| ScienceDirect | Links, embed, JSON, canonical `/pdfft?download=true`, intermediate pages; sometimes DOM click | Implement static/HTTP paths; mark browser-dependent cases explicitly |
| Cambridge Core | `citation_pdf_url` or PDF action anchor | HTML extraction; no universal DOI-only rule |
| ACM | DOI PDF route gated by page evidence | Preserve the evidence/prerequisite rather than treating every DOI as downloadable |
| IEEE | Article number, stamp gateway and iframe/meta refresh, `getPDF.jsp` fallback | Multi-request extraction; article number discovery required |
| Silverchair/OUP family | Article PDF anchor or data attribute | Validate host/platform mapping; do not route OUP through its book-store translator |
| JSTOR | Stable ID and conditional PDF attachment path | Later adapter with article/book distinction and interstitial handling |
| Embedded Metadata | `citation_pdf_url` | Generic fallback with work identity and URL checks |

Start with T&F, Wiley, ScienceDirect, Springer Link and SAGE; then Cambridge, Silverchair/OUP, IEEE, ACM and JSTOR. Expand from the full inventory, reporting unsupported entries rather than suggesting universal coverage.

Authentication registry seeds: publisher docs first, UK Federation records second, community WAYFless collection as leads. Store host aliases, exact parameter spelling, target kind (relative/absolute), encoding behavior, source date and verification level. A shared Atypon implementation still needs per-host validation.

[Wiley](https://onlinelibrary.wiley.com/library-info/resources/technical-information), [Elsevier](https://www.elsevier.support/elsevieraccess/answer/how-can-i-build-a-wayfless-url-to-elsevier-products), and [SAGE's federation record](https://www.ukfederation.org.uk/content/Services/2008-08-12-sage) document useful recipes. [Springer's current documentation](https://support.springernature.com/en/support/solutions/articles/6000079269-construct-a-wayfless-url-in-shibboleth) directs users to its librarian portal: revalidate the exact template instead of treating the older chat formula as verified. WUGEN bulk extraction is a research opportunity, not a dependency for the first release.

Several inspected translator files explicitly carry AGPL notices. This repository's package license is MIT and `scripts/audit-licenses.sh` enforces a permissive dependency policy. Keep upstream checkouts as research inputs, record notices per file, and independently implement documented/observed protocol behavior with our own fixtures. Do not copy translator bodies or translate them line-by-line and label the result MIT. If a feature actually requires upstream code reuse, resolve its licensing before including it; attribution alone is not a substitute.

## Browser and CLI reality

WASM can call browser Fetch from Rust, but does not remove [CORS and credential restrictions](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CORS). Metadata and deterministic URL discovery can work directly in the test page. Publisher HTML inspection and authenticated PDF-byte retrieval may not.

Support two explicit testing modes:

- Direct WASM: metadata APIs, pure rules, supplied documents, and user-initiated publisher navigation. Report missing browser capabilities honestly.
- Optional local Rust service: uses the same crate's native resolution for publisher HTTP inspection. Expose a narrow resolver API with origin/request controls, not an unrestricted URL proxy. Its native session is distinct from the browser's authenticated publisher session.

The optional service does not solve browser SAML cookie transfer. Neither does a CLI automatically inherit browser login. In v1 the CLI resolves URLs, downloads directly accessible PDFs, or opens/prints the institutional route and reports that browser interaction is required. Browser-context capture or a desktop/extension bridge can be added later through the document/transport boundary.

React shows institution search with logo/name, DOI input, Resolve, candidate links, and expandable diagnostics. Include provider status, discovery source, candidate kind, and verification status. It contains no SeamlessAccess JS SDK, provider-specific fetch calls, DOI normalization or URL templates. Test the actual WASM engine, not only a native backend.

## Sequence and acceptance checkpoints

1. **Evidence and audit.** Save a reproducible full inventory and publisher/auth source matrix with pinned upstream revisions. Read all relevant paths; identify code-reuse constraints and browser-only branches. Record supported, deferred and unsupported outcomes.
2. **Portable crate skeleton.** Public models, DOI and URL handling, transport/cache interfaces, native/WASM compile checks, fixture runner and thin bindings. Verify it packages without sibling path dependencies. No existing application integration.
3. **First complete T&F slice.** Rust SeamlessAccess + Crossref/OpenAlex clients, institution filtering/cache, T&F candidate and SAML construction, React harness and CLI resolve command. The reference DOI plus LSE/Tübingen generates consistent native/WASM results. Check the actual browser UI, including hidden IdP exclusion and logo fallback.
4. **Main publisher coverage.** Add Wiley, ScienceDirect, Springer Link, SAGE and generic metadata extraction. Introduce optional native test service if observed browser restrictions require it. Keep each failure attributable to discovery, authentication, verification or environment.
5. **Download and broader coverage.** Streaming/validation, CLI save/open, the next publisher group, cache expiry and complete diagnostics. For inaccessible bytes return actionable routes, not fake successful downloads.
6. **Evidence-based evaluation.** Use a seeded sample of approximately 20 DOI records per initial platform, stratified by older/newer dates and OA/subscription status, plus known malformed/unsupported cases. Compare native and browser behavior. Count metadata resolution, correct platform, candidate discovery, actual PDF retrieval and authenticated browser success separately. Treat untested institution/publisher combinations as untested.

Tests must include supplied HTML/JSON fixtures; partial dates; escaped DOI/URL values; malicious relative targets; changed publisher hosts; supplements; hidden IdPs; both boolean/string visibility fields; expired caches; old search responses; provider 404/429/5xx; cancellation; redirects; oversized bodies; HTML behind PDF paths; and unavailable browser inspection. Use the same deterministic fixtures across native and WASM. Live network checks are opt-in, dated evidence rather than brittle unit tests.

Before calling the first release complete: run crate tests, WASM build/browser tests, React type/build checks, focused dependency/license checks, and visually inspect the working UI. Authenticated PDF tests require an available user session and must record what was actually observed; the earlier chat's successful test is historical evidence only.

## Deferred scope and discussion points

Keep full entitlement harvesting, global proxy discovery, federation ingestion, shared institutional catalogues, PDF reader integration and bulk crawling out of v1. Preserve ISSNs, dates, provenance, and provider-specific identifiers so these can be added later.

Recommended interpretation of “all functionality in Rust”: all application decisions and parsing in Rust, with browser/OS APIs as execution boundaries. Portable logic does not imply identical network privileges. The core product promise should be “find and explain the best PDF/access route, and download when this environment can,” with verification reported explicitly.

The main product decision for discussion is whether the eventual web experience only needs to open PDFs at publishers, or must import authenticated PDF bytes into the app. The first fits a standalone WASM page; the second needs a browser/desktop integration strategy for publishers that prohibit cross-origin reads. The proposed crate supports either direction without placing publisher logic in React.
