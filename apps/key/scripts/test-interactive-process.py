#!/usr/bin/env python3
"""Exercise actual PDFium helper IPC, including binary pixels and cancellation."""
import json,pathlib,struct,subprocess,sys
repo=pathlib.Path(__file__).resolve().parents[3]
binary=pathlib.Path(sys.argv[1]) if len(sys.argv)>1 else repo/'apps/key/src-tauri/target/debug/key'
child=subprocess.Popen([str(binary),'--key-interactive-pdf-helper'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
def send(value):
    data=json.dumps(value).encode();child.stdin.write(struct.pack('<I',len(data))+data);child.stdin.flush()
def read():
    header=child.stdout.read(4)
    assert len(header)==4,'helper ended before response'
    size=struct.unpack('<I',header)[0];data=child.stdout.read(size)
    assert len(data)==size
    return data[1:] if data[0]==1 else json.loads(data[1:])
def request(name,**fields):send({'Request':{name:fields}});return read()
try:
    result=request('OpenFile',id='test',path=str(repo/'tests/fixtures/PUBMED_16226083.pdf'))
    assert len(result['Ok']['Document']['pages'])==7,result
    text=request('Text',id='test',page=0)['Ok']['Text']
    assert len(text['text'])>100 and text['characters'],text
    pixels=request('Render',request_id=1,id='test',page=0,width=256,height=256,x=0,y=0,rect_width=256,rect_height=256)
    assert isinstance(pixels,bytes) and len(pixels)==256*256*4
    assert len(set(pixels[::4]))>8, 'Rendered page is blank or invalid'
    send({'Cancel':2})
    cancelled=request('Render',request_id=2,id='test',page=0,width=256,height=256,x=0,y=0,rect_width=256,rect_height=256)
    assert 'Err' in cancelled and 'cancel' in cancelled['Err'].lower(),cancelled
    assert request('Close',id='test')=={'Ok':'Closed'}
    print(json.dumps({'helperPid':child.pid,'pages':7,'textCharacters':len(text['characters']),'pixelBytes':len(pixels),'preCancelledRender':'rejected','close':'ok'}))
finally:
    child.stdin.close()
    try:child.wait(timeout=5)
    except subprocess.TimeoutExpired:child.kill();child.wait()
