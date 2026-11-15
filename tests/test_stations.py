import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import fetch_stations as fs


def node(name, lon, lat, **tags):
    t = {"railway": "station", "name": name}
    t.update(tags)
    return {"lon": lon, "lat": lat, "tags": t}


def test_same_name_nearby_merged():
    els = [node("강남역", 127.0276, 37.4979), node("강남역", 127.0280, 37.4981)]
    assert len(fs.build_stations(els)) == 1


def test_same_name_far_apart_kept_and_suffix_removed():
    els = [node("광교역", 127.0, 37.5), node("광교역", 127.1, 37.6)]
    out = fs.build_stations(els)
    assert len(out) == 2 and out[0][2] == "광교"


def test_disused_and_nameless_skipped():
    els = [node("폐역", 127.0, 37.5, disused="yes"), {"lon": 127, "lat": 37.5, "tags": {"railway": "station"}}, node("서울역", 126.97, 37.55)]
    out = fs.build_stations(els)
    assert [s[2] for s in out] == ["서울"]
