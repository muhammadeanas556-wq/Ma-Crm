"""Dispatches OCR across a page according to the requested engine.

- rapidocr: one whole-page detect+recognize pass, boxes mapped onto field ROIs.
- trocr: no detection stage available, so every field ROI is cropped and recognized
  individually.
- hybrid: whole-page rapidocr pass for every field, then handwritten fields are
  re-cropped and re-recognized with trocr, overriding rapidocr's guess for those
  fields only.
"""

import numpy as np

from app.pipeline.ocr import rapidocr_engine, trocr_engine
from app.schemas import OCREngine
from app.templates import DocumentTemplate


def _box_center_in_roi(box: tuple[int, int, int, int], roi: tuple[int, int, int, int]) -> bool:
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    x1, y1, x2, y2 = roi
    return x1 <= cx <= x2 and y1 <= cy <= y2


def _map_boxes_to_fields(
    boxes: list[rapidocr_engine.OCRBox], rois: dict[str, tuple[int, int, int, int]]
) -> dict[str, str]:
    fields: dict[str, str] = {name: "" for name in rois}
    for name, roi in rois.items():
        matched = [b for b in boxes if _box_center_in_roi(b.bbox, roi)]
        # Every field ROI here is a single line of boxed characters/words, so sorting by
        # x alone gives correct left-to-right reading order. Sorting by (y, x) instead
        # scrambles order whenever adjacent character boxes have slightly different y
        # (a few px of scan jitter is enough), e.g. a date read back as "202 0303".
        matched.sort(key=lambda b: b.bbox[0])
        fields[name] = " ".join(b.text for b in matched).strip()
    return fields


def _crop(image: np.ndarray, roi: tuple[int, int, int, int]) -> np.ndarray:
    x1, y1, x2, y2 = roi
    return image[y1:y2, x1:x2]


def extract_fields(
    page_image: np.ndarray,
    template: DocumentTemplate,
    ocr_engine: OCREngine,
    roi_overrides: dict[str, tuple[int, int, int, int]] | None = None,
) -> tuple[dict[str, str], list[rapidocr_engine.OCRBox] | None]:
    """Returns (fields, page_boxes). page_boxes is the whole-page RapidOCR detection —
    None for the trocr engine, which never runs a whole-page pass — kept around so
    callers can run a whole-text regex fallback (text_extractor.py) without paying for
    a second full-page OCR pass."""
    roi_overrides = roi_overrides or {}
    rois = {name: roi_overrides.get(name, spec.roi) for name, spec in template.fields.items()}
    handwritten = {name for name, spec in template.fields.items() if spec.handwritten}

    if ocr_engine == OCREngine.trocr:
        fields = {name: trocr_engine.recognize_crop(_crop(page_image, roi)) for name, roi in rois.items()}
        return fields, None

    # Passing rois restricts *recognition* (the expensive stage) to boxes near a field;
    # detection still runs on the whole page. See rapidocr_engine.run_page_ocr's
    # docstring for why this matters — most detected boxes are boilerplate nobody reads.
    boxes = rapidocr_engine.run_page_ocr(page_image, rois=list(rois.values()))
    fields = _map_boxes_to_fields(boxes, rois)

    if ocr_engine == OCREngine.hybrid:
        for name in handwritten:
            fields[name] = trocr_engine.recognize_crop(_crop(page_image, rois[name]))

    return fields, boxes
