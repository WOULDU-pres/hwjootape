#!/usr/bin/env python3
"""element-ops.py — crop slide image elements and gate regeneration fidelity.

Subcommands (Pillow, runs in the pptx venv):

  crop <draft.png> <out.png> --bbox x,y,w,h [--mask mask.png]
      Crop the bbox from the draft. If a mask is given, apply it as alpha so the
      element is a clean transparent cutout. Pixel coords.

  compare <a.png> <b.png>
      Print a 0..1 dissimilarity score (mean abs RGB diff at 64x64). Used as the
      img2img fidelity gate: if a regenerated element drifts too far from the
      approved-draft cutout, the caller falls back to the raw cutout (protects the
      "원본 충실" requirement when god-tibo img2img has no strength/mask control).

  keyout <in.png> <out.png> [--tol N]
      Make the flat surrounding background transparent: flood-fill the near-white
      region connected to the image border to alpha 0, preserving the centered
      subject (and any white *inside* it, which the flood can't reach). Lets a
      regenerated element — which god-tibo returns opaque on a white background —
      composite cleanly over the slide's background plate instead of as a white box.
"""
import sys

from PIL import Image, ImageDraw


def die(msg: str):
    sys.stderr.write(f"element-ops: {msg}\n")
    sys.exit(2)


def parse_bbox(s: str):
    parts = [int(round(float(v))) for v in s.split(",")]
    if len(parts) != 4:
        die("--bbox must be x,y,w,h")
    return parts


def cmd_crop(args):
    draft = args[0]
    out = args[1]
    bbox = None
    mask_path = None
    i = 2
    while i < len(args):
        if args[i] == "--bbox":
            bbox = parse_bbox(args[i + 1]); i += 2
        elif args[i] == "--mask":
            mask_path = args[i + 1]; i += 2
        else:
            i += 1
    if bbox is None:
        die("crop requires --bbox")
    x, y, w, h = bbox
    img = Image.open(draft).convert("RGBA")
    W, H = img.size
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(W, x + w), min(H, y + h)
    if x1 <= x0 or y1 <= y0:
        die("empty crop region")
    crop = img.crop((x0, y0, x1, y1))
    if mask_path:
        mask = Image.open(mask_path).convert("L")
        mw, mh = mask.size
        # Mask may be full-frame (draft-sized) or bbox-local (segment-sized).
        # Full-frame: crop the same region. Otherwise: stretch straight to the crop.
        if abs(mw - W) <= 2 and abs(mh - H) <= 2:
            mcrop = mask.crop((x0, y0, x1, y1)).resize(crop.size)
        else:
            mcrop = mask.resize(crop.size)
        crop.putalpha(mcrop)
    crop.save(out)
    sys.stderr.write(f"element-ops: cropped {crop.size} -> {out}\n")


def cmd_compare(args):
    a = Image.open(args[0]).convert("RGB").resize((64, 64))
    b = Image.open(args[1]).convert("RGB").resize((64, 64))
    pa, pb = a.load(), b.load()
    total = 0
    for yy in range(64):
        for xx in range(64):
            ra, ga, ba = pa[xx, yy]
            rb, gb, bb = pb[xx, yy]
            total += abs(ra - rb) + abs(ga - gb) + abs(ba - bb)
    score = total / (64 * 64 * 3 * 255)
    print(f"{score:.4f}")


def cmd_keyout(args):
    inp = args[0]
    out = args[1]
    tol = 32
    i = 2
    while i < len(args):
        if args[i] == "--tol":
            tol = int(args[i + 1]); i += 2
        else:
            i += 1

    # floodfill works in RGB; we fill the near-white border region with a sentinel
    # colour, then map that sentinel to fully transparent.
    rgb = Image.open(inp).convert("RGB")
    W, H = rgb.size
    SENTINEL = (1, 2, 3)
    px = rgb.load()

    def near_white(xy):
        r, g, b = px[xy]
        return r >= 255 - tol and g >= 255 - tol and b >= 255 - tol

    # Seed from border points (corners + edge midpoints) that are themselves bg, so
    # we never start the flood inside the subject. Edge midpoints catch a background
    # split by a subject that touches one side.
    seeds = [
        (0, 0), (W - 1, 0), (0, H - 1), (W - 1, H - 1),
        (W // 2, 0), (W // 2, H - 1), (0, H // 2), (W - 1, H // 2),
    ]
    filled = False
    for s in seeds:
        if 0 <= s[0] < W and 0 <= s[1] < H and px[s] != SENTINEL and near_white(s):
            ImageDraw.floodfill(rgb, s, SENTINEL, thresh=tol)
            filled = True

    rgba = rgb.convert("RGBA")
    if filled:
        rp = rgba.load()
        for yy in range(H):
            for xx in range(W):
                if rp[xx, yy][:3] == SENTINEL:
                    rp[xx, yy] = (0, 0, 0, 0)
    rgba.save(out)
    sys.stderr.write(f"element-ops: keyout {rgba.size} -> {out} (filled={filled})\n")


def main():
    if len(sys.argv) < 2:
        die("usage: element-ops.py <crop|compare|keyout> ...")
    cmd = sys.argv[1]
    if cmd == "crop":
        cmd_crop(sys.argv[2:])
    elif cmd == "compare":
        cmd_compare(sys.argv[2:])
    elif cmd == "keyout":
        cmd_keyout(sys.argv[2:])
    else:
        die(f"unknown subcommand: {cmd}")


if __name__ == "__main__":
    main()
