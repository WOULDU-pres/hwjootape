#!/usr/bin/env python3
"""paddle-ocr.py — PaddleOCR adapter for BananaTape (Linux/WSL + CUDA).

Linux/Windows counterpart of scripts/apple-vision-ocr.swift. Detects and reads
text regions with PaddleOCR (lang="korean") and emits the EXACT same JSON
contract the deck pipeline consumes (see ocr-runner.ts / heuristics.ts OcrLine):

  { "imageWidth": W, "imageHeight": H,
    "lines": [ { "text": "...", "confidence": 0.97,
                 "bbox": { "x": px, "y": px, "width": px, "height": px } } ] }

bbox is axis-aligned TOP-LEFT pixel coordinates (min/max of the detected
polygon) — matching Apple Vision's converted output. In the deck pipeline OCR's
job is mainly to locate text REGIONS (gpt-5.5 remaps the actual text), so the
polygon -> axis-aligned bbox reduction is exactly what downstream wants.

Usage:
  paddle-ocr.py <image>                              # JSON to stdout
  paddle-ocr.py --input <image> --output <json>      # JSON to a file (preferred)
"""
from __future__ import annotations

# Quiet PaddlePaddle's native (GLOG) chatter so stdout stays clean JSON when no
# --output file is used. Must be set before paddle is imported.
import os
os.environ.setdefault("GLOG_minloglevel", "3")
os.environ.setdefault("FLAGS_call_stack_level", "0")

import argparse
import json
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Run PaddleOCR and emit BananaTape OCR JSON.")
    p.add_argument("positional_input", nargs="?", help="Input image path (positional form).")
    p.add_argument("--input", dest="input_path", help="Input image path.")
    p.add_argument("--output", dest="output_path", help="Output JSON path (stdout if omitted).")
    p.add_argument("--lang", default="korean", help="PaddleOCR language model (default: korean).")
    p.add_argument("--device", default=os.environ.get("BANANATAPE_PADDLE_DEVICE"),
                   help='Paddle device, e.g. "gpu", "gpu:0", "cpu". Default: auto-detect.')
    p.add_argument("--debug", action="store_true", help="Print debug info to stderr.")
    return p.parse_args()


def _poly_to_bbox(poly) -> dict | None:
    """Reduce a detection polygon (list of [x,y] points) to an axis-aligned bbox."""
    try:
        xs = [float(pt[0]) for pt in poly]
        ys = [float(pt[1]) for pt in poly]
    except (TypeError, IndexError, ValueError):
        return None
    if not xs or not ys:
        return None
    x1, y1, x2, y2 = min(xs), min(ys), max(xs), max(ys)
    return {"x": x1, "y": y1, "width": max(1.0, x2 - x1), "height": max(1.0, y2 - y1)}


def _box4_to_bbox(box) -> dict | None:
    """Reduce a [x1,y1,x2,y2] box to the bbox shape."""
    try:
        x1, y1, x2, y2 = (float(v) for v in box)
    except (TypeError, ValueError):
        return None
    return {"x": min(x1, x2), "y": min(y1, y2),
            "width": max(1.0, abs(x2 - x1)), "height": max(1.0, abs(y2 - y1))}


def _as_dict(res) -> dict:
    """Normalize a PaddleOCR 3.x result object to a plain dict, tolerating the
    `res.json` -> {"res": {...}} nesting that varies across point releases."""
    data = None
    j = getattr(res, "json", None)
    if isinstance(j, dict):
        data = j.get("res", j)
    if data is None and isinstance(res, dict):
        data = res.get("res", res)
    return data if isinstance(data, dict) else {}


def extract_lines(results) -> list[dict]:
    """Pull (text, confidence, bbox) from a PaddleOCR 3.x predict() result list."""
    lines: list[dict] = []
    for res in results:
        data = _as_dict(res)
        polys = data.get("rec_polys") or data.get("dt_polys") or data.get("rec_boxes") or []
        texts = data.get("rec_texts") or []
        scores = data.get("rec_scores") or []
        for i, poly in enumerate(polys):
            # rec_boxes are 4-number [x1,y1,x2,y2]; rec_polys/dt_polys are point lists.
            bbox = _box4_to_bbox(poly) if (len(poly) == 4 and not hasattr(poly[0], "__len__")) else _poly_to_bbox(poly)
            if bbox is None:
                continue
            text = str(texts[i]) if i < len(texts) else ""
            conf = float(scores[i]) if i < len(scores) else 1.0
            lines.append({"text": text, "confidence": conf, "bbox": bbox})
    return lines


def extract_lines_legacy(result) -> list[dict]:
    """Fallback for PaddleOCR 2.x .ocr(): result[0] = [[box], (text, conf)]."""
    lines: list[dict] = []
    page = result[0] if result else []
    for entry in page or []:
        try:
            box, (text, conf) = entry[0], entry[1]
        except (TypeError, ValueError, IndexError):
            continue
        bbox = _poly_to_bbox(box)
        if bbox is None:
            continue
        lines.append({"text": str(text), "confidence": float(conf), "bbox": bbox})
    return lines


def main() -> int:
    args = parse_args()
    input_path = Path(args.input_path or args.positional_input or "")
    if not input_path.is_file():
        print(f"paddle-ocr: input path does not exist: {input_path}", file=sys.stderr)
        return 2

    def log(msg: str) -> None:
        if args.debug:
            print(f"paddle-ocr: {msg}", file=sys.stderr, flush=True)

    from PIL import Image
    with Image.open(input_path) as im:
        img_w, img_h = im.size

    from paddleocr import PaddleOCR

    init_kwargs = dict(lang=args.lang)
    if args.device:
        init_kwargs["device"] = args.device
    # 3.x: skip the doc-preprocessing sub-pipelines we don't need (faster, fewer downloads).
    for k in ("use_doc_orientation_classify", "use_doc_unwarping", "use_textline_orientation"):
        init_kwargs[k] = False

    log(f"init PaddleOCR {init_kwargs}")
    try:
        ocr = PaddleOCR(**init_kwargs)
    except TypeError:
        # Older builds reject the 3.x-only flags; retry with just lang (+device).
        ocr = PaddleOCR(lang=args.lang, **({"device": args.device} if args.device else {}))

    img_path = str(input_path)
    if hasattr(ocr, "predict"):
        log("running ocr.predict()")
        lines = extract_lines(ocr.predict(img_path))
    else:
        log("running legacy ocr.ocr()")
        lines = extract_lines_legacy(ocr.ocr(img_path))

    payload = {"imageWidth": img_w, "imageHeight": img_h, "lines": lines}
    text = json.dumps(payload, ensure_ascii=False)

    if args.output_path:
        out = Path(args.output_path)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8")
        log(f"wrote {len(lines)} lines -> {out}")
    else:
        sys.stdout.write(text)
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
