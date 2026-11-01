"""Regex cleanup/validation per field, referencing the field types seen in raw_text.txt
(mobile number, email, PIN code, amounts, dates, alphanumeric office-use codes).

Motivation: each form field is a row of individual character boxes, so RapidOCR often
detects one box per character and router.py joins them with spaces (e.g. "8 4 3 2 0 5
6 7 1 9"). Digit/code fields need whitespace collapsed before they're usable; free-text
fields (name, address, comments) instead need whitespace normalized to single spaces
between words, not collapsed entirely.
"""

import re
from dataclasses import dataclass

# Fields whose value is a contiguous digit/code sequence (spaces between OCR'd
# character boxes should be collapsed entirely, not preserved).
_COMPACT_FIELDS = {
    "pincode",
    "mobile_no",
    "payment_txn_id",
    "bp_no",
    "co_no",
    "agency_code",
}

# Fields whose value must be digits-only end to end (unlike bp_no/co_no, which mix
# letters and digits by design, e.g. "X5421678" — confusion-fixing those would corrupt
# genuine letters). Common OCR digit/letter confusions at low resolution: O/o<->0,
# S/s<->5, I/l<->1, B<->8, Z<->2.
_DIGIT_ONLY_FIELDS = {"pincode", "mobile_no", "agency_code"}
_DIGIT_CONFUSION = str.maketrans({"O": "0", "o": "0", "S": "5", "s": "5", "I": "1", "l": "1", "B": "8", "Z": "2"})


def _fix_digit_confusion(field_name: str, text: str) -> str:
    if field_name in _DIGIT_ONLY_FIELDS:
        return text.translate(_DIGIT_CONFUSION)
    return text


# Fields prone to swallowing a chunk of the printed label above them (the label's OCR
# box occasionally still centers inside the ROI). The garbled label token is usually
# distinguishable by punctuation (e.g. "FULLNAME(ASPEROUMTTED" from "FULL NAME (AS PER
# ID SUBMITTED)*") — but not always: it sometimes OCRs as pure letters with no
# punctuation surviving (e.g. "FULLNAMEAPERUMTED"). Real handwritten name words on this
# form run ~8 characters; the merged label token runs 15+ (it's several printed words
# concatenated with no space detected between them) — so a length cap catches the
# punctuation-free case a pure "is it alphabetic" check misses.
_TRAILING_WORDS_FIELDS = {"full_name"}
_MAX_NAME_WORD_LEN = 12


def _keep_trailing_words(text: str) -> str:
    tokens = text.split()
    trailing: list[str] = []
    for token in reversed(tokens):
        if re.fullmatch(r"[A-Z]+", token) and len(token) <= _MAX_NAME_WORD_LEN:
            trailing.insert(0, token)
        else:
            break
    return " ".join(trailing) if trailing else text


# Fields with a specific expected shape, validated after compacting. Fields not listed
# here (e.g. full_name, society_name, agency_name) are free text and only whitespace-
# normalized, never pattern-validated.
_FIELD_PATTERNS: dict[str, re.Pattern] = {
    "pincode": re.compile(r"\d{6}"),
    "mobile_no": re.compile(r"\d{10}"),
    "email": re.compile(r"[\w.+-]+@[\w-]+\.[\w-]+"),
    "date_amount": re.compile(r"(?P<date>\d{1,2}[/\-]\d{1,2}[/\-]\d{2,4}).*?(?P<amount>\d[\d,]*)"),
    "declaration_date": re.compile(r"\d{1,2}\D{0,2}\d{1,2}\D{0,2}\d{2,4}"),
    "received_date": re.compile(r"\d{1,2}\D{0,2}\d{1,2}\D{0,2}\d{2,4}"),
    # Exact length (1 letter + 7 digits), not "5 or more": this form's BP NO is a fixed
    # 8-cell box template, and an open-ended minimum let a RapidOCR-merged reading like
    # "X5421678CONO" (bp_no's box detection running into the adjacent CO NO label) pass
    # validation unnoticed, silently skipping the whole-text fallback that would have
    # produced the clean "X5421678".
    "bp_no": re.compile(r"[A-Za-z0-9]{8}"),
    "agency_code": re.compile(r"\d{2,4}"),
}


# Fields where "nothing detected" is itself meaningful and should default to a known
# value, rather than surface as a blank/failed field — e.g. this form's "Special
# Comments (if any)" is routinely left as a literal handwritten "NA", and a detection
# miss on that specific word is indistinguishable from the field genuinely being NA.
# Only applied when the field is empty after both the ROI and whole-text-fallback
# passes — never overrides a field that has some (even if invalid) detected content.
_DEFAULT_IF_EMPTY = {"special_comments": "NA"}


@dataclass(frozen=True)
class FieldValidation:
    value: str
    valid: bool


def apply_empty_defaults(validated: dict[str, "FieldValidation"]) -> dict[str, "FieldValidation"]:
    result = dict(validated)
    for name, default_value in _DEFAULT_IF_EMPTY.items():
        current = result.get(name)
        if current is not None and not current.value:
            result[name] = FieldValidation(value=default_value, valid=True)
    return result


def _normalize(field_name: str, raw_text: str) -> str:
    if field_name in _COMPACT_FIELDS:
        return re.sub(r"\s+", "", raw_text)
    normalized = re.sub(r"\s+", " ", raw_text).strip()
    if field_name in _TRAILING_WORDS_FIELDS:
        normalized = _keep_trailing_words(normalized)
    return normalized


def clean_and_validate(field_name: str, raw_text: str) -> FieldValidation:
    normalized = _normalize(field_name, raw_text)
    normalized = _fix_digit_confusion(field_name, normalized)
    pattern = _FIELD_PATTERNS.get(field_name)
    if pattern is None:
        return FieldValidation(value=normalized, valid=bool(normalized))

    match = pattern.search(normalized)
    if match is None:
        return FieldValidation(value=normalized, valid=False)
    return FieldValidation(value=match.group(0), valid=True)


def clean_fields(fields: dict[str, str]) -> dict[str, FieldValidation]:
    return {name: clean_and_validate(name, text) for name, text in fields.items()}
