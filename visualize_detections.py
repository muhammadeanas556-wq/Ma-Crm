"""Run a trained YOLO signature detector on an image and save a copy with detected
signature regions drawn as bounding boxes (+ confidence scores) — for visually
confirming detections (e.g. to show a reviewer) rather than only reading raw JSON.

Detects however many signatures are actually present — this project's own sample form
has two (an applicant signature and a separate DMA/office-use signature), which the
service's current fixed single signature_roi doesn't report; this script runs the
YOLO detector directly, unconstrained by that, so it's the way to see both at once.

Usage:
    python training/visualize_detections.py \
        --weights models/signature/yolo11n/n_baseline/weights/best.pt \
        --image validation/signed/mahanagar_sample_01.png \
        --output training/detections/mahanagar_sample_01_detected.png \
        --conf 0.25
"""

import argparse
from pathlib import Path

import cv2
from ultralytics import YOLO


def visualize(weights_path: str, image_path: str, output_path: str, conf: float) -> None:
    model = YOLO(weights_path)
    image = cv2.imread(image_path)
    if image is None:
        raise FileNotFoundError(f"Could not read image: {image_path}")

    results = model.predict(image, conf=conf, verbose=False)
    result = results[0]

    boxes = result.boxes
    n_detections = 0 if boxes is None else len(boxes)
    print(f"Detected {n_detections} signature(s) in {image_path}:")
    if boxes is not None:
        for i in range(n_detections):
            x1, y1, x2, y2 = (int(v) for v in boxes.xyxy[i].tolist())
            confidence = float(boxes.conf[i])
            print(f"  [{i}] bbox=({x1},{y1},{x2},{y2}) confidence={confidence:.3f}")

    annotated = result.plot()  # draws boxes + class label + confidence on a copy
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(output), annotated)
    print(f"Saved annotated image: {output}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", required=True, help="Path to trained YOLO weights (best.pt)")
    parser.add_argument("--image", required=True, help="Path to the input image to run detection on")
    parser.add_argument("--output", required=True, help="Path to save the annotated output image")
    parser.add_argument("--conf", type=float, default=0.25, help="Confidence threshold")
    args = parser.parse_args()

    visualize(args.weights, args.image, args.output, args.conf)
