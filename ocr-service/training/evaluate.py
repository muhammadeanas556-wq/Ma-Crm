"""Evaluate one or more trained signature-detection runs and print a comparison
table (mAP50, mAP50-95, precision, recall, CPU ms/image) so you can pick a winner
by hand — no automatic model switching.

Usage:
    python training/evaluate.py --model yolo11n --run-name n_baseline --model yolo11s --run-name s_baseline
"""

import argparse
import time
from pathlib import Path

from ultralytics import YOLO

DATA_YAML = Path(__file__).parent / "data" / "signverod_yolo" / "signature.yaml"
PROJECT_DIR = Path(__file__).parent.parent / "models" / "signature"


def evaluate_run(model_name: str, run_name: str) -> dict:
    weights_path = PROJECT_DIR / model_name / run_name / "weights" / "best.pt"
    if not weights_path.exists():
        raise FileNotFoundError(f"No trained weights at {weights_path}")

    model = YOLO(str(weights_path))
    metrics = model.val(data=str(DATA_YAML), split="test", device="cpu")

    dummy = model.predict(source=str(DATA_YAML).replace("signature.yaml", "images/test"), device="cpu", verbose=False)
    n_images = max(1, len(dummy))
    t0 = time.perf_counter()
    model.predict(source=str(DATA_YAML).replace("signature.yaml", "images/test"), device="cpu", verbose=False)
    cpu_ms_per_image = (time.perf_counter() - t0) * 1000 / n_images

    return {
        "model": model_name,
        "run_name": run_name,
        "map50": float(metrics.box.map50),
        "map50_95": float(metrics.box.map),
        "precision": float(metrics.box.mp),
        "recall": float(metrics.box.mr),
        "cpu_ms_per_image": cpu_ms_per_image,
    }


def print_table(rows: list[dict]) -> None:
    headers = ["model", "run_name", "map50", "map50_95", "precision", "recall", "cpu_ms_per_image"]
    widths = {h: max(len(h), *(len(f"{r[h]}") for r in rows)) for h in headers}
    print(" | ".join(h.ljust(widths[h]) for h in headers))
    print("-+-".join("-" * widths[h] for h in headers))
    for r in rows:
        print(" | ".join(f"{r[h]}".ljust(widths[h]) for h in headers))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", action="append", required=True, help="Repeat per run, paired with --run-name")
    parser.add_argument("--run-name", action="append", required=True, help="Repeat per run, paired with --model")
    args = parser.parse_args()

    if len(args.model) != len(args.run_name):
        raise SystemExit("--model and --run-name must be passed the same number of times")

    rows = [evaluate_run(m, r) for m, r in zip(args.model, args.run_name)]
    print_table(rows)
