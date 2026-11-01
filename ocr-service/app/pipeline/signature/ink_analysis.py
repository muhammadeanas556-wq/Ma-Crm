"""OpenCV presence scoring for a signature crop.

This is a presence/ink-evidence signal, NOT an authenticity check — it cannot tell a
genuine signature from a scribble or a stray mark. Forgery/authenticity verification
is a separate, out-of-scope problem.

Pipeline: grayscale -> threshold -> remove the printed horizontal signature line via
morphology -> score remaining ink by ratio + connected-component count.
"""

from dataclasses import dataclass

import cv2
import numpy as np

from app.config import settings


@dataclass(frozen=True)
class InkScore:
    present: bool
    confidence: float
    ink_ratio: float
    component_count: int


def _remove_horizontal_line(binary: np.ndarray) -> np.ndarray:
    width = binary.shape[1]
    kernel_len = max(1, width // 2)
    horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_len, 1))
    line_mask = cv2.morphologyEx(binary, cv2.MORPH_OPEN, horizontal_kernel, iterations=1)
    return cv2.subtract(binary, line_mask)


def score_crop(crop_bgr: np.ndarray) -> InkScore:
    if crop_bgr.size == 0:
        return InkScore(present=False, confidence=0.0, ink_ratio=0.0, component_count=0)

    gray = cv2.cvtColor(crop_bgr, cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    ink_only = _remove_horizontal_line(binary)

    ink_pixels = int(np.count_nonzero(ink_only))
    total_pixels = ink_only.shape[0] * ink_only.shape[1]
    ink_ratio = ink_pixels / total_pixels if total_pixels else 0.0

    num_labels, _ = cv2.connectedComponents(ink_only)
    component_count = max(0, num_labels - 1)  # exclude background label

    present = ink_ratio >= settings.min_ink_ratio and component_count >= settings.min_components
    confidence = min(1.0, ink_ratio / (settings.min_ink_ratio * 4)) if present else 0.0

    return InkScore(
        present=present,
        confidence=confidence,
        ink_ratio=ink_ratio,
        component_count=component_count,
    )
