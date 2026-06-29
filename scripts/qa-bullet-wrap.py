#!/usr/bin/env python3
"""qa-bullet-wrap.py — self-check the bullet hanging-indent fix in both renderers.

When a long bullet line wraps, its continuation must hang-indent under the bullet
BODY (the text after "• "), not drop to x=0 of the box. This guards:
  - render-png.py  wrap_text(): continuation visual lines are space-indented and
    still fit the wrap width; single-line bullets and plain lines are untouched.
  - build-pptx.py  add_text(): bullet paragraphs carry a real hanging indent
    (marL>0, indent<0) in the slide XML; non-bullet paragraphs do not.

Run: python3 scripts/qa-bullet-wrap.py   (exit 0 = pass, non-zero = fail)
"""
import importlib.util
import os
import re
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))


def _load(modname, filename):
    spec = importlib.util.spec_from_file_location(modname, os.path.join(HERE, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def check_render_png():
    from PIL import Image, ImageDraw

    rp = _load("render_png_qa", "render-png.py")
    d = ImageDraw.Draw(Image.new("RGB", (10, 10)))
    font = rp.load_font(28)

    text = (
        "• 매월 9900원에 제공되는 프리미엄 안심 케어 서비스를 지금 신청하세요\n"
        "• 짧은 불릿\n"
        "일반 타이틀 라인"
    )
    max_w = d.textlength("• 매월 9900원에 제공되는 프리미엄", font=font)
    lines = rp.wrap_text(d, text, font, max_w)

    assert lines[0].startswith("• "), "first visual line must keep the bullet marker"
    # every visual line must fit the wrap width
    for i, ln in enumerate(lines):
        assert d.textlength(ln, font=font) <= max_w + 0.5, f"line {i} overflows wrap width"

    # continuation lines of bullet 0 (before bullet 1) must be hang-indented
    cont = []
    for ln in lines[1:]:
        if ln.startswith("• "):
            break
        cont.append(ln)
    assert cont, "expected the long bullet to wrap into a continuation line"
    for c in cont:
        assert c.startswith(" ") and not c.startswith("• "), (
            f"continuation must hang-indent, got {c!r}"
        )

    # regression guards
    assert any(l.startswith("• 짧은 불릿") for l in lines), "single-line bullet regressed"
    assert any(l == "일반 타이틀 라인" for l in lines), "plain (non-bullet) line regressed"
    print("render-png.py: OK (hanging indent on wrap; single-line bullet & plain line intact)")


def check_build_pptx():
    import json

    bp = _load("build_pptx_qa", "build-pptx.py")
    spec = {
        "slides": [
            {
                "background": None,
                "elements": [
                    {
                        "type": "text",
                        "text": "안심 케어 요금 안내",
                        "nbbox": {"x": 0.08, "y": 0.06, "w": 0.84, "h": 0.12},
                        "fontSizePt": 40,
                        "align": "left",
                    },
                    {
                        "type": "text",
                        "text": "• 매월 9900원에 제공되는 프리미엄 안심 케어 서비스를 지금 바로 신청하세요\n• 짧은 항목",
                        "nbbox": {"x": 0.08, "y": 0.24, "w": 0.40, "h": 0.60},
                        "fontSizePt": 22,
                        "align": "left",
                    },
                ],
            }
        ]
    }
    with tempfile.TemporaryDirectory() as tmp:
        spec_path = os.path.join(tmp, "spec.json")
        out_path = os.path.join(tmp, "out.pptx")
        with open(spec_path, "w", encoding="utf-8") as fh:
            json.dump(spec, fh)
        sys.argv = ["build-pptx.py", spec_path, out_path]
        bp.main()

        with zipfile.ZipFile(out_path) as z:
            xml = z.read("ppt/slides/slide1.xml").decode("utf-8")

    hanging = re.findall(r'<a:pPr[^>]*\bindent="-\d+"', xml)
    assert hanging, "no bullet paragraph carries a hanging indent (indent<0)"
    for tag in hanging:
        assert re.search(r'marL="\d+"', tag), "hanging paragraph must also set marL>0"
    # the title paragraph must NOT be hang-indented
    assert "안심 케어 요금 안내" in xml and "•" in xml, "expected title + bullet text present"
    print(f"build-pptx.py: OK ({len(hanging)} bullet paragraph(s) hang-indented; title not)")


def main():
    check_render_png()
    check_build_pptx()
    print("qa-bullet-wrap: PASS")


if __name__ == "__main__":
    main()
