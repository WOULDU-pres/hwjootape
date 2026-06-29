#!/usr/bin/env python3
"""clean-bg.py — remove baked-in placeholder text from a god-tibo draft.

In approach A the draft is a flat slide with text already rendered into the
pixels. Before we overlay editable text boxes, those baked glyphs must be wiped
or they show through underneath. This fills each text region (from OCR bboxes)
with the color sampled from a ring just outside the box — a cheap, dependency-free
inpaint that works well on the flat/gradient backgrounds slides typically use.

Usage: clean-bg.py <draft.png> <boxes.json> <output.png> [--pad 6]
  boxes.json: [ { "x":px, "y":px, "width":px, "height":px }, ... ]  (pixel coords)
"""
import json
import sys

from PIL import Image, ImageDraw, ImageFilter


def die(msg: str):
    sys.stderr.write(f"clean-bg: {msg}\n")
    sys.exit(2)


def ring_median(img: Image.Image, box, pad: int):
    """Median color of a ring just outside the box (clamped to image)."""
    W, H = img.size
    x, y, w, h = box["x"], box["y"], box["width"], box["height"]
    x0, y0 = max(0, x - pad), max(0, y - pad)
    x1, y1 = min(W, x + w + pad), min(H, y + h + pad)
    px = img.load()
    rs, gs, bs = [], [], []
    for xx in range(x0, x1):
        for yy in (y0, max(y0, y1 - 1)):
            r, g, b = px[xx, yy][:3]
            rs.append(r); gs.append(g); bs.append(b)
    for yy in range(y0, y1):
        for xx in (x0, max(x0, x1 - 1)):
            r, g, b = px[xx, yy][:3]
            rs.append(r); gs.append(g); bs.append(b)
    if not rs:
        return (255, 255, 255)
    rs.sort(); gs.sort(); bs.sort()
    mid = len(rs) // 2
    return (rs[mid], gs[mid], bs[mid])


def main():
    if len(sys.argv) < 4:
        die("usage: clean-bg.py <draft.png> <boxes.json> <output.png> [--pad N]")
    draft_path, boxes_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
    pad = 6
    args = sys.argv[4:]
    for i, a in enumerate(args):
        if a == "--pad" and i + 1 < len(args):
            pad = int(args[i + 1])

    with open(boxes_path, encoding="utf-8") as fh:
        boxes = json.load(fh)
    if isinstance(boxes, dict) and "lines" in boxes:
        boxes = [ln["bbox"] for ln in boxes["lines"]]

    img = Image.open(draft_path).convert("RGB")
    W, H = img.size
    draw = ImageDraw.Draw(img)
    # Slightly grow each box to fully cover anti-aliased glyph edges.
    for box in boxes:
        grow = max(2, pad // 2)
        x0 = max(0, int(box["x"]) - grow)
        y0 = max(0, int(box["y"]) - grow)
        x1 = min(W, int(box["x"]) + int(box["width"]) + grow)
        y1 = min(H, int(box["y"]) + int(box["height"]) + grow)
        if x1 <= x0 or y1 <= y0:
            continue
        fill = ring_median(img, box, pad)
        # C-level rectangle fill (the per-pixel putpixel loop was O(area) in Python).
        draw.rectangle([x0, y0, x1 - 1, y1 - 1], fill=fill)

    # Light blur over the patched regions blends the fills into gradients.
    if boxes:
        blurred = img.filter(ImageFilter.GaussianBlur(radius=2))
        for box in boxes:
            grow = max(2, pad // 2)
            x0 = max(0, box["x"] - grow)
            y0 = max(0, box["y"] - grow)
            x1 = min(W, box["x"] + box["width"] + grow)
            y1 = min(H, box["y"] + box["height"] + grow)
            if x1 <= x0 or y1 <= y0:
                continue
            region = blurred.crop((x0, y0, x1, y1))
            img.paste(region, (x0, y0))

    img.save(out_path)
    sys.stderr.write(f"clean-bg: wiped {len(boxes)} text region(s) -> {out_path}\n")


if __name__ == "__main__":
    main()
