# Zotero sync

Key imports a Zotero library once by default. In Settings → Libraries → Zotero, **Keep in
sync with Zotero** turns on a Zotero → Key sync for the "Zotero" library.

## How it reads Zotero

Key reads a private copy of `zotero.sqlite` (and its rollback journal, when present), the
same way the one-time import does. It never opens the original for writing.

While sync is on, the app asks the Zotero library's host every 30 seconds whether
`zotero.sqlite` changed (modified time and size). Only if it changed, and has been still for
4 seconds, is the library copied and compared. A full pass over a library of 4,400 items and
3,400 notes takes about half a second when nothing changed; the first import about 5 seconds.

### Options considered

| Option | Direction | Needs | Why not (or why) |
| --- | --- | --- | --- |
| **Reading `zotero.sqlite`** (chosen) | Zotero → Key | Nothing | Works whether Zotero is running or not, offline, with no setup; sees exactly what Zotero stores locally, including file paths and annotations; one code path with the import. |
| Zotero 7 local API (`localhost:23119/api/`) | Zotero → Key | Zotero running, “Allow other applications to communicate with Zotero” enabled | Read-only like the database, but only while Zotero runs and only after the user enables it; no deletion log, so deletions still need a full comparison. |
| Zotero web API | Both ways | Zotero account, API key, network, Zotero sync on | The only route to writing back, but sees only what has been synced to zotero.org, not local file paths; writing to a user's cloud library from another app risks their data and needs version-conflict handling on both sides. |
| Companion Zotero plugin | Both ways, live | Installing and maintaining a plugin across Zotero versions; a listener in Key | Live and could write back, but adds an install step and a moving target; not needed for Zotero → Key. |

Reading the database is the most robust choice for Zotero → Key. Two-way sync is left for
later: it would go through the web API (with `If-Unmodified-Since-Version`) or a plugin.

## How changes are merged

`zotero-sync.sqlite`, beside the library's own database, keeps for every Zotero item, note
and collection the Key id it became and the values Zotero and Key had after the last run.
Each run compares Zotero now, Key now and that base:

- **Fields, creators, properties, collection names and places**: changed only in Zotero →
  applied; changed only in Key → kept; changed in both → Key's value is kept and the
  conflict is listed in Settings.
- **Tags and collection membership** are merged as sets: Zotero's additions and removals are
  applied, Key's own additions stay.
- **Notes** (HTML converted to Markdown): unedited in Key → updated; edited in both → Key's
  note stays and Zotero's version is saved beside it as “… (Zotero version)”.
- **Deleted in Zotero** (or in Zotero's trash): items go to Key's trash (and come back if
  restored in Zotero); notes are deleted only if unedited in Key; collections only once
  empty.
- **Deleted in Key**: never brought back.
- **Moved** items and notes follow Zotero (collection membership, note parent).

Sources imported before bases were kept are recognised: the first importer wrote them all
with one timestamp, so a source with a later change was edited in Key and keeps its values.
Notes it wrote as plain text are converted to Markdown when they are unchanged.
