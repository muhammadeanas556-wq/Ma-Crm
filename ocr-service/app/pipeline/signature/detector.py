"""YOLO11 signature-region detector. Used only when no known template ROI is
available for the signature field; weight path per model is set in app/config.py
once training/evaluate.py has picked a winning run."""

from functools import lru_cache
from typing import TYPE_CHECKING

import numpy as np

from app.config import settings
from app.schemas import ModelChoice

if TYPE_CHECKING:
    from ultralytics import YOLO


@lru_cache(maxsize=2)
def _load(model_choice: ModelChoice) -> "YOLO":
    from ultralytics import YOLO

    weight_path = settings.signature_weight_paths.get(model_choice)
    if weight_path is None:
        raise RuntimeError(
            f"No trained weights configured for {model_choice.value}. "
            "Run training/train_signature.py and set app.config.settings.signature_weight_paths."
        )
    return YOLO(str(weight_path))


def detect_signatures(
    image: np.ndarray, model_choice: ModelChoice, conf: float = 0.25
) -> list[tuple[tuple[int, int, int, int], float]]:
    """Returns every detection above `conf` as (bbox, confidence), highest confidence
    first — a page can genuinely have more than one signature (this project's own
    sample form has two: applicant + DMA), so this reports however many the model
    finds rather than only the single best one."""
    model = _load(model_choice)
    results = model.predict(image, conf=conf, verbose=False)
    if not results or results[0].boxes is None or len(results[0].boxes) == 0:
        return []

    boxes = results[0].boxes
    detections = [
        (tuple(int(v) for v in boxes.xyxy[i].tolist()), float(boxes.conf[i])) for i in range(len(boxes))
    ]
    detections.sort(key=lambda d: d[1], reverse=True)
    return detections
