"""Signature presence detection: named known ROIs (preferred, fixed templates) or
YOLO11 detection (unknown template / no named ROIs), followed by ink-analysis scoring.

Returns one SignatureResult per zone/detection, keyed by name — a page can genuinely
have more than one signature (this project's own sample form has an applicant
signature and a separate DMA/office-use signature), so this was never a single result
to begin with, even though the first version of this service assumed it was.
"""

import time

import numpy as np

from app.pipeline.signature import detector, ink_analysis
from app.schemas import ModelChoice, ROIBox, SignatureResult
from app.templates import DocumentTemplate


def _crop(image: np.ndarray, roi: tuple[int, int, int, int]) -> np.ndarray:
    x1, y1, x2, y2 = roi
    return image[y1:y2, x1:x2]


def _detect_named_rois(
    page_image: np.ndarray, named_rois: dict[str, tuple[int, int, int, int]]
) -> tuple[dict[str, SignatureResult], dict[str, float]]:
    results: dict[str, SignatureResult] = {}
    total_crop_ms = 0.0
    total_opencv_ms = 0.0
    for name, roi in named_rois.items():
        t0 = time.perf_counter()
        crop = _crop(page_image, roi)
        t1 = time.perf_counter()
        score = ink_analysis.score_crop(crop)
        t2 = time.perf_counter()
        results[name] = SignatureResult(
            present=score.present,
            confidence=score.confidence,
            bbox=ROIBox(x1=roi[0], y1=roi[1], x2=roi[2], y2=roi[3]),
            model_used=None,
        )
        total_crop_ms += (t1 - t0) * 1000
        total_opencv_ms += (t2 - t1) * 1000
    return results, {"signature_detection_ms": total_crop_ms, "opencv_ms": total_opencv_ms}


def _detect_via_yolo(
    page_image: np.ndarray, model_choice: ModelChoice
) -> tuple[dict[str, SignatureResult], dict[str, float]]:
    t0 = time.perf_counter()
    detections = detector.detect_signatures(page_image, model_choice)
    detection_ms = (time.perf_counter() - t0) * 1000

    if not detections:
        result = SignatureResult(present=False, confidence=0.0, bbox=None, model_used=model_choice)
        return {"signature_0": result}, {"signature_detection_ms": detection_ms, "opencv_ms": 0.0}

    results: dict[str, SignatureResult] = {}
    total_opencv_ms = 0.0
    for i, (bbox, det_confidence) in enumerate(detections):
        crop = _crop(page_image, bbox)
        t0 = time.perf_counter()
        score = ink_analysis.score_crop(crop)
        total_opencv_ms += (time.perf_counter() - t0) * 1000

        present = score.present and det_confidence >= 0.25
        confidence = min(det_confidence, score.confidence) if present else 0.0
        results[f"signature_{i}"] = SignatureResult(
            present=present,
            confidence=confidence,
            bbox=ROIBox(x1=bbox[0], y1=bbox[1], x2=bbox[2], y2=bbox[3]),
            model_used=model_choice,
        )
    return results, {"signature_detection_ms": detection_ms, "opencv_ms": total_opencv_ms}


def detect(
    page_image: np.ndarray,
    template: DocumentTemplate,
    model_choice: ModelChoice,
    roi_overrides: dict[str, tuple[int, int, int, int]] | None = None,
) -> tuple[dict[str, SignatureResult], dict[str, float]]:
    """Returns ({zone_name: result}, timing_ms) with keys 'signature_detection_ms'
    (ROI crops or the YOLO call, summed across zones) and 'opencv_ms' (ink-analysis
    scoring, summed)."""
    named_rois = {**template.signature_rois, **(roi_overrides or {})}

    if named_rois:
        return _detect_named_rois(page_image, named_rois)

    return _detect_via_yolo(page_image, model_choice)
