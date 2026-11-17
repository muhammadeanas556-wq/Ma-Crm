"""Whole-page RapidOCR: one detection+recognition pass, reused across all fields.

`run_page_ocr` takes an optional `rois` list to skip recognition on boxes far from
every field ROI. Measured on this project's real sample page (645x912, 112 detected
text boxes total): detection is cheap (~1-2s) but recognition of all 112 boxes costs
~10-13s regardless of batch size, because most of those boxes are printed boilerplate
(disclaimer paragraphs, unrelated checkbox labels, headers) nobody ever reads — only
~20-30 boxes sit near an actual field. Recognizing only the boxes near a (padded) ROI
cuts that to a fraction of the boxes, and therefore a fraction of the time, without
touching detection (which still runs on the whole page) or accuracy for the boxes that
matter.
"""

from dataclasses import dataclass
from functools import lru_cache

import numpy as np
from rapidocr_onnxruntime import RapidOCR


@dataclass(frozen=True)
class OCRBox:
    bbox: tuple[int, int, int, int]  # x1, y1, x2, y2
    text: str
    score: float


@lru_cache(maxsize=1)
def _engine() -> RapidOCR:
    return RapidOCR()


def _boxes_from_full_result(result) -> list[OCRBox]:
    boxes: list[OCRBox] = []
    for polygon, text, score in result:
        xs = [p[0] for p in polygon]
        ys = [p[1] for p in polygon]
        boxes.append(
            OCRBox(
                bbox=(int(min(xs)), int(min(ys)), int(max(xs)), int(max(ys))),
                text=text,
                score=float(score),
            )
        )
    return boxes


def _box_center(polygon: np.ndarray) -> tuple[float, float]:
    return (polygon[:, 0].min() + polygon[:, 0].max()) / 2, (polygon[:, 1].min() + polygon[:, 1].max()) / 2


def _center_in_any_roi(polygon: np.ndarray, rois: list[tuple[int, int, int, int]]) -> bool:
    cx, cy = _box_center(polygon)
    return any(x1 <= cx <= x2 and y1 <= cy <= y2 for x1, y1, x2, y2 in rois)


def run_page_ocr(
    image: np.ndarray,
    rois: list[tuple[int, int, int, int]] | None = None,
    roi_padding: int = 50,
) -> list[OCRBox]:
    """Without `rois`: full page, all boxes recognized (used by text_extractor.py's
    whole-text fallback, which deliberately needs everything). With `rois`: detection
    still runs on the whole page, but only boxes within `roi_padding` px of one of the
    given ROIs get recognized — recognition is the expensive stage, not detection."""
    engine = _engine()

    if rois is None:
        result, _ = engine(image)
        return _boxes_from_full_result(result) if result else []

    raw_h, raw_w = image.shape[:2]
    prepped, ratio_h, ratio_w = engine.preprocess(image)
    op_record = {"preprocess": {"ratio_h": ratio_h, "ratio_w": ratio_w}}
    prepped, op_record = engine.maybe_add_letterbox(prepped, op_record)

    dt_boxes, _ = engine.auto_text_det(prepped)
    if dt_boxes is None:
        return []

    origin_boxes = engine._get_origin_points(dt_boxes, op_record, raw_h, raw_w)
    padded_rois = [(x1 - roi_padding, y1 - roi_padding, x2 + roi_padding, y2 + roi_padding) for x1, y1, x2, y2 in rois]

    keep_idx = [i for i, box in enumerate(origin_boxes) if _center_in_any_roi(box, padded_rois)]
    if not keep_idx:
        return []

    crops = engine.get_crop_img_list(prepped, [dt_boxes[i] for i in keep_idx])
    rec_res, _ = engine.text_rec(crops)

    boxes: list[OCRBox] = []
    for i, (text, score) in zip(keep_idx, rec_res):
        if float(score) < engine.text_score:
            continue
        xs, ys = origin_boxes[i][:, 0], origin_boxes[i][:, 1]
        boxes.append(OCRBox(bbox=(int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())), text=text, score=float(score)))
    return boxes
