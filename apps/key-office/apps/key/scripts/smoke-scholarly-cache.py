"""Offline IPC regression: persisted scholarly data must survive host restart."""
import argparse
import json
import os
import select
import sqlite3
import struct
import subprocess
import tempfile
import time
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--host', required=True)
args = parser.parse_args()
root = Path(tempfile.mkdtemp(prefix='key-scholarly-cache-'))


def start():
    return subprocess.Popen([args.host, '--library', str(root)], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)


def invoke(host, command, values):
    message = json.dumps({'id': 1, 'command': command, 'args': values}).encode()
    host.stdin.write(struct.pack('<I', len(message)) + message)
    host.stdin.flush()
    assert select.select([host.stdout], [], [], 10)[0], 'IPC response timed out'
    length = struct.unpack('<I', host.stdout.read(4))[0]
    return json.loads(host.stdout.read(length))


def stop(host):
    host.stdin.close()
    host.wait(timeout=10)

host = start()
# Unknown command still waits for Host construction/schema initialization.
invoke(host, 'scholarly_cache_smoke_initialize', {})
stop(host)
now = int(time.time() * 1000)
payload = {'source': 'Crossref', 'sources': ['Crossref'], 'title': 'Persisted fixture',
           'authors': ['Test Author'], 'doi': '10.1000/cached'}
with sqlite3.connect(root / 'library.sqlite3') as db:
    assert db.execute('pragma user_version').fetchone()[0] == 14
    db.execute('insert into scholarly_cache values(?,?,?,?,?,?,?,?)',
               ('doi:10.1000/cached', json.dumps(payload), None, now, 0, now + 86400000, 0, now))
    db.execute('insert into scholarly_cache values(?,?,?,?,?,?,?,?)',
               ('doi:10.1000/offline', None, 'Saved provider cooldown', now, now + 86400000, 0, 2, now))
latencies = []
for _ in range(2):
    host = start()
    try:
        for resource in ['10.1000/cached', 'https://doi.org/10.1000/CACHED']:
            began = time.monotonic()
            result = invoke(host, 'scholarly_lookup_resource', {'resource': resource})
            latencies.append(round((time.monotonic() - began) * 1000, 2))
            assert result['ok'] and result['result']['title'] == payload['title'], result
        failed = invoke(host, 'scholarly_lookup_resource', {'resource': '10.1000/offline'})
        assert not failed['ok'] and 'Saved provider cooldown' in failed['error'], failed
    finally:
        stop(host)
with sqlite3.connect(root / 'library.sqlite3') as db:
    assert db.execute('select fetched_at from scholarly_cache where key=?', ('doi:10.1000/cached',)).fetchone()[0] == now
    assert db.execute('select attempts from scholarly_cache where key=?', ('doi:10.1000/offline',)).fetchone()[0] == 2
assert max(latencies) < 2000, latencies
print(json.dumps({'ok': True, 'root': str(root), 'restartReuse': True, 'doiAliases': True,
                  'negativeCache': True, 'unchangedFetchTimestamp': True, 'latencyMs': latencies}))
