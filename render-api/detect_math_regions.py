#!/usr/bin/env python3
"""
Detect math (equation) regions on a page image using Detectron2 + LayoutParser.

Requirements (install in a Python env):
  pip install layoutparser[layoutmodels] opencv-python pillow
  # Detectron2 install depends on your CUDA/torch version:
  # https://detectron2.readthedocs.io/en/latest/tutorials/install.html

Usage:
  python detect_math_regions.py \
    --image /abs/path/page.png \
    --config /abs/path/config.yaml \
    --weights /abs/path/model_final.pth \
    --labels equation \
    --score-thresh 0.5

Outputs JSON to stdout:
  {"ok": true, "boxes": [{"x":...,"y":...,"w":...,"h":...,"score":0.91,"label":"equation"}], "image": {"w":...,"h":...}}
"""

import argparse
import json
import os
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True, help='Path to input image (PNG/JPG)')
    parser.add_argument('--config', required=False, default=os.environ.get('DETECTRON_CONFIG', ''), help='Detectron2 config.yaml path')
    parser.add_argument('--weights', required=False, default=os.environ.get('DETECTRON_WEIGHTS', ''), help='Detectron2 weights .pth path')
    parser.add_argument('--labels', required=False, default=os.environ.get('DETECTRON_LABELS', 'equation'), help='Comma-separated class names; index order must match training')
    parser.add_argument('--score-thresh', type=float, default=float(os.environ.get('DETECTRON_SCORE_THRESH', '0.5')))
    args = parser.parse_args()

    out = {"ok": False, "boxes": []}

    try:
        import cv2
    except Exception as e:
        out.update({"error": f"opencv_import_failed: {e}"})
        print(json.dumps(out))
        return 0

    try:
        import layoutparser as lp
    except Exception as e:
        out.update({"error": f"layoutparser_import_failed: {e}"})
        print(json.dumps(out))
        return 0

    img_path = os.path.abspath(args.image)
    if not os.path.exists(img_path):
        out.update({"error": f"image_not_found: {img_path}"})
        print(json.dumps(out))
        return 0

    image = cv2.imread(img_path)
    if image is None:
        out.update({"error": f"image_read_failed: {img_path}"})
        print(json.dumps(out))
        return 0

    h, w = image.shape[:2]
    out["image"] = {"w": int(w), "h": int(h), "path": img_path}

    config_path = args.config.strip()
    weights_path = args.weights.strip()
    labels = [s.strip() for s in (args.labels or 'equation').split(',') if s.strip()]
    score_thresh = float(args.score_thresh or 0.5)

    if not config_path or not weights_path:
        out.update({
            "error": "missing_model",
            "detail": "Provide --config and --weights or set DETECTRON_CONFIG/DETECTRON_WEIGHTS env vars."
        })
        print(json.dumps(out))
        return 0

    try:
        # Map class indices to labels; assume contiguous [0..N-1]
        label_map = {i: label for i, label in enumerate(labels)}

        model = lp.Detectron2LayoutModel(
            config_path,
            weights_path,
            extra_config=[
                ("MODEL.ROI_HEADS.SCORE_THRESH_TEST", score_thresh),
            ],
            label_map=label_map,
            device=os.environ.get('DETECTRON_DEVICE', 'cuda' if os.environ.get('CUDA_VISIBLE_DEVICES') else 'cpu')
        )
    except Exception as e:
        out.update({"error": f"model_init_failed: {e}"})
        print(json.dumps(out))
        return 0

    try:
        layout = model.detect(image)
    except Exception as e:
        out.update({"error": f"detect_failed: {e}"})
        print(json.dumps(out))
        return 0

    boxes = []
    try:
        for b in layout:
            # Each b is a TextBlock / LayoutElement with .block or .coordinates
            x1, y1, x2, y2 = map(float, b.block.points[0] + b.block.points[2]) if hasattr(b, 'block') else b.coordinates
            x1, y1, x2, y2 = float(x1), float(y1), float(x2), float(y2)
            boxes.append({
                "x": int(max(0, min(w, x1))),
                "y": int(max(0, min(h, y1))),
                "w": int(max(0, min(w, x2) - max(0, min(w, x1)))),
                "h": int(max(0, min(h, y2) - max(0, min(h, y1)))),
                "score": float(getattr(b, 'score', 1.0)),
                "label": str(getattr(b, 'type', 'equation')),
            })
    except Exception:
        # Fallback extraction
        for b in layout:
            try:
                x1, y1, x2, y2 = b.coordinates
                boxes.append({
                    "x": int(x1), "y": int(y1), "w": int(x2 - x1), "h": int(y2 - y1),
                    "score": float(getattr(b, 'score', 1.0)),
                    "label": str(getattr(b, 'type', 'equation')),
                })
            except Exception:
                continue

    out.update({"ok": True, "boxes": boxes})
    print(json.dumps(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())


