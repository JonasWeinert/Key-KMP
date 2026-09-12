#!/usr/bin/env python3
"""Populate a fresh v6 test DB, upgrade through Rust, then inspect integrity/size.
Synthetic storage test only: no claim about realistic PDF extraction or search.
"""
import hashlib,json,os,pathlib,sqlite3,subprocess,tempfile,zlib
repo=pathlib.Path(__file__).resolve().parents[3]
with tempfile.TemporaryDirectory(prefix='key-scale-') as directory:
    root=pathlib.Path(directory)
    db=sqlite3.connect(root/'library.sqlite3')
    migrations=repo/'crates/key-library/src/migrations'
    for path in sorted(migrations.glob('00[1-6]*.sql')):db.executescript(path.read_text())
    text='Synthetic storage validation passage. Unicode café.'
    for d in range(100):
        digest=hashlib.sha256(f'scale-{d}'.encode()).hexdigest()
        db.execute('INSERT INTO documents(hash,title,page_count,year,updated_at) VALUES(?,?,?,?,0)',(digest,f'Synthetic {d}',100,2015+d%10))
        db.execute('INSERT INTO text_blocks VALUES(?,?,?)',(digest,'body',text))
        db.executemany('INSERT INTO chunks VALUES(?,?,?,?,?,?,?,?,?)',((f'scale-{d}-{p}',digest,'body',p%100,0,len(text.encode()),0,9,b'\x00\x00\x00\x00\x01\x00\x01\x00') for p in range(1000)))
        db.executemany('INSERT INTO artifacts VALUES(?,?,?,?,?)',((digest,'fixture-vector','producer-'+('a'*64),str(p),zlib.compress(json.dumps([p/1000]*16).encode())) for p in range(1000)))
    db.commit()
    before=db.execute('SELECT sum(pgsize) FROM dbstat').fetchone()[0];db.close()
    command=[os.environ['KEY_SCALE_BINARY'],directory] if os.environ.get('KEY_SCALE_BINARY') else ['cargo','run','-q','-p','key-library','--example','scale','--',directory]
    process=subprocess.run(command,cwd=repo,check=True,capture_output=True,text=True)
    report=json.loads(process.stdout)
    db=sqlite3.connect(root/'library.sqlite3')
    assert db.execute('PRAGMA integrity_check').fetchone()==('ok',)
    assert not db.execute('PRAGMA foreign_key_check').fetchall()
    assert db.execute('SELECT count(*) FROM passage_data').fetchone()==(100000,)
    assert db.execute('SELECT count(*) FROM artifact_data').fetchone()==(100000,)
    assert db.execute('SELECT count(*) FROM content_keys WHERE length(digest)=32').fetchone()==(100,)
    after=db.execute('SELECT sum(pgsize) FROM dbstat').fetchone()[0]
    report.update(schemaVersion=db.execute('PRAGMA user_version').fetchone()[0],liveDatabaseBytesBefore=before,liveDatabaseBytesAfter=after,livePageReductionPercent=100*(before-after)/before,integrity='ok')
    db.close()
    print(json.dumps(report,indent=2))
