"""행정동 경계 GeoJSON에서 활성 구만 골라 웹용 경계 파일을 만든다.

실거래가 API는 '법정동' 단위, 경계 데이터는 '행정동' 단위라서 둘을 이어 주는 매핑이 필요하다.
  1) 숫자·가·본동 등을 떼면 이름이 같은 경우  -> 자동 매핑 (exact)
  2) 아래 MANUAL 표에 적은 경우              -> 근사 매핑 (approx)
  3) 그 외                                  -> 매핑 없음 (지도에서 회색)
정확한 방법(아파트 주소를 지오코딩해 행정동에 배정)으로 바꾸기 전까지의 임시 방법이다.

사용: python scripts/build_boundary.py <행정동 geojson 경로>   (구 외곽선 생성에 shapely 필요: pip install shapely)
경계 원본: https://github.com/vuski/admdongkor (HangJeongDong_ver20260701.geojson)
"""
import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# (구, 행정동) -> 법정동. 행정동 하나가 여러 법정동에 걸치면 가장 큰 쪽으로 근사한 값이다.
MANUAL = {
    ("성동구", "왕십리2동"): "하왕십리동",
    ("성동구", "왕십리도선동"): "도선동",
    ("성동구", "금호1가동"): "금호동1가",
    ("성동구", "금호2·3가동"): "금호동2가",
    ("성동구", "금호4가동"): "금호동4가",
    ("성동구", "성수1가1동"): "성수동1가",
    ("성동구", "성수1가2동"): "성수동1가",
    ("성동구", "성수2가1동"): "성수동2가",
    ("성동구", "성수2가3동"): "성수동2가",
    ("노원구", "중계본동"): "중계동",
    ("강남구", "일원본동"): "일원동",
    ("송파구", "가락본동"): "가락동",
    ("송파구", "잠실본동"): "잠실동",
    ("송파구", "오륜동"): "방이동",
}
# 관악구: 행정동 19개가 법정동 3개(봉천동·신림동·남현동)에 속한다.
for h in ["청림동", "행운동", "낙성대동", "중앙동", "인헌동", "은천동", "성현동", "청룡동"]:
    MANUAL[("관악구", h)] = "봉천동"
for h in ["보라매동", "서원동", "신원동", "서림동", "신사동", "난향동", "조원동", "대학동", "삼성동", "미성동", "난곡동"]:
    MANUAL[("관악구", h)] = "신림동"


def strip_num(name):
    """'상계10동' -> '상계동', '망원1동' -> '망원동'"""
    return re.sub(r"\d+(·\d+)*", "", name)


def match_legal(gu, hdong, legal_names):
    """행정동 이름에 대응하는 (법정동, 'exact'|'approx') 또는 (None, None)."""
    if hdong in legal_names:
        return hdong, "exact"
    s = strip_num(hdong)
    if s in legal_names:
        return s, "exact"
    m = MANUAL.get((gu, hdong))
    if m and m in legal_names:
        return m, "approx"
    return None, None


def round_coords(c, nd=4):
    if isinstance(c[0], (int, float)):
        return [round(c[0], nd), round(c[1], nd)]
    out = [round_coords(x, nd) for x in c]
    if out and isinstance(out[0][0], list) is False:  # 링: 연속 중복 점 제거
        dedup = [out[0]]
        for p in out[1:]:
            if p != dedup[-1]:
                dedup.append(p)
        return dedup
    return out


def build(src_geojson, regions, market):
    gus = regions["active_gu"]
    legal = {}
    for d in market["dongs"]:
        legal.setdefault(d["gu"], set()).add(d["dong"])
    feats = []
    for f in src_geojson["features"]:
        p = f["properties"]
        if p.get("sido") != "11" or p.get("sggnm") not in gus:
            continue
        gu = p["sggnm"]
        hdong = p["adm_nm"].split()[-1]
        ld, kind = match_legal(gu, hdong, legal.get(gu, set()))
        feats.append({
            "type": "Feature",
            "properties": {"gu": gu, "hdong": hdong, "legal": ld, "match": kind},
            "geometry": {"type": f["geometry"]["type"], "coordinates": round_coords(f["geometry"]["coordinates"])},
        })
    return {"type": "FeatureCollection", "features": feats}


def build_outline(src_geojson, regions, tol=0.0004):
    """서울 25개 구 외곽선(구별로 합친 것)과, 서울 밖을 가리는 마스크를 만든다. shapely가 필요하다(이 파일을 만들 때만)."""
    from shapely.geometry import shape, mapping
    from shapely.ops import unary_union

    active = set(regions["active_gu"])
    by_gu = {}
    for f in src_geojson["features"]:
        p = f["properties"]
        if p.get("sido") == "11":
            by_gu.setdefault(p["sggnm"], []).append(shape(f["geometry"]).buffer(0))
    feats, merged = [], []
    for gu, geoms in sorted(by_gu.items()):
        g = unary_union(geoms).simplify(tol)
        merged.append(g)
        feats.append({"type": "Feature", "properties": {"gu": gu, "active": gu in active, "kind": "gu"},
                      "geometry": json.loads(json.dumps(mapping(g)))})
    seoul = unary_union(merged)
    parts = list(seoul.geoms) if seoul.geom_type == "MultiPolygon" else [seoul]
    holes = [[[round(x, 4), round(y, 4)] for x, y in part.exterior.coords] for part in parts]
    world = [[124.0, 32.5], [132.0, 32.5], [132.0, 40.0], [124.0, 40.0], [124.0, 32.5]]
    feats.append({"type": "Feature", "properties": {"kind": "mask"},
                  "geometry": {"type": "Polygon", "coordinates": [world] + holes}})
    for f in feats:
        if f["properties"]["kind"] == "gu":
            f["geometry"]["coordinates"] = round_coords(f["geometry"]["coordinates"])
    return {"type": "FeatureCollection", "features": feats}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("--out", default=str(ROOT / "web/data/dong_boundary.json"))
    ap.add_argument("--outline-out", default=str(ROOT / "web/data/seoul_outline.json"))
    ap.add_argument("--market", default=str(ROOT / "web/data/market_by_dong.json"))
    a = ap.parse_args()
    regions = json.loads((ROOT / "config/regions.json").read_text(encoding="utf-8"))
    market = json.loads(Path(a.market).read_text(encoding="utf-8"))
    src = json.loads(Path(a.src).read_text(encoding="utf-8"))
    out = build(src, regions, market)
    Path(a.out).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    n = len(out["features"])
    ex = sum(1 for f in out["features"] if f["properties"]["match"] == "exact")
    ap_ = sum(1 for f in out["features"] if f["properties"]["match"] == "approx")
    outline = build_outline(src, regions)
    Path(a.outline_out).write_text(json.dumps(outline, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"구 외곽선 {len(outline['features']) - 1}개 + 서울 밖 마스크 -> {a.outline_out}")
    print(f"행정동 {n}개: 정확 매핑 {ex}, 근사 매핑 {ap_}, 매핑 없음 {n - ex - ap_} -> {a.out}")


if __name__ == "__main__":
    main()
