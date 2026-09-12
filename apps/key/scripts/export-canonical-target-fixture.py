#!/usr/bin/env python3
"""Export real canonical anchors for test-library-search-ux.mjs's rotated fixture mode.
Usage: python3 export-canonical-target-fixture.py LIBRARY_DIRECTORY TARGETS.json
The indexed fixture must have a 'Canonical evidence' sentence on every page.
"""
import json, pathlib, sqlite3, struct, sys, zlib
root, output = map(pathlib.Path, sys.argv[1:])
connection = sqlite3.connect(f'file:{root / "library.sqlite3"}?mode=ro', uri=True)
pages, hits = [], []
for key, payload in connection.execute("SELECT key,payload FROM artifacts WHERE kind='semantic-structure' AND version='v5' ORDER BY CAST(substr(key,instr(key,':')+1) AS INTEGER)"):
    if payload.startswith(b'KEYART01'):
        assert payload[8] == 0, 'Structure fixture expects the JSON codec'
        payload = payload[49:]
    page = json.loads(zlib.decompress(payload))['structure']
    pages.append(dict(index=page['page'], width=page['width'], height=page['height']))
    for identifier, text, start, end, rects in connection.execute('SELECT c.id,b.text,c.target_start,c.target_end,c.rects FROM chunks c JOIN text_blocks b USING(document_hash,block_key) WHERE c.page=?', (page['page'],)):
        target = text.encode()[start:end].decode()
        if 'Canonical evidence' in target:
            hits.append(dict(id=identifier, page=page['page'], targetText=target, rects=list(struct.iter_unpack('<4H', rects))))
            break
    else:
        raise AssertionError(f'Page {page["page"]} lost its canonical target')
assert len(pages) == len(hits) == 4
output.write_text(json.dumps(dict(pages=pages, hits=hits), indent=2))
