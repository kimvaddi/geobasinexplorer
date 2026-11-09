"""Run the GeoBasin producers and write contract-shaped dataset folders.

    python -m producers --out build/landing                 run every producer
    python -m producers --out build/landing --only wsm kit  run a subset
"""
from __future__ import annotations

import argparse
import importlib
import json
import logging
import shutil
import sys
import time
from pathlib import Path

from . import PRODUCERS
from .common import Bundle

HERE = Path(__file__).resolve()
WORKSPACE = HERE.parents[3]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="python -m producers", description="Turn the GeoBasin datasets into contract-shaped dataset folders.")
    ap.add_argument("--out", type=Path, required=True, help="landing root to write dataset folders into")
    ap.add_argument("--bundle", type=Path, default=WORKSPACE / "GeoBasin_Explorer_AI_DATA_BUNDLE", help="GeoBasin data bundle root")
    ap.add_argument("--workspace", type=Path, default=WORKSPACE, help="workspace root (for the live manifest snapshot)")
    ap.add_argument("--only", nargs="*", choices=PRODUCERS, help="run only these producers")
    ap.add_argument("--verbose", action="store_true", help="log every merged duplicate id")
    ap.add_argument("--strict", action="store_true", help="fail when a producer's bundle input is missing instead of skipping it")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    if not args.verbose:
        logging.getLogger("ontology_ingest.contract").setLevel(logging.ERROR)

    from ontology_ingest.contract import DatasetWriter

    bundle = Bundle.load(args.bundle, args.workspace)
    args.out.mkdir(parents=True, exist_ok=True)
    summary = {}
    for name in args.only or PRODUCERS:
        mod = importlib.import_module(f"producers.{name}")
        target = args.out / mod.NAME
        shutil.rmtree(target, ignore_errors=True)
        t0 = time.time()
        try:
            result = mod.produce(bundle, DatasetWriter, target)
        except FileNotFoundError as missing:
            if args.strict:
                raise
            shutil.rmtree(target, ignore_errors=True)
            summary[mod.NAME] = {"skipped": f"bundle input not found: {missing.filename}"}
            print(f"{mod.NAME:28s} skipped: {missing.filename} is not in the bundle (ingestion-framework/README.md, The data bundle)")
            continue
        summary[mod.NAME] = result
        print(f"{mod.NAME:28s} {time.time() - t0:6.1f}s  {json.dumps(result, default=str)[:300]}")
    (args.out / "producers-summary.json").write_text(json.dumps(summary, indent=1, default=str, sort_keys=True), encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
