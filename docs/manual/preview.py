"""Renders the manual's pages to PNG so the layout can actually be looked at.

A PDF that builds without error can still have text sitting off the page or a
screenshot overlapping a paragraph. Rendering is the only way to know.
"""

import sys
from pathlib import Path

import fitz  # PyMuPDF

HERE = Path(__file__).resolve().parent
pdf = HERE / "Raut-Field-Sales-Handbook.pdf"
out = HERE / "preview"
out.mkdir(exist_ok=True)

doc = fitz.open(pdf)
print(f"{doc.page_count} pages")
for i, page in enumerate(doc, start=1):
    pix = page.get_pixmap(dpi=110)
    pix.save(out / f"page-{i:02d}.png")
    print(f"  page-{i:02d}.png  {pix.width}x{pix.height}")
