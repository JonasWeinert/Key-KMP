"""Deterministic synthetic PDF stress fixtures; never substitutes for real papers.
Usage: bundled-python create-qualification-fixtures.py OUTPUT_DIRECTORY [PAGES]
"""
from pathlib import Path
import hashlib, json, sys, random
from reportlab.pdfgen import canvas
from reportlab.lib.utils import ImageReader
from pypdf import PdfReader, PdfWriter
from PIL import Image, ImageDraw
root=Path(sys.argv[1]); root.mkdir(parents=True,exist_ok=True)
count=int(sys.argv[2]) if len(sys.argv)>2 else 1000
long=root/'long-book.pdf'
c=canvas.Canvas(str(long),pagesize=(612,792),invariant=1)
for page in range(count):
 c.setFont('Helvetica-Bold',16); c.drawString(48,742,f'Chapter {page+1}: document processing')
 c.setFont('Helvetica',11)
 for line in range(32):
  c.drawString(48,706-line*18,'Canonical evidence remains anchored to its original PDF page.')
 c.drawString(48,60,f'Unique checkpoint token chapter{page+1:04d}.')
 c.setFont('Helvetica',9);c.drawRightString(564,32,str(page+1));c.showPage()
c.save()
reader=PdfReader(long); writer=PdfWriter()
for n in range(4):
 p=reader.pages[n];p.rotate(n*90)
 p.cropbox.lower_left=(24,24);p.cropbox.upper_right=(588,768)
 writer.add_page(p)
with open(root/'rotated-cropped.pdf','wb') as f:writer.write(f)
rng=random.Random(1729)
c=canvas.Canvas(str(root/'image-only.pdf'),pagesize=(612,792),invariant=1)
for n in range(8):
 image=Image.frombytes('RGB',(1200,1600),rng.randbytes(1200*1600*3))
 draw=ImageDraw.Draw(image);draw.rectangle((50,50,1150,250),fill='white');draw.text((80,100),f'Raster page {n+1}: no extractable PDF text',fill='black')
 c.drawImage(ImageReader(image),0,0,612,792);c.showPage()
c.save()
manifest=[]
for p in sorted(root.glob('*.pdf')):
 r=PdfReader(p)
 manifest.append(dict(file=p.name,sha256=hashlib.sha256(p.read_bytes()).hexdigest(),pages=len(r.pages),bytes=p.stat().st_size))
assert len(PdfReader(long).pages)==count
assert all(not p.extract_text().strip() for p in PdfReader(root/'image-only.pdf').pages)
(root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps(manifest))
