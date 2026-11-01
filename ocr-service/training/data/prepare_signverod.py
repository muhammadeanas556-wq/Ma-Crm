"""Convert SignverOD into a YOLO detection dataset containing only the `signature`
class (SignverOD also has `initials`, `redaction`, `date` — dropped here, since this
project only needs signature presence/location).

SignverOD (Victor Dibia, 2021): 2765 document images, released on Kaggle as
`victordibia/signverod`. The actual downloaded archive layout (verified against a real
download) is:

    categories.csv   - id,name                      (1=signature, 2=initials, 3=redaction, 4=date)
    image_ids.csv    - height,width,id,file_name     (id here = the "image_id" used below)
    train.csv        - area,bbox,category_id,id,image_id   (official 2565-image train split)
    test.csv         - area,bbox,category_id,id,image_id   (official 200-image test split)
    images/<file_name>
    labelmap.txt     - redundant with categories.csv, ignored
    tfrecords/...    - alternate format, ignored

`bbox` is a normalized `[xmin, ymin, w, h]` list stored as a string (`area` == w*h,
confirmed against real rows) — already directly convertible to YOLO's
`[x_center, y_center, w, h]` without needing image pixel dimensions.

Reads directly out of the zip (no need to extract ~1.5GB to disk first).

Usage:
    python training/data/prepare_signverod.py --zip "archive (1).zip" --output training/data/signverod_yolo
    # or, from an already-unzipped folder:
    python training/data/prepare_signverod.py --input training/data/signverod_raw --output training/data/signverod_yolo
"""

import argparse
import ast
import csv
import io
import random
import zipfile
from pathlib import Path

TARGET_CLASS = "signature"


class ZipSource:
    def __init__(self, zip_path: Path):
        self._zip = zipfile.ZipFile(zip_path)

    def read_text(self, name: str) -> str:
        with self._zip.open(name) as f:
            return f.read().decode("utf-8", errors="replace")

    def read_image_bytes(self, file_name: str) -> bytes:
        with self._zip.open(f"images/{file_name}") as f:
            return f.read()


class DirSource:
    def __init__(self, root: Path):
        self._root = root

    def read_text(self, name: str) -> str:
        return (self._root / name).read_text(encoding="utf-8", errors="replace")

    def read_image_bytes(self, file_name: str) -> bytes:
        return (self._root / "images" / file_name).read_bytes()


def _read_csv_rows(source, name: str) -> list[dict]:
    return list(csv.DictReader(io.StringIO(source.read_text(name))))


def _signature_category_id(source) -> str:
    rows = _read_csv_rows(source, "categories.csv")
    for row in rows:
        if row["name"].strip().lower() == TARGET_CLASS:
            return row["id"]
    raise RuntimeError("No 'signature' category found in categories.csv")


def _load_image_index(source) -> dict[str, str]:
    """image_id -> file_name.

    image_ids.csv is, in the real download, two concatenated id sequences that both
    restart counting from 1 (verified: the "id" column is monotonically increasing,
    drops back to 1 exactly once, part way through the file). Only the first sequence
    is the one train.csv/test.csv actually reference (their image_id ranges fit
    entirely inside it) — the second sequence's rows use disjoint filenames and are
    never referenced by any annotation row. Keeping the FIRST occurrence per id (via
    setdefault, not a plain dict comprehension) is required, or every duplicated id
    silently resolves to the wrong image from the second, unrelated sequence.
    """
    rows = _read_csv_rows(source, "image_ids.csv")
    index: dict[str, str] = {}
    for row in rows:
        index.setdefault(row["id"], row["file_name"])
    return index


def _load_signature_boxes(source, csv_name: str, signature_category_id: str) -> dict[str, list[tuple[float, float, float, float]]]:
    """image_id -> list of YOLO (x_center, y_center, w, h), signature class only."""
    rows = _read_csv_rows(source, csv_name)
    boxes_by_image: dict[str, list[tuple[float, float, float, float]]] = {}
    for row in rows:
        image_id = row["image_id"]
        boxes_by_image.setdefault(image_id, [])
        if row["category_id"] != signature_category_id:
            continue
        xmin, ymin, w, h = ast.literal_eval(row["bbox"])
        x_center, y_center = xmin + w / 2, ymin + h / 2
        boxes_by_image[image_id].append((x_center, y_center, w, h))
    return boxes_by_image


def _write_split(source, output: Path, split: str, image_ids: list[str], image_index: dict[str, str], boxes_by_image: dict) -> int:
    images_dir = output / "images" / split
    labels_dir = output / "labels" / split
    images_dir.mkdir(parents=True, exist_ok=True)
    labels_dir.mkdir(parents=True, exist_ok=True)

    written = 0
    for image_id in image_ids:
        file_name = image_index.get(image_id)
        if file_name is None:
            continue
        try:
            image_bytes = source.read_image_bytes(file_name)
        except (KeyError, OSError):
            continue

        (images_dir / file_name).write_bytes(image_bytes)
        label_path = labels_dir / (Path(file_name).stem + ".txt")
        boxes = boxes_by_image.get(image_id, [])
        with open(label_path, "w", encoding="utf-8") as f:
            for x_c, y_c, w, h in boxes:
                f.write(f"0 {x_c:.6f} {y_c:.6f} {w:.6f} {h:.6f}\n")
        written += 1
    return written


def convert(source, output: Path, val_fraction: float = 0.15) -> None:
    signature_category_id = _signature_category_id(source)
    image_index = _load_image_index(source)

    train_boxes = _load_signature_boxes(source, "train.csv", signature_category_id)
    test_boxes = _load_signature_boxes(source, "test.csv", signature_category_id)

    # A small number of image_ids appear in both train.csv and test.csv (verified against
    # the real download). Drop those from the train pool so the held-out test split stays
    # uncontaminated — test.csv is treated as authoritative for those images.
    test_ids = list(test_boxes.keys())
    test_id_set = set(test_ids)
    train_pool = [image_id for image_id in train_boxes if image_id not in test_id_set]
    n_dropped_for_leakage = len(train_boxes) - len(train_pool)
    if n_dropped_for_leakage:
        print(f"Dropped {n_dropped_for_leakage} image(s) from train (also present in test.csv)")

    random.Random(42).shuffle(train_pool)
    n_val = int(len(train_pool) * val_fraction)
    val_ids = train_pool[:n_val]
    train_ids = train_pool[n_val:]

    n_train = _write_split(source, output, "train", train_ids, image_index, train_boxes)
    n_val_written = _write_split(source, output, "val", val_ids, image_index, train_boxes)
    n_test = _write_split(source, output, "test", test_ids, image_index, test_boxes)

    yaml_path = output / "signature.yaml"
    with open(yaml_path, "w", encoding="utf-8") as f:
        f.write(
            f"path: {output.resolve()}\n"
            "train: images/train\n"
            "val: images/val\n"
            "test: images/test\n"
            "names:\n"
            "  0: signature\n"
        )

    n_with_signature = sum(1 for boxes in {**train_boxes, **test_boxes}.values() if boxes)
    print(f"train={n_train} val={n_val_written} test={n_test} (images with >=1 signature box: {n_with_signature})")
    print(f"Dataset config: {yaml_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--zip", default=None, help="Path to the downloaded SignverOD .zip")
    parser.add_argument("--input", default=None, help="Path to an already-unzipped SignverOD folder")
    parser.add_argument("--output", default="training/data/signverod_yolo")
    args = parser.parse_args()

    if not args.zip and not args.input:
        parser.error("pass either --zip or --input")

    dataset_source = ZipSource(Path(args.zip)) if args.zip else DirSource(Path(args.input))
    convert(dataset_source, Path(args.output))
