"""Real framed IPC, canonical persistence, native PDF text and binary pixels."""
import hashlib,json,pathlib,struct,subprocess,sys,tempfile,os,time
root=pathlib.Path(__file__).resolve().parents[3]
binary=pathlib.Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix='key-host-smoke-') as directory:
 workspace=pathlib.Path(directory)
 process=subprocess.Popen([str(binary),'--library',str(workspace/'.key')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=open(workspace/'host.log','wb'))
 sequence=0
 def exact(n):
  out=b''
  while len(out)<n:
   part=process.stdout.read(n-len(out))
   if not part: raise RuntimeError('host stopped: '+(workspace/'host.log').read_text())
   out+=part
  return out
 def call(command,args={},data=b''):
  global sequence
  sequence+=1; request={'id':sequence,'command':command,'args':args,'binaryLength':len(data)}
  header=json.dumps(request).encode();process.stdin.write(struct.pack('<I',len(header))+header+data);process.stdin.flush()
  reply=json.loads(exact(struct.unpack('<I',exact(4))[0]));payload=exact(reply['binaryLength'])
  assert reply['id']==sequence,reply
  assert reply['ok'],reply
  return payload if payload else reply.get('result')
 try:
  assert call('host_info')['protocol']==1
  assert call('host_can_suspend') is True
  upload=call('library_import_begin',{'title':'temporary.pdf','length':10})
  assert call('host_can_suspend') is False
  call('library_import_cancel',{'id':upload})
  assert call('host_can_suspend') is True
  call('workspace_initialize',{'name':'Host smoke','workspaceRoot':directory})
  project=call('workspace_create_project',{'name':'Research'})
  note=call('workspace_save_record',{'kind':'note','title':'Direct lookup','body':'Kept outside pagination','properties':{}})
  assert call('workspace_record',{'id':note['id']})['body']=='Kept outside pagination'
  assert call('workspace_record',{'id':'missing-record'}) is None
  pdf=root/'tests/fixtures/interaction.pdf';pdf_bytes=pdf.read_bytes();hash_=hashlib.sha256(pdf_bytes).hexdigest()
  source=call('library_import_file',{'path':str(pdf)})
  assert call('library_source_range',{'hash':hash_,'offset':0,'length':128})==pdf_bytes[:128]
  call('library_update_metadata',{'hash':hash_,'title':'Smoke paper','year':2026,'authors':['Ada Lovelace']})
  call('workspace_set_project_membership',{'projectId':project['id'],'recordId':'source:'+hash_,'present':True})
  assert len(call('workspace_records',{'projectId':project['id']}))==1
  other=call('workspace_create_project',{'name':'Other research'})
  assert len(call('semantic_library',{'projectId':project['id']}))==1
  assert call('semantic_library',{'projectId':other['id']})==[]
  document=call('native_open_buffer',{'id':hash_},pdf_bytes)
  assert len(document['pages'])>0
  page=call('native_text',{'id':hash_,'page':0});assert page['text']
  pixels=call('native_render',{'requestId':42,'id':hash_,'page':0,'width':200,'height':200,'x':0,'y':0,'rectWidth':200,'rectHeight':200})
  assert len(pixels)==200*200*4,len(pixels)
  call('native_close',{'id':hash_})
  if os.environ.get('KEY_SMOKE_INDEX') == '1':
   call('begin_pdfjs_companion_managed',{'hash':hash_})
   deadline=time.monotonic()+180
   while True:
    status=call('semantic_library')[0]
    if status['status']=='indexed': break
    assert status['status']!='failed',status
    assert time.monotonic()<deadline,status
    time.sleep(.25)
   assert call('global_search',{'query':'Select this sentence','limit':5})
   call('release_disposable_document',{'id':hash_})
  call('library_set_removed',{'hash':hash_,'removed':True})
  assert len(call('library_removed_documents',{'projectId':project['id']}))==1
  assert call('library_removed_documents',{'projectId':other['id']})==[]
  call('library_set_removed',{'hash':hash_,'removed':False})
  print(json.dumps({'ok':True,'semanticIndexVerified':os.environ.get('KEY_SMOKE_INDEX')=='1','pages':len(document['pages']),'pixelBytes':len(pixels),'source':source,'workspace':call('workspace_info')}))
 finally:
  process.stdin.close();process.wait(timeout=10)
