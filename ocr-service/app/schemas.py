from enum import Enum

from pydantic import BaseModel


class ModelChoice(str, Enum):
    yolo11n = "yolo11n"
    yolo11s = "yolo11s"


class OCREngine(str, Enum):
    rapidocr = "rapidocr"
    trocr = "trocr"
    hybrid = "hybrid"


class ROIBox(BaseModel):
    x1: int
    y1: int
    x2: int
    y2: int


class ExtractRequest(BaseModel):
    document_type: str = "mgl_png_form"
    ocr_engine: OCREngine = OCREngine.rapidocr
    signature_model: ModelChoice = ModelChoice.yolo11n
    roi_overrides: dict[str, ROIBox] | None = None


class SignatureResult(BaseModel):
    present: bool
    confidence: float
    bbox: ROIBox | None
    model_used: ModelChoice | None


class ExtractTextResponse(BaseModel):
    document_type: str
    ocr_engine_used: OCREngine
    fields: dict[str, str]
    field_valid: dict[str, bool]
    timing_ms: dict[str, float]


class DetectSignatureResponse(BaseModel):
    document_type: str
    # Keyed by signature zone name (e.g. "applicant", "dma" for mgl_png_form) — a page
    # can genuinely have more than one signature, so this isn't a single result.
    signatures: dict[str, SignatureResult]
    timing_ms: dict[str, float]


class ExtractResponse(BaseModel):
    document_type: str
    ocr_engine_used: OCREngine
    fields: dict[str, str]
    field_valid: dict[str, bool]
    signatures: dict[str, SignatureResult]
    timing_ms: dict[str, float]
