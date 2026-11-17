"""Whole-page PaddleOCR: one detect+recognize pass, used ONLY by the template-free
`/extract-text-generic` endpoint (the CRM's parcel-screenshot OCR path).

This replaces RapidOCR as the primary engine for that one endpoint. The bank-form
template pipeline (`/extract-text`, `/extract`, `/detect-signature`, and the
ROI-windowed recognition in rapidocr_engine.run_page_ocr(rois=...)) is untouched and
keeps using RapidOCR — it is a separate feature, out of scope for this change.

Returns the same `OCRBox` shape rapidocr_engine does (bbox, text, score), so it is a
drop-in for text_extractor.build_reading_order_text() with no changes needed there.
"""

from functools import lru_cache

import numpy as np

from app.pipeline.ocr.rapidocr_engine import OCRBox


@lru_cache(maxsize=1)
def _engine():
    # Imported lazily: paddleocr/paddlepaddle are heavy (model downloads on first
    # use) and only needed once this engine is actually invoked, not at process start.
    from paddleocr import PaddleOCR

    return PaddleOCR(use_angle_cls=True, lang="en", show_log=False)


def _boxes_from_result(result) -> list[OCRBox]:
    boxes: list[OCRBox] = []
    if not result or result[0] is None:
        return boxes
    for polygon, (text, score) in result[0]:
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


def run_page_ocr(image: np.ndarray) -> list[OCRBox]:
    """Full-page detect+recognize, every box returned (no ROI narrowing — the generic
    endpoint has no known field layout to narrow against, same as RapidOCR's
    rois=None path it replaces)."""
    engine = _engine()
    result = engine.ocr(image, cls=True)
    return _boxes_from_result(result)
