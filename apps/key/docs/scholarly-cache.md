# Scholarly persistence and scheduling

Implemented for the Electron managed-library backend. Each workspace owns its scholarly cache in `.key/library.sqlite3` (schema 14). Existing workspaces receive the normal pre-migration backup.

## Identity and storage

PDF extraction remains keyed by file content hash plus processing version. Scholarly identity is separate: normalized DOI, landing URL or whitespace-normalized title query. DOI aliases let a successful title lookup serve a later DOI lookup across documents in the same workspace. Merged metadata retains its provider/source provenance.

`scholarly_cache` stores key, JSON payload, error, fetched timestamp, expiry, retry deadline, attempts and update timestamp. Successful results live for 30 days. A clicked stale result is displayed immediately and refreshed in the background; refresh failure preserves the last good payload. Failed lookups have persisted exponential backoff (2 minutes up to 6 hours); recognized not-found results use 12 hours. A longer reported Semantic Scholar retry deadline takes precedence. An interrupted request has an expiring 45-second lease rather than an immortal loading state.

Existing enriched document metadata seeds the shared cache without a network request. Reopened analysis is hydrated from cached results before it is published. Each completed reference is committed to `document_relations` independently; the compact analysis artifact is also saved at batch completion. Failure of that final batch publication does not erase the individual lookup results.

## Scheduling

- Three background reference coordinators per active document batch, using the shared four-worker reference executor. No thread per citation.
- One background enrichment batch at a time, through the existing interaction/memory-aware scheduler with aging. Opening a document boosts its enrichment queue position.
- User-triggered lookups use Urgent priority ahead of background title and DOI work in both the executor and Semantic Scholar gate. An identical in-flight lookup is joined, not duplicated or restarted.
- An indexed, bounded retry scan reads at most 16 due failed/interrupted entries every 30 seconds and submits them to the same background scheduler. SQLite deadlines survive host restart. It does not rescan all PDFs or poll providers for fresh successful entries.
- Single-flight coordination is per workspace/key within a host; only weak coordination handles remain after completion. SQLite is the payload store, not an unbounded RAM map.

A retry refresh updates the scholarly cache; already displayed stale metadata is picked up on a subsequent lookup/reopen. This does not introduce cross-workspace cache sharing or a new scholarly-access/download resolver.

## Validation

42 library tests, 38 reference tests, and 11 desktop-host tests cover schema migration, restart persistence, ordinal reference updates, normalized identities, concurrent single-flight requests, stale-on-error behavior, expiring leases, provider cooldowns and urgent queue ordering. The offline `smoke-scholarly-cache.py` also starts the actual host twice, verifies success/negative cache reuse through IPC, and checks that fetched timestamps and failure attempts remain unchanged. No live provider requests are needed for these checks.
