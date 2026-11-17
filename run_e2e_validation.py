"""End-to-end validation against the running service: measures document-level
signed/unsigned accuracy on your own form scans — the metric that actually matters,
separate from SignverOD's box-level mAP (see training/evaluate.py).

Layout:
    validation/signed/*.{png,jpg,pdf}      # your own scans, known to be signed
    validation/unsigned/*.{png,jpg,pdf}    # your own scans, known to be unsigned

Usage:
    python validation/run_e2e_validation.py --url http://localhost:8000 \
        --document-type mgl_png_form --ocr-engine rapidocr --signature-model yolo11n
"""

import argparse
from pathlib import Path

import requests

VALID_EXTENSIONS = {".png", ".jpg", ".jpeg", ".pdf"}


def _files_in(folder: Path) -> list[Path]:
    return sorted(p for p in folder.iterdir() if p.suffix.lower() in VALID_EXTENSIONS)


def _content_type(path: Path) -> str:
    return "application/pdf" if path.suffix.lower() == ".pdf" else f"image/{path.suffix.lstrip('.').lower()}"


def run(url: str, document_type: str, ocr_engine: str, signature_model: str) -> None:
    root = Path(__file__).parent
    samples = [(p, True) for p in _files_in(root / "signed")] + [(p, False) for p in _files_in(root / "unsigned")]
    if not samples:
        raise SystemExit("No files found in validation/signed/ or validation/unsigned/")

    tp = fp = tn = fn = 0
    latencies = []

    for path, expected_signed in samples:
        with open(path, "rb") as f:
            response = requests.post(
                f"{url}/extract",
                files={"file": (path.name, f, _content_type(path))},
                data={
                    "document_type": document_type,
                    "ocr_engine": ocr_engine,
                    "signature_model": signature_model,
                },
                timeout=30,
            )
        response.raise_for_status()
        body = response.json()
        # "Is this document signed" means the applicant's own signature specifically —
        # the DMA/office-use signature is a staff sign-off added later, unrelated to
        # whether the customer signed. Falls back to whatever zone is present (e.g.
        # "signature_0") for a document_type with no named "applicant" zone.
        signatures = body["signatures"]
        applicant = signatures.get("applicant") or next(iter(signatures.values()), None)
        predicted_signed = bool(applicant and applicant["present"])
        latencies.append(body["timing_ms"]["total_ms"])

        if expected_signed and predicted_signed:
            tp += 1
        elif expected_signed and not predicted_signed:
            fn += 1
        elif not expected_signed and predicted_signed:
            fp += 1
        else:
            tn += 1

        status = "OK" if predicted_signed == expected_signed else "MISS"
        print(f"[{status}] {path.name}: expected={expected_signed} predicted={predicted_signed}")

    total = tp + fp + tn + fn
    accuracy = (tp + tn) / total if total else 0.0
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    fpr = fp / (fp + tn) if (fp + tn) else 0.0
    fnr = fn / (fn + tp) if (fn + tp) else 0.0
    avg_latency = sum(latencies) / len(latencies) if latencies else 0.0

    print("\n--- Summary ---")
    print(f"n={total}  tp={tp} fp={fp} tn={tn} fn={fn}")
    print(f"accuracy={accuracy:.3f} precision={precision:.3f} recall={recall:.3f} f1={f1:.3f}")
    print(f"false_positive_rate={fpr:.3f} false_negative_rate={fnr:.3f}")
    print(f"avg_total_latency_ms={avg_latency:.1f}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://localhost:8000")
    parser.add_argument("--document-type", default="mgl_png_form")
    parser.add_argument("--ocr-engine", default="rapidocr", choices=["rapidocr", "trocr", "hybrid"])
    parser.add_argument("--signature-model", default="yolo11n", choices=["yolo11n", "yolo11s"])
    args = parser.parse_args()

    run(args.url, args.document_type, args.ocr_engine, args.signature_model)
