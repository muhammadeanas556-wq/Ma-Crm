"""Train a YOLO11 signature detector on SignverOD.

This is a plain CLI, not a REST endpoint or an auto-fallback loop — you invoke it
once per model you want to compare (yolo11n, yolo11s) and read the results yourself
via evaluate.py.

Usage:
    python training/train_signature.py --model yolo11n --run-name n_baseline
    python training/train_signature.py --model yolo11s --run-name s_baseline
"""

import argparse
from dataclasses import dataclass
from pathlib import Path

from ultralytics import YOLO

DATA_YAML = Path(__file__).parent / "data" / "signverod_yolo" / "signature.yaml"
PROJECT_DIR = Path(__file__).parent.parent / "models" / "signature"


@dataclass(frozen=True)
class TrainConfig:
    model: str
    run_name: str
    dataset: str = "signverod"
    epochs: int = 100
    imgsz: int = 640
    batch: int = 16


def train(config: TrainConfig) -> Path:
    weights = f"{config.model}.pt"
    model = YOLO(weights)
    results = model.train(
        data=str(DATA_YAML),
        epochs=config.epochs,
        imgsz=config.imgsz,
        batch=config.batch,
        project=str(PROJECT_DIR / config.model),
        name=config.run_name,
        device="cpu",
    )
    return Path(results.save_dir) / "weights" / "best.pt"


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", choices=["yolo11n", "yolo11s"], required=True)
    parser.add_argument("--run-name", required=True)
    parser.add_argument("--dataset", default="signverod")
    parser.add_argument("--epochs", type=int, default=100)
    parser.add_argument("--imgsz", type=int, default=640)
    parser.add_argument("--batch", type=int, default=16)
    args = parser.parse_args()

    cfg = TrainConfig(
        model=args.model,
        run_name=args.run_name,
        dataset=args.dataset,
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
    )
    best_weights = train(cfg)
    print(f"Best weights: {best_weights}")
