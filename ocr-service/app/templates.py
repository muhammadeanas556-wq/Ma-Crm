"""Document templates: field ROIs, the signature ROI, and which fields are handwritten.

Coordinates are defined against a normalized page size (`page_size`, W x H in pixels).
`preprocess.py` resizes every incoming page to this size before ROI cropping, so ROIs
stay valid regardless of the source scan's original resolution.
"""

from dataclasses import dataclass, field


@dataclass(frozen=True)
class FieldSpec:
    roi: tuple[int, int, int, int]  # x1, y1, x2, y2
    handwritten: bool = False


@dataclass(frozen=True)
class DocumentTemplate:
    page_size: tuple[int, int]  # width, height
    fields: dict[str, FieldSpec] = field(default_factory=dict)
    # Named signature zones — this form has two (applicant + DMA/office-use), each at
    # its own fixed, known location, so both are checked directly rather than relying
    # on YOLO to happen to detect the right count on a fixed layout we already know.
    signature_rois: dict[str, tuple[int, int, int, int]] = field(default_factory=dict)


TEMPLATES: dict[str, DocumentTemplate] = {
    # Mahanagar Gas "Application Form-cum-Receipt for Supply of PNG" — single page.
    # ROIs calibrated against a real filled sample (validation/signed/mahanagar_sample_01.png,
    # native 645x912). The whole form is hand-filled in block letters, so every value field
    # is handwritten=True — only the printed labels/checkboxes are machine text.
    "mgl_png_form": DocumentTemplate(
        page_size=(645, 912),
        fields={
            "full_name": FieldSpec(roi=(240, 125, 615, 146), handwritten=True),
            "flat_house_no": FieldSpec(roi=(68, 186, 140, 207), handwritten=True),
            "floor": FieldSpec(roi=(145, 186, 195, 207), handwritten=True),
            "wing": FieldSpec(roi=(225, 186, 258, 207), handwritten=True),
            "plot_no": FieldSpec(roi=(258, 186, 322, 207), handwritten=True),
            "sector_no": FieldSpec(roi=(322, 186, 398, 207), handwritten=True),
            "building_name": FieldSpec(roi=(440, 186, 605, 207), handwritten=True),
            "society_name": FieldSpec(roi=(68, 219, 305, 236), handwritten=True),
            "area_location": FieldSpec(roi=(348, 219, 498, 236), handwritten=True),
            "pincode": FieldSpec(roi=(535, 219, 622, 236), handwritten=True),
            "email": FieldSpec(roi=(65, 246, 460, 266), handwritten=True),
            "mobile_no": FieldSpec(roi=(520, 246, 625, 266), handwritten=True),
            "payment_txn_id": FieldSpec(roi=(460, 350, 625, 372), handwritten=True),
            "bank_name": FieldSpec(roi=(460, 372, 560, 394), handwritten=True),
            "date_amount": FieldSpec(roi=(460, 394, 625, 416), handwritten=True),
            "declaration_date": FieldSpec(roi=(105, 606, 265, 628), handwritten=True),
            "applicant_name_written": FieldSpec(roi=(555, 602, 640, 627), handwritten=True),
            "bp_no": FieldSpec(roi=(137, 710, 256, 732), handwritten=True),
            "co_no": FieldSpec(roi=(300, 710, 395, 732), handwritten=True),
            "agency_code": FieldSpec(roi=(500, 710, 550, 732), handwritten=True),
            "agency_name": FieldSpec(roi=(505, 733, 605, 755), handwritten=True),
            "received_date": FieldSpec(roi=(145, 762, 305, 787), handwritten=True),
            "special_comments": FieldSpec(roi=(140, 790, 300, 818), handwritten=True),
        },
        signature_rois={
            # Cursive, freeform mark next to "APPLICANT SIGNATURE" — hand-calibrated
            # via grid-overlay zoom against the real sample.
            "applicant": (525, 555, 640, 593),
            # Signature next to "SIGNATURE OF DMA" in the office-use section — box
            # reused from a real yolo11n detection on this sample (0.48 confidence,
            # visually confirmed tight and correct), padded slightly for margin.
            "dma": (490, 775, 640, 845),
        },
    ),
}


def get_template(document_type: str) -> DocumentTemplate:
    try:
        return TEMPLATES[document_type]
    except KeyError as exc:
        raise ValueError(f"Unknown document_type: {document_type!r}") from exc
