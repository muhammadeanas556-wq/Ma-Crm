"""TrOCR recognition on a single pre-cropped field image (no detection stage)."""

from functools import lru_cache

import numpy as np
from PIL import Image

from app.config import settings


@lru_cache(maxsize=1)
def _model():
    from transformers import TrOCRProcessor, VisionEncoderDecoderModel

    processor = TrOCRProcessor.from_pretrained(settings.trocr_model_name)
    model = VisionEncoderDecoderModel.from_pretrained(settings.trocr_model_name)
    model.eval()
    return processor, model


def recognize_crop(crop_bgr: np.ndarray) -> str:
    processor, model = _model()
    image = Image.fromarray(crop_bgr[:, :, ::-1])  # BGR -> RGB
    pixel_values = processor(images=image, return_tensors="pt").pixel_values
    generated_ids = model.generate(pixel_values)
    text = processor.batch_decode(generated_ids, skip_special_tokens=True)[0]
    return text.strip()
