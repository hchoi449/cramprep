#!/usr/bin/env python3
"""
Detect document layout regions using Hugging Face Deformable DETR.

Outputs JSON to stdout in the same shape as detect_math_regions.py:
  {"ok": true, "boxes": [{x,y,w,h,score,label}], "image": {w,h,path}}

Environment variables / args:
  --image (required): path to PNG/JPG
  --model (optional): HF model id; default: Aryn/deformable-detr-DocLayNet
  --score-thresh (optional): float threshold; default from DETECTOR_SCORE_THRESH or DETECTRON_SCORE_THRESH or 0.5
"""

import argparse
import json
import os
import sys


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--image', required=True, help='Path to input image (PNG/JPG)')
    parser.add_argument('--model', required=False, default=os.environ.get('HF_DETR_MODEL', 'Aryn/deformable-detr-DocLayNet'))
    parser.add_argument('--score-thresh', type=float, default=float(os.environ.get('DETECTOR_SCORE_THRESH') or os.environ.get('DETECTRON_SCORE_THRESH') or 0.5))
    args = parser.parse_args()

    out = {"ok": False, "boxes": []}

    try:
        from PIL import Image
    except Exception as e:
        out.update({"error": f"pillow_import_failed: {e}"}); print(json.dumps(out)); return 0

    try:
        from transformers import AutoImageProcessor, DeformableDetrForObjectDetection
        import torch
    except Exception as e:
        out.update({"error": f"transformers_import_failed: {e}"}); print(json.dumps(out)); return 0

    img_path = os.path.abspath(args.image)
    if not os.path.exists(img_path):
        out.update({"error": f"image_not_found: {img_path}"}); print(json.dumps(out)); return 0

    try:
        image = Image.open(img_path).convert('RGB')
        w, h = image.size
        out["image"] = {"w": int(w), "h": int(h), "path": img_path}
    except Exception as e:
        out.update({"error": f"image_read_failed: {e}"}); print(json.dumps(out)); return 0

    try:
        processor = AutoImageProcessor.from_pretrained(args.model)
        model = DeformableDetrForObjectDetection.from_pretrained(args.model)
        model.eval()
    except Exception as e:
        out.update({"error": f"model_init_failed: {e}"}); print(json.dumps(out)); return 0

    try:
        inputs = processor(images=image, return_tensors="pt")
        with torch.no_grad():
            outputs = model(**inputs)
        target_sizes = torch.tensor([image.size[::-1]])  # (h,w)
        results = processor.post_process_object_detection(outputs, target_sizes=target_sizes, threshold=float(args.score_thresh))[0]
    except Exception as e:
        out.update({"error": f"detect_failed: {e}"}); print(json.dumps(out)); return 0

    id2label = getattr(model.config, 'id2label', {}) or {}
    boxes = []
    try:
        for score, label_id, box in zip(results["scores"], results["labels"], results["boxes"]):
            x1, y1, x2, y2 = [float(v) for v in box.tolist()]
            boxes.append({
                "x": int(max(0, min(w, x1))),
                "y": int(max(0, min(h, y1))),
                "w": int(max(0, min(w, x2) - max(0, min(w, x1)))),
                "h": int(max(0, min(h, y2) - max(0, min(h, y1)))),
                "score": float(score.item() if hasattr(score, 'item') else float(score)),
                "label": str(id2label.get(int(label_id), str(int(label_id))))
            })
    except Exception:
        pass

    out.update({"ok": True, "boxes": boxes})
    print(json.dumps(out))
    return 0


if __name__ == '__main__':
    sys.exit(main())


