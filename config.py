from pathlib import Path

from app.schemas import ModelChoice, OCREngine

BASE_DIR = Path(__file__).resolve().parent.parent
MODELS_DIR = BASE_DIR / "models" / "signature"


class Settings:
    default_ocr_engine: OCREngine = OCREngine.rapidocr
    default_signature_model: ModelChoice = ModelChoice.yolo11n

    # Filled in once training/evaluate.py has picked a winning run, e.g.
    # MODELS_DIR / "yolo11n" / "n_baseline" / "weights" / "best.pt"
    signature_weight_paths: dict[ModelChoice, Path | None] = {
        ModelChoice.yolo11n: MODELS_DIR / "yolo11n" / "n_baseline" / "weights" / "best.pt",
        ModelChoice.yolo11s: None,
    }

    trocr_model_name: str = "microsoft/trocr-base-handwritten"

    # Ink-analysis thresholds (app/pipeline/signature/ink_analysis.py) — calibrate
    # against real signed/unsigned samples in validation/. min_components defaults to
    # 1, not 2: a cursive signature is often a single continuous stroke (one connected
    # component), so requiring >=2 would false-negative on exactly that common case.
    min_ink_ratio: float = 0.01
    min_components: int = 1


settings = Settings()
