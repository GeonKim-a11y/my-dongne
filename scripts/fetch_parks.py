#!/usr/bin/env python3
"""서울 공원 위치·면적 수집 -> web/data/parks.json (나의동네찾기)

출처: 공공데이터포털 '전국도시공원정보표준데이터' (지자체 등록 데이터를 매월 합쳐 전국 단위로 제공)
두 가지 입력 방법:
  1) API  : python scripts/fetch_parks.py              (.env 의 PUBLIC_DATA_API_KEY, 활용신청 필요)
  2) 파일 : python scripts/fetch_parks.py --csv 파일.csv (포털에서 내려받은 CSV, utf-8/cp949 자동 판별)
API 주소와 응답 필드명은 문서 기준 추정이므로 --url 로 바꿀 수 있고, 필드는 한글/영문 둘 다 인식한다.
묘지공원은 '쾌적한 공원'이 아니므로 제외한다. 점 하나는 [경도, 위도, 분류, 이름, 면적(㎡)].
"""
import argparse
import csv
import json
import os
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_hospitals import fetch_all, pick  # noqa: E402
from fetch_prices import load_env, load_regions  # noqa: E402

URL = "https://api.data.go.kr/openapi/tn_pubr_public_cty_park_info_api"

# 공원구분 -> 분류. N 근린공원, S 소공원·어린이공원, O 그 밖(체육·역사·문화·수변·기타)
CAT_OF = {"근린공원": "N", "소공원": "S", "어린이공원": "S", "체육공원": "O", "역사공원": "O",
          "문화공원": "O", "수변공원": "O", "기타": "O", "도시농업공원": "O"}
CAT_LABEL = {"N": "근린공원", "S": "소공원·어린이공원", "O": "그 밖의 공원"}


def first(item, *names):
    for n in names:
        v = pick(item, n)
        if v not in ("", None):
            return v
    return ""


def to_point(item, active_gu):
    """원시 item(API 영문/CSV 한글 필드) -> [lng, lat, 분류, 이름, 면적㎡] 또는 None."""
    addr = f'{first(item, "rdnmadr", "소재지도로명주소")} {first(item, "lnmadr", "소재지지번주소")}'
    if "서울" not in addr or not any(g in addr for g in active_gu):
        return None
    kind = str(first(item, "parkSe", "공원구분")).strip()
    if "묘지" in kind:
        return None
    cat = CAT_OF.get(kind, "O")
    try:
        lat = float(first(item, "latitude", "위도"))
        lng = float(first(item, "longitude", "경도"))
        area = float(str(first(item, "parkAr", "공원면적") or 0).replace(",", ""))
    except ValueError:
        return None
    if not (126.7 < lng < 127.3 and 37.4 < lat < 37.8) or area <= 0:
        return None
    return [round(lng, 5), round(lat, 5), cat, first(item, "parkNm", "공원명"), round(area)]


def read_csv(path):
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "cp949"):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    else:
        sys.exit("CSV 인코딩을 읽을 수 없습니다 (utf-8, cp949 모두 실패).")
    return list(csv.DictReader(text.splitlines()))


def build(items, active_gu):
    seen, pts = set(), []
    for i in items:
        p = to_point(i, active_gu)
        if not p:
            continue
        key = (p[0], p[1], p[3])          # 같은 공원이 중복 등록된 경우 한 번만
        if key in seen:
            continue
        seen.add(key)
        pts.append(p)
    counts = {}
    for p in pts:
        counts[p[2]] = counts.get(p[2], 0) + 1
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "source": "전국도시공원정보표준데이터",
        "sample": False,
        "categories": CAT_LABEL,
        "counts": counts,
        "total_area_m2": sum(p[4] for p in pts),
        "points": pts,
    }


def main():
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=URL)
    ap.add_argument("--csv", help="포털에서 내려받은 CSV 파일 (API 대신 사용)")
    ap.add_argument("--out", default=str(root / "web" / "data" / "parks.json"))
    args = ap.parse_args()
    active, _ = load_regions(root)
    if args.csv:
        items = read_csv(args.csv)
    else:
        load_env(root / ".env")
        key = os.getenv("PUBLIC_DATA_API_KEY")
        if not key:
            sys.exit(".env 에 PUBLIC_DATA_API_KEY 를 설정하세요.")
        import requests
        items = fetch_all(requests.Session(), key, args.url, extra={"type": "xml"})
    print(f"전국 {len(items)}건 수신")
    out = build(items, active)
    if not out["points"]:
        sys.exit("활성 구에 해당하는 공원이 0건입니다. 필드(parkNm, parkSe, rdnmadr, latitude, longitude, parkAr)를 확인하세요. 파일은 갱신하지 않았습니다.")
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"완료: {len(out['points'])}곳, 총 {out['total_area_m2'] / 1e4:.0f}만㎡ {out['counts']} -> {args.out}")


if __name__ == "__main__":
    main()
