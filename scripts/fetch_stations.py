"""서울과 그 주변 지하철·전철역 위치를 OpenStreetMap(Overpass API)에서 받아 web/data/stations.json 으로 저장한다.
키가 필요 없다. 같은 역의 승강장·출입구가 여러 점으로 오므로 같은 이름이 300m 안에 있으면 한 역으로 합친다.
"""
import argparse
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
# 서울 + 경계 밖 가까운 역까지 (남, 서, 북, 동)
BBOX = "37.40,126.74,37.73,127.21"
QUERY = f"""[out:json][timeout:90];
(
  node["railway"="station"]["station"="subway"]({BBOX});
  node["railway"="station"]["subway"="yes"]({BBOX});
  node["railway"="station"]["network"~"수도권|Seoul|서울"]({BBOX});
);
out body;"""


def clean_name(name):
    n = (name or "").strip()
    return n[:-1] if n.endswith("역") and len(n) > 2 else n


def dist_m(lng1, lat1, lng2, lat2):
    r = 6371008.8
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lng2 - lng1) / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def build_stations(elements, merge_m=300):
    """Overpass 노드 목록 -> [[lng, lat, 이름]]. 폐역·건설중은 제외하고, 같은 이름이 merge_m 안에 있으면 합친다."""
    groups = []
    for e in elements:
        t = e.get("tags") or {}
        name = clean_name(t.get("name:ko") or t.get("name"))
        if not name or "lat" not in e or "lon" not in e:
            continue
        if any(k in t for k in ("disused", "abandoned", "construction", "proposed")) or t.get("railway") != "station":
            continue
        for g in groups:
            if g["name"] == name and dist_m(g["lng"], g["lat"], e["lon"], e["lat"]) <= merge_m:
                g["pts"].append((e["lon"], e["lat"]))
                break
        else:
            groups.append({"name": name, "lng": e["lon"], "lat": e["lat"], "pts": [(e["lon"], e["lat"])]})
    out = []
    for g in groups:
        lng = sum(p[0] for p in g["pts"]) / len(g["pts"])
        lat = sum(p[1] for p in g["pts"]) / len(g["pts"])
        out.append([round(lng, 6), round(lat, 6), g["name"]])
    out.sort(key=lambda s: (s[2], s[0]))
    return out


def fetch():
    body = urllib.parse.urlencode({"data": QUERY}).encode()
    last = None
    for attempt in range(2):
        for url in ENDPOINTS:
            try:
                req = urllib.request.Request(url, data=body, headers={"User-Agent": "my-dongne/1.0 (student project)"})
                with urllib.request.urlopen(req, timeout=120) as r:
                    return json.load(r)["elements"]
            except Exception as ex:  # 다음 서버로
                last = ex
                print(f"{url} 실패: {ex}", file=sys.stderr)
        time.sleep(10)
    raise SystemExit(f"Overpass 호출 실패: {last}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="web/data/stations.json")
    args = ap.parse_args()
    stations = build_stations(fetch())
    if len(stations) < 200:
        raise SystemExit(f"역이 {len(stations)}개뿐이라 비정상입니다. 저장하지 않습니다.")
    Path(args.out).write_text(json.dumps({
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "source": "OpenStreetMap contributors (ODbL)",
        "points": stations,
    }, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"역 {len(stations)}개 저장")


if __name__ == "__main__":
    main()
