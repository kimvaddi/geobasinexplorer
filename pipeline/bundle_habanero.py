"""Builds the Habanero 1 archive pinned by the live source registry (peps-sa-habanero-1).

The six PDFs come unchanged from the checksum-verified data bundle; the four downhole diagrams are lifted out of
Habanero_001_DownholeDiagram.zip because the live pipeline accepts PDF members only. Stored (uncompressed) members,
a fixed order, fixed timestamps and fixed permissions make the output byte-for-byte repeatable on any machine.

    python3 pipeline/bundle_habanero.py <bundle>/source/wells/peps-sa-habanero-1 source-data/peps-sa-habanero-1/habanero-1-pdfs.zip
"""
import hashlib
import sys
import zipfile
from pathlib import Path

STANDALONE = ("habanero_1_multi_finger_cali_report.pdf", "habanero_1_pts_23sept2005_presstemp.pdf")


def members(source: Path) -> list[tuple[str, bytes]]:
    found = []
    with zipfile.ZipFile(source / "Habanero_001_DownholeDiagram.zip") as archive:
        for name in sorted(archive.namelist()):
            if name.lower().endswith(".pdf"):
                found.append((Path(name).name, archive.read(name)))
    found += [(name, (source / name).read_bytes()) for name in STANDALONE]
    if len(found) != 6 or any(not data.startswith(b"%PDF-") for _, data in found):
        raise SystemExit("Expected six PDFs from the Habanero 1 bundle files.")
    return found


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    source, output = Path(sys.argv[1]), Path(sys.argv[2])
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "w", zipfile.ZIP_STORED) as archive:
        for name, data in members(source):
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.external_attr = 0o644 << 16
            archive.writestr(info, data)
    print(hashlib.sha256(output.read_bytes()).hexdigest(), output)


if __name__ == "__main__":
    main()
