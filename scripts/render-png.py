#!/usr/bin/env python3
"""render-png.py — flatten a resolved deck spec to PNG(s) as a faithful safety net.

Usage: render-png.py <spec.json> <output.png> [--width 1920] [--slide N]

Because python-pptx cannot embed fonts, a .pptx may render differently (or break
Hangul) on machines without the chosen Korean font. This renderer bakes each
slide to a flat PNG using a real on-device Korean TTF, so the user always has a
pixel-faithful copy. Same resolved spec format as build-pptx.py.

For a multi-slide deck, writes <output>.png, <output>-2.png, ... unless --slide
selects one. Coordinates are normalized [0,1]; this is the server-side flatten
that replaces the browser-only canvas path (resolves blocker B3).
"""
import json
import sys
import os

from PIL import Image, ImageDraw, ImageFont

# Prefer the bundled Pretendard (Korean+Latin, OFL) so rendering is identical on
# macOS, Linux/WSL, and Windows. System fonts remain as fallbacks if the bundled
# asset is ever absent.
_BUNDLED_FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fonts")
KOREAN_FONT_CANDIDATES = [
    (os.path.join(_BUNDLED_FONT_DIR, "Pretendard-Regular.otf"), 0),
    # macOS system fonts
    ("/System/Library/Fonts/AppleSDGothicNeo.ttc", 0),
    ("/System/Library/Fonts/Supplemental/AppleGothic.ttf", 0),
    ("/Library/Fonts/AppleSDGothicNeo.ttc", 0),
    # Linux system Korean fonts (apt: fonts-nanum / fonts-noto-cjk)
    ("/usr/share/fonts/truetype/nanum/NanumGothic.ttf", 0),
    ("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 0),
    ("/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc", 0),
    ("/System/Library/Fonts/Helvetica.ttc", 0),
]
SLIDE_H_PT = 540.0  # 7.5in * 72


def die(msg: str):
    sys.stderr.write(f"render-png: {msg}\n")
    sys.exit(2)


def load_font(px: int) -> ImageFont.FreeTypeFont:
    px = max(1, int(px))
    for path, idx in KOREAN_FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, px, index=idx)
            except Exception:
                continue
    return ImageFont.load_default()


def parse_color(c, default=(20, 20, 20)):
    if not c:
        return default
    s = str(c).lstrip("#")
    if len(s) == 6:
        try:
            return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
        except ValueError:
            return default
    return default


def fit_font(draw, text, start_px, max_w, max_h, min_px=10):
    """Shrink the font until wrapped text fits the box (width AND height).
    Returns (font, lines, line_height). Fixes Korean text overflowing an OCR
    bbox sized for the draft's placeholder (R5 bbox auto-fit)."""
    px = max(min_px, int(start_px))
    while px >= min_px:
        font = load_font(px)
        lines = wrap_text(draw, text, font, max_w)
        line_h = (font.getbbox("Ag")[3] - font.getbbox("Ag")[1]) * 1.25
        widest = max((draw.textlength(ln, font=font) for ln in lines), default=0)
        total_h = line_h * len(lines)
        if widest <= max_w and total_h <= max_h:
            return font, lines, line_h
        px = int(px * 0.92) if px > min_px else min_px - 1
    font = load_font(min_px)
    return font, wrap_text(draw, text, font, max_w), (font.getbbox("Ag")[3] - font.getbbox("Ag")[1]) * 1.25


# Bullet marker compose emits per logical line (see src/lib/slides/compose.ts):
# "• " (U+2022 + space). Wrapped continuation lines hang-indent under the text
# AFTER this marker, so a wrapped word never drops to the box's left edge.
BULLET_PREFIX = "• "


def _hanging_indent(draw, font):
    """A leading run of spaces whose pixel width matches the '• ' marker, so a
    wrapped bullet continuation aligns under the bullet BODY (not under the dot).
    The bullet glyph is wider than a space, so pad until the widths match."""
    target = draw.textlength(BULLET_PREFIX, font=font)
    if target <= 0:
        return "", 0.0
    space_w = draw.textlength(" ", font=font) or 1.0
    n = max(1, int(round(target / space_w)))
    indent = " " * n
    return indent, draw.textlength(indent, font=font)


def wrap_text(draw, text, font, max_w):
    """Word-wrap; fall back to char-wrap for long CJK runs without spaces.

    For bullet lines (starting with '• '), wrapped continuation lines are
    hang-indented so they align under the bullet body, not at x=0 of the box.
    The indent is realized as a leading run of spaces whose pixel width matches
    the '• ' marker, and that width is subtracted from the wrap budget so text
    still fits the box."""
    out_lines = []
    for raw in str(text).split("\n"):
        if not raw:
            out_lines.append("")
            continue
        # Hanging indent for wrapped continuations of a bullet line.
        if raw.startswith(BULLET_PREFIX):
            indent, indent_w = _hanging_indent(draw, font)
        else:
            indent, indent_w = "", 0.0

        words = raw.split(" ")
        cur = ""
        started_line = False  # True once the first visual line of this logical line is emitted

        def avail():
            # First visual line uses the full width; continuations lose the indent.
            return max_w - (indent_w if started_line else 0)

        def push(piece):
            nonlocal started_line
            out_lines.append((indent + piece) if started_line else piece)
            started_line = True

        for w in words:
            trial = w if not cur else cur + " " + w
            if draw.textlength(trial, font=font) <= avail() or not cur:
                # still too long even alone -> char-wrap this token
                if draw.textlength(trial, font=font) > avail() and not cur:
                    piece = ""
                    for ch in w:
                        t2 = piece + ch
                        if draw.textlength(t2, font=font) <= avail() or not piece:
                            piece = t2
                        else:
                            push(piece)
                            piece = ch
                    cur = piece
                else:
                    cur = trial
            else:
                push(cur)
                cur = w
        push(cur)
    return out_lines


def render_slide(s, canvas_w, canvas_h):
    # Solid theme fill first (absent => white, the historical default), so dark /
    # warm themes export with the right canvas color instead of always-white.
    fill = parse_color(s.get("backgroundColor"), (255, 255, 255))
    img = Image.new("RGB", (canvas_w, canvas_h), fill)
    bg = s.get("background")
    if bg and bg.get("path") and os.path.exists(bg["path"]):
        # A full-slide background PICTURE wins over the solid fill (paints on top).
        with Image.open(bg["path"]) as b:
            img.paste(b.convert("RGB").resize((canvas_w, canvas_h)), (0, 0))

    draw = ImageDraw.Draw(img)
    px_per_pt = canvas_h / SLIDE_H_PT

    # Theme accent band: a solid rectangle at its nbbox, painted above the fill but
    # behind every element. Skipped when absent.
    bar = s.get("accentBar")
    if bar and bar.get("nbbox"):
        nb = bar["nbbox"]
        bx0 = int(nb["x"] * canvas_w)
        by0 = int(nb["y"] * canvas_h)
        bx1 = bx0 + max(1, int(nb["w"] * canvas_w))
        by1 = by0 + max(1, int(nb["h"] * canvas_h))
        draw.rectangle([bx0, by0, bx1, by1], fill=parse_color(bar.get("color")))

    for el in sorted(s.get("elements", []), key=lambda e: e.get("z", 0)):
        nb = el["nbbox"]
        x = int(nb["x"] * canvas_w)
        y = int(nb["y"] * canvas_h)
        w = int(nb["w"] * canvas_w)
        h = int(nb["h"] * canvas_h)
        if el.get("type") == "image" and el.get("path") and os.path.exists(el["path"]):
            with Image.open(el["path"]) as e:
                e = e.convert("RGBA").resize((max(1, w), max(1, h)))
                img.paste(e, (x, y), e)
        elif el.get("type") == "text":
            size_px = el.get("fontSizePt", 24) * px_per_pt
            color = parse_color(el.get("color"))
            # Shrink to fit the box so re-rendered Korean never overflows the OCR bbox.
            font, lines, line_h = fit_font(draw, el.get("text", ""), size_px, max(1, w), max(1, h))
            align = el.get("align", "left")
            cy = y
            for line in lines:
                lw = draw.textlength(line, font=font)
                lx = x if align == "left" else (x + w - lw if align == "right" else x + (w - lw) / 2)
                draw.text((lx, cy), line, font=font, fill=color)
                cy += line_h
    return img


def main():
    if len(sys.argv) < 3:
        die("usage: render-png.py <spec.json> <output.png> [--width N] [--slide N]")
    spec_path, out_path = sys.argv[1], sys.argv[2]
    width = 1920
    only = None
    args = sys.argv[3:]
    for i, a in enumerate(args):
        if a == "--width" and i + 1 < len(args):
            width = int(args[i + 1])
        if a == "--slide" and i + 1 < len(args):
            only = int(args[i + 1])

    with open(spec_path, encoding="utf-8") as fh:
        spec = json.load(fh)

    w_emu = int(spec.get("slideWidthEmu", 12192000))
    h_emu = int(spec.get("slideHeightEmu", 6858000))
    canvas_w = width
    canvas_h = int(round(width * h_emu / w_emu))

    slides = spec.get("slides")
    if slides is None:
        slides = [spec] if "elements" in spec else []
    if not slides:
        die("spec has no slides")

    base, ext = os.path.splitext(out_path)
    count = 0
    for idx, s in enumerate(slides):
        if only is not None and idx != only:
            continue
        img = render_slide(s, canvas_w, canvas_h)
        path = out_path if idx == 0 else f"{base}-{idx + 1}{ext}"
        if only is not None:
            path = out_path
        img.save(path)
        count += 1
    sys.stderr.write(f"render-png: wrote {count} png(s), base {out_path} ({canvas_w}x{canvas_h})\n")


if __name__ == "__main__":
    main()
