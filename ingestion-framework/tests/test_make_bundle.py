import importlib.util
import json
from pathlib import Path

import pytest

TOOL = Path(__file__).resolve().parents[1] / "tools" / "make_bundle.py"
spec = importlib.util.spec_from_file_location("make_bundle", TOOL)
make_bundle = importlib.util.module_from_spec(spec)
spec.loader.exec_module(make_bundle)


def test_extractions_come_from_the_packs_without_images(tmp_path):
    make_bundle.write_extractions(tmp_path)
    app = json.loads((make_bundle.DATA / "app-pack.json").read_text(encoding="utf-8"))
    wells = json.loads((tmp_path / "processed/wells/wells.json").read_text(encoding="utf-8"))
    assert len(wells) == len(app["wells"])
    for name in ("wells/velocity.json", "wells/lowcarbon-sites.json", "seismic/seismic-figures.json"):
        assert (tmp_path / "processed" / name).is_file()
    text = "".join(p.read_text(encoding="utf-8") for p in (tmp_path / "processed").rglob("*.json"))
    assert '"data:' not in text
    assert not any(f'"{key}":' in text for key in make_bundle.IMAGE_KEYS)


def test_a_file_that_is_not_the_world_stress_map_is_refused(tmp_path):
    wrong = tmp_path / "other.csv"
    wrong.write_text("id,name\n1,x\n", encoding="utf-8")
    with pytest.raises(SystemExit):
        make_bundle.add_wsm(tmp_path / "bundle", wrong)
    assert not (tmp_path / "bundle" / make_bundle.WSM).exists()
