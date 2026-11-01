import json
import time

import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile

from app.pipeline import fields_regex, preprocess
from app.pipeline.ocr import rapidocr_engine
from app.pipeline.ocr import router as ocr_router
from app.pipeline.ocr import text_extractor
from app.pipeline.signature import service as signature_service
from app.schemas import (
    DetectSignatureResponse,
    ExtractResponse,
    ExtractTextResponse,
    ModelChoice,
    OCREngine,
    ROIBox,
)
from app.templates import DocumentTemplate, get_template

app = FastAPI(title="Banking Form Extraction Service")


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/extract-text-generic")
async def extract_text_generic(file: UploadFile = File(...)):
    """Template-free whole-page OCR: no document_type, no ROI boxes — used for screenshots
    whose layout isn't known in advance (courier/COD parcel labels, which vary by courier
    and by handwriting, unlike the fixed bank-form templates the rest of this service is
    built around). Runs one full-page RapidOCR detect+recognize pass (rapidocr_engine.
    run_page_ocr with rois=None, i.e. every detected box gets recognized, not just boxes
    near a known field) and returns the boxes joined into reading-order text. A caller
    (e.g. the CRM's own field-extraction/regex logic) is expected to pull whatever fields
    it needs out of that text itself — this endpoint does no field-specific parsing.
    """
    file_bytes = await file.read()
    t0 = time.perf_counter()
    try:
        page = preprocess.load_first_page(file_bytes, file.content_type or "")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read document: {exc}") from exc
    preprocess_ms = (time.perf_counter() - t0) * 1000

    t1 = time.perf_counter()
    boxes = rapidocr_engine.run_page_ocr(page, rois=None)
    text = text_extractor.build_reading_order_text(boxes)
    ocr_ms = (time.perf_counter() - t1) * 1000

    return {
        "text": text,
        "timing_ms": {"preprocess_ms": preprocess_ms, "ocr_ms": ocr_ms, "total_ms": preprocess_ms + ocr_ms},
    }


def _resolve_document_type(document_type: str) -> str:
    # A form-data key present with a blank value (an easy thing to leave behind in
    # Postman) arrives here as "", not as "unset" — so Form("mgl_png_form")'s default
    # never kicks in on its own. Treat blank the same as omitted.
    return document_type.strip() or "mgl_png_form"


def _get_template_or_400(document_type: str) -> DocumentTemplate:
    try:
        return get_template(document_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def _parse_overrides(roi_overrides: str | None) -> dict[str, tuple[int, int, int, int]]:
    if not roi_overrides:
        return {}
    try:
        raw = json.loads(roi_overrides)
        return {name: tuple(ROIBox(**box).model_dump().values()) for name, box in raw.items()}
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=400, detail=f"Invalid roi_overrides: {exc}") from exc


async def _load_page(file: UploadFile, template: DocumentTemplate) -> tuple[np.ndarray, float]:
    """Returns (normalized_page, preprocess_ms)."""
    file_bytes = await file.read()
    t0 = time.perf_counter()
    try:
        raw_page = preprocess.load_first_page(file_bytes, file.content_type or "")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Could not read document: {exc}") from exc
    page = preprocess.normalize_page(raw_page, template.page_size)
    return page, (time.perf_counter() - t0) * 1000


def _extract_text(
    page: np.ndarray,
    template: DocumentTemplate,
    ocr_engine: OCREngine,
    overrides: dict[str, tuple[int, int, int, int]],
) -> tuple[dict[str, str], dict[str, bool], float]:
    """Returns (fields, field_valid, ocr_ms)."""
    t0 = time.perf_counter()
    field_overrides = {k: v for k, v in overrides.items() if k in template.fields}
    raw_fields, page_boxes = ocr_router.extract_fields(page, template, ocr_engine, field_overrides)
    validated = fields_regex.clean_fields(raw_fields)

    # Whole-text regex fallback: only consulted for fields the ROI-cropped result
    # already failed validation on, so a fallback miss/false-positive can never
    # regress a field that was already correct (see app/pipeline/ocr/text_extractor.py).
    if page_boxes is not None:
        page_text = text_extractor.build_reading_order_text(page_boxes)
        for name, result in validated.items():
            if result.valid:
                continue
            fallback_raw = text_extractor.extract_field(name, page_text)
            if fallback_raw is None:
                continue
            fallback_result = fields_regex.clean_and_validate(name, fallback_raw)
            if fallback_result.valid:
                validated[name] = fallback_result

    validated = fields_regex.apply_empty_defaults(validated)
    fields = {name: v.value for name, v in validated.items()}
    field_valid = {name: v.valid for name, v in validated.items()}
    return fields, field_valid, (time.perf_counter() - t0) * 1000


def _detect_signatures(
    page: np.ndarray,
    template: DocumentTemplate,
    signature_model: ModelChoice,
    overrides: dict[str, tuple[int, int, int, int]],
):
    # Anything in overrides that isn't a field name is assumed to be a signature-zone
    # override, keyed by zone name (e.g. "applicant", "dma" for mgl_png_form).
    signature_overrides = {k: v for k, v in overrides.items() if k not in template.fields}
    return signature_service.detect(page, template, signature_model, signature_overrides)


@app.post("/extract-text", response_model=ExtractTextResponse)
async def extract_text(
    file: UploadFile = File(...),
    document_type: str = Form("mgl_png_form"),
    ocr_engine: OCREngine = Form(OCREngine.rapidocr),
    roi_overrides: str | None = Form(None),
):
    """OCR field extraction only — no signature detection."""
    document_type = _resolve_document_type(document_type)
    template = _get_template_or_400(document_type)
    overrides = _parse_overrides(roi_overrides)

    page, preprocess_ms = await _load_page(file, template)
    fields, field_valid, ocr_ms = _extract_text(page, template, ocr_engine, overrides)

    timing_ms = {"preprocess_ms": preprocess_ms, "ocr_ms": ocr_ms, "total_ms": preprocess_ms + ocr_ms}
    return ExtractTextResponse(
        document_type=document_type,
        ocr_engine_used=ocr_engine,
        fields=fields,
        field_valid=field_valid,
        timing_ms=timing_ms,
    )


@app.post("/detect-signature", response_model=DetectSignatureResponse)
async def detect_signature(
    file: UploadFile = File(...),
    document_type: str = Form("mgl_png_form"),
    signature_model: ModelChoice = Form(ModelChoice.yolo11n),
    roi_overrides: str | None = Form(None),
):
    """Signature presence + bounding-box detection only — no OCR field extraction."""
    document_type = _resolve_document_type(document_type)
    template = _get_template_or_400(document_type)
    overrides = _parse_overrides(roi_overrides)

    page, preprocess_ms = await _load_page(file, template)
    signatures, signature_timing = _detect_signatures(page, template, signature_model, overrides)

    timing_ms = {
        "preprocess_ms": preprocess_ms,
        **signature_timing,
        "total_ms": preprocess_ms + sum(signature_timing.values()),
    }
    return DetectSignatureResponse(document_type=document_type, signatures=signatures, timing_ms=timing_ms)


@app.post("/extract", response_model=ExtractResponse)
async def extract(
    file: UploadFile = File(...),
    document_type: str = Form("mgl_png_form"),
    ocr_engine: OCREngine = Form(OCREngine.rapidocr),
    signature_model: ModelChoice = Form(ModelChoice.yolo11n),
    roi_overrides: str | None = Form(None),
):
    """Combined: OCR field extraction + signature detection in one pass over the page."""
    document_type = _resolve_document_type(document_type)
    template = _get_template_or_400(document_type)
    overrides = _parse_overrides(roi_overrides)

    page, preprocess_ms = await _load_page(file, template)
    fields, field_valid, ocr_ms = _extract_text(page, template, ocr_engine, overrides)
    signatures, signature_timing = _detect_signatures(page, template, signature_model, overrides)

    timing_ms = {
        "preprocess_ms": preprocess_ms,
        "ocr_ms": ocr_ms,
        **signature_timing,
        "total_ms": preprocess_ms + ocr_ms + sum(signature_timing.values()),
    }
    return ExtractResponse(
        document_type=document_type,
        ocr_engine_used=ocr_engine,
        fields=fields,
        field_valid=field_valid,
        signatures=signatures,
        timing_ms=timing_ms,
    )
