"""Load a single-page document (PDF or image) into a normalized BGR numpy array."""

import io

import cv2
import numpy as np
import pymupdf as fitz
from PIL import Image, UnidentifiedImageError

# Every raster format Pillow can decode that's realistic for a scanned/photographed
# form. Checked explicitly (rather than trusting whatever Pillow happens to open)
# so an unsupported format fails with a clear message instead of a confusing
# downstream error, and so a mislabeled/unusual format doesn't silently misbehave.
SUPPORTED_IMAGE_FORMATS = {"PNG", "JPEG", "BMP", "TIFF", "WEBP", "GIF"}


def load_first_page(file_bytes: bytes, content_type: str) -> np.ndarray:
    # Route on the actual file bytes ("%PDF" magic header), never on the client-supplied
    # content_type alone: a client that mislabels a PNG upload as "application/pdf" (an
    # easy mistake in tools like Postman, where the part's Content-Type is a free-typed
    # dropdown) would otherwise get routed into the PDF parser and fail outright, even
    # though the bytes are a perfectly valid image.
    if file_bytes[:4] == b"%PDF":
        return _load_pdf_first_page(file_bytes)
    return _load_image(file_bytes)


def _load_pdf_first_page(file_bytes: bytes, dpi: int = 240) -> np.ndarray:
    doc = fitz.open(stream=file_bytes, filetype="pdf")
    try:
        page = doc.load_page(0)
        zoom = dpi / 72
        pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom))
        image = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        return cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
    finally:
        doc.close()


def _load_image(file_bytes: bytes) -> np.ndarray:
    try:
        image = Image.open(io.BytesIO(file_bytes))
        image.load()
    except UnidentifiedImageError as exc:
        raise ValueError(f"Not a recognizable image (or PDF): {exc}") from exc

    if image.format not in SUPPORTED_IMAGE_FORMATS:
        raise ValueError(
            f"Unsupported image format: {image.format!r}. Supported: {sorted(SUPPORTED_IMAGE_FORMATS)}"
        )

    return cv2.cvtColor(np.array(image.convert("RGB")), cv2.COLOR_RGB2BGR)


def normalize_page(image: np.ndarray, page_size: tuple[int, int]) -> np.ndarray:
    """Resize to the template's expected (width, height), preserving aspect ratio
    with white padding, so template ROI coordinates stay valid."""
    target_w, target_h = page_size
    h, w = image.shape[:2]
    scale = min(target_w / w, target_h / h)
    new_w, new_h = int(w * scale), int(h * scale)
    resized = cv2.resize(image, (new_w, new_h), interpolation=cv2.INTER_AREA)

    canvas = np.full((target_h, target_w, 3), 255, dtype=np.uint8)
    canvas[0:new_h, 0:new_w] = resized
    return canvas
