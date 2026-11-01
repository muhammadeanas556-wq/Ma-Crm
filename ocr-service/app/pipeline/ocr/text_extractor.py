"""Whole-page-text extraction: cluster RapidOCR boxes into reading-order lines, then
pull each field out of the resulting text blob with regex, instead of relying on
per-field pixel ROIs.

Two extraction strategies, chosen per field:
- Pattern-only: fields whose VALUE has a distinctive, essentially unique shape on the
  page (10-digit mobile number, 6-digit PIN, email, a "TX"-prefixed txn id) are found
  by searching the whole blob for that pattern directly — no label anchor needed, and
  more robust than one because some printed labels don't get detected as OCR text at
  all (verified: "PINCODE" never appears as a token in this form's OCR output, even
  though the 6-digit value next to it does).
- Label-anchored: free-text fields (name, society, address, agency name) have no
  distinctive value shape, so they're only extractable by finding the (OCR'd, and
  therefore possibly garbled) printed label and capturing what follows it within a
  bounded window.

This trades the previous approach's fragility (pixel ROIs that shift with scan
alignment, and RapidOCR occasionally merging two adjacent fields into one detection
box that a ROI crop can't split apart) for a different fragility: label patterns here
are calibrated against this engine's actual garbling of this form's printed labels on
one real sample, and may need adjusting for other scans/engines.
"""

import re

from app.pipeline.ocr.rapidocr_engine import OCRBox


def build_reading_order_text(boxes: list[OCRBox], row_tolerance_px: int = 8) -> str:
    """Cluster boxes into rows by y-proximity, sort each row left-to-right, join rows
    with newlines. This does not attempt true multi-column layout separation — boxes
    from side-by-side sections at the same height end up on the same line — but each
    field's own label and value stay adjacent, which is what the regexes below need."""
    if not boxes:
        return ""

    boxes_sorted = sorted(boxes, key=lambda b: (b.bbox[1] + b.bbox[3]) / 2)
    rows: list[dict] = []
    for b in boxes_sorted:
        cy = (b.bbox[1] + b.bbox[3]) / 2
        if rows and abs(cy - rows[-1]["y"]) <= row_tolerance_px:
            rows[-1]["boxes"].append(b)
            n = len(rows[-1]["boxes"])
            rows[-1]["y"] = (rows[-1]["y"] * (n - 1) + cy) / n
        else:
            rows.append({"y": cy, "boxes": [b]})

    lines = []
    for row in rows:
        row["boxes"].sort(key=lambda b: b.bbox[0])
        lines.append(" ".join(b.text for b in row["boxes"]))
    return "\n".join(lines)


# Pattern-only fields: search the whole blob for the value shape directly. Digit
# patterns use (?<!\d)/(?!\d) boundaries — plain \d{6} would happily match a 6-digit
# substring of an unrelated longer run (verified: a naive pincode search matched into
# the middle of the 10-digit mobile number instead of the real 6-digit PIN).
_PATTERN_ONLY: dict[str, re.Pattern] = {
    "mobile_no": re.compile(r"(?<!\d)\d{10}(?!\d)"),
    "pincode": re.compile(r"(?<!\d)\d{6}(?!\d)"),
    "payment_txn_id": re.compile(r"TX\d{6,12}", re.IGNORECASE),
}

# Label-anchored fields: find the (possibly garbled) printed label, capture what
# follows within a bounded window. `.{0,N}?` is non-greedy so it stops at the first
# plausible value rather than swallowing the rest of the line.
_LABEL_ANCHORED: dict[str, tuple[re.Pattern, re.Pattern]] = {
    "full_name": (re.compile(r"FULL\s*NAME", re.I), re.compile(r"([A-Z]{2,}(?:\s+[A-Z]{2,}){0,3})")),
    "building_name": (re.compile(r"BUILDING\s*NAME", re.I), re.compile(r"([A-Z]{3,})")),
    "society_name": (re.compile(r"(?:SOCIETY\s*NAME|ETY\s*NAME)", re.I), re.compile(r"([A-Z]{3,})")),
    "area_location": (re.compile(r"AREA\s*[/!]?\s*LOCATION", re.I), re.compile(r"([A-Z]{3,})")),
    "bank_name": (re.compile(r"BANK\s*NAME", re.I), re.compile(r"([A-Z]{2,})")),
    "bp_no": (re.compile(r"BP\s*\.?\s*NO", re.I), re.compile(r"([A-Z0-9]{5,12})")),
    "co_no": (re.compile(r"\bCO\s*\.?\s*NO\b", re.I), re.compile(r"(\d{3,8})")),
    "agency_code": (re.compile(r"AGENCY\s*CODE", re.I), re.compile(r"(\d{2,5})")),
    "agency_name": (re.compile(r"AGENCY\s*NAME", re.I), re.compile(r"([A-Z]{2,}(?:\s+[A-Z]{2,}){0,3})")),
    # Context-window instead of whole-page pattern search: narrows to text near the
    # "EMAIL" label rather than anywhere on the page. Note this does NOT fix mojibake
    # from the '@'/'.' characters themselves being misread at this resolution — it's a
    # location fix, not a character-recognition fix, so this field can still end up
    # invalid after the fields_regex email-format check even once correctly located.
    "email": (re.compile(r"EMAIL", re.I), re.compile(r"([\w.+@·-]{5,40})")),
}

_WINDOW = 40  # max chars scanned after a label match for its value


def extract_field(field_name: str, page_text: str) -> str | None:
    pattern = _PATTERN_ONLY.get(field_name)
    if pattern is not None:
        match = pattern.search(page_text)
        return match.group(0) if match else None

    anchor_value = _LABEL_ANCHORED.get(field_name)
    if anchor_value is None:
        return None
    label_pattern, value_pattern = anchor_value

    label_match = label_pattern.search(page_text)
    if label_match is None:
        return None
    window = page_text[label_match.end() : label_match.end() + _WINDOW]
    value_match = value_pattern.search(window)
    return value_match.group(1) if value_match else None


def extract_all(field_names: list[str], page_text: str) -> dict[str, str | None]:
    return {name: extract_field(name, page_text) for name in field_names}
