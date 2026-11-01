"""Draw every named signature zone from a document template on a copy of the image,
labeled with present/confidence — reflects what the deployed service actually checks
(app/pipeline/signature/service.py's fixed-ROI path), unlike visualize_detections.py
which shows raw YOLO output only (used for unknown-template documents).

Usage (run as a module from the project root, so `app` is importable):
    python -m training.visualize_signature_zones \
        --image validation/signed/mahanagar_sample_01.png \
        --document-type mgl_png_form \
        --output training/detections/mahanagar_sample_01_zones.png
"""

import argparse
from pathlib import Path

import cv2

from app.pipeline import preprocess
from app.pipeline.signature import ink_analysis
from app.templates import get_template


def visualize(image_path: str, document_type: str, output_path: str) -> None:
    template = get_template(document_type)
    raw = cv2.imread(image_path)
    if raw is None:
        raise FileNotFoundError(f"Could not read image: {image_path}")
    page = preprocess.normalize_page(raw, template.page_size)

    annotated = page.copy()
    print(f"Signature zones for {document_type}:")
    for name, (x1, y1, x2, y2) in template.signature_rois.items():
        crop = page[y1:y2, x1:x2]
        score = ink_analysis.score_crop(crop)
        color = (0, 200, 0) if score.present else (0, 0, 255)
        cv2.rectangle(annotated, (x1, y1), (x2, y2), color, 2)
        label = f"{name}: {'present' if score.present else 'absent'} ({score.confidence:.2f})"
        label_y = y1 - 8 if y1 - 8 > 10 else y2 + 20
        cv2.putText(annotated, label, (x1, label_y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
        print(f"  {name}: present={score.present} confidence={score.confidence:.3f} bbox=({x1},{y1},{x2},{y2})")

    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output), annotated)
    print(f"Saved: {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    parser.add_argument("--document-type", default="mgl_png_form")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    visualize(args.image, args.document_type, args.output)
