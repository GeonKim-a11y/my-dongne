#!/usr/bin/env python3
"""서울 의료기관 위치(병원·의원·치과·한의원) 수집 -> web/data/hospitals.json (나의동네찾기)

출처: 공공데이터포털 '건강보험심사평가원_병원정보서비스' (getHospBasisList)
  * 이 API는 실거래가 API와 별개로 공공데이터포털에서 '활용신청'을 해야 한다.
  * 서울 전체(sidoCd=110000)를 받은 뒤, 응답의 시군구명이 활성 구인 것만 남긴다.
  * 응답 필드명은 대소문자가 문서마다 달라서(XPos/xPos) 대소문자 구분 없이 찾는다.

사용: python scripts/fetch_hospitals.py            (.env 의 PUBLIC_DATA_API_KEY 사용)
"""
import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_prices import load_env, load_regions, parse_response  # noqa: E402

URL = "https://apis.data.go.kr/B551182/hospInfoServicev2/getHospBasisList"
# 약국정보서비스 (별도 활용신청 필요). 함수 이름의 Parmacy 철자는 원래 API 이름 그대로다.
PHARMACY_URL = "https://apis.data.go.kr/B551182/pharmacyInfoService/getParmacyBasisList"
SEOUL = "110000"

# 종별코드 -> 우리 분류. 분류에 없는 코드(보건소 등)는 버린다.
CAT_OF = {
    "01": "H", "11": "H", "21": "H", "28": "H", "29": "H",   # 상급종합, 종합병원, 병원, 요양병원, 정신병원
    "31": "C",                                               # 의원
    "41": "D", "51": "D",                                    # 치과병원, 치과의원
    "92": "K", "93": "K",                                    # 한방병원, 한의원
    "81": "P",                                               # 약국 (약국정보서비스)
}
CAT_LABEL = {"H": "병원급(종합병원·병원·요양병원)", "C": "의원", "D": "치과", "K": "한의원·한방병원", "P": "약국"}


def pick(item, name):
    """대소문자를 가리지 않고 item 에서 값을 꺼낸다."""
    low = name.lower()
    for k, v in item.items():
        if k.lower() == low:
            return v
    return ""


def to_point(item, active_gu, force_cat=None):
    """원시 item -> [lng, lat, 분류, 이름] 또는 None."""
    gu = pick(item, "sgguCdNm")
    cat = force_cat or CAT_OF.get(pick(item, "clCd"))
    if gu not in active_gu or not cat:
        return None
    try:
        lng, lat = float(pick(item, "XPos")), float(pick(item, "YPos"))
    except ValueError:
        return None
    if not (126.7 < lng < 127.3 and 37.4 < lat < 37.8):   # 서울 밖/잘못된 좌표 제거
        return None
    return [round(lng, 5), round(lat, 5), cat, pick(item, "yadmNm")]


def fetch_all(session, key, url=URL, rows=1000, retries=3, extra=None):
    """서울 전체 목록을 끝까지 받는다. 서버가 한 번에 주는 개수가 달라도 totalCount 로 끝을 판단한다."""
    out, page = [], 1
    while True:
        params = {"serviceKey": key, "numOfRows": rows, "pageNo": page, **({"sidoCd": SEOUL} if extra is None else extra)}
        for attempt in range(retries):
            try:
                r = session.get(url, params=params, timeout=60)
                r.raise_for_status()
                code, total, items = parse_response(r.text)
                break
            except Exception as e:
                if attempt == retries - 1:
                    raise RuntimeError(f"페이지 {page} 실패: {e}") from e
                time.sleep(1.5 * (attempt + 1))
        if code not in ("00", "000"):
            raise RuntimeError(f"API 오류 코드 {code}. 인증키와 '병원정보서비스' 활용신청 승인 상태를 확인하세요.")
        out.extend(items)
        if not items or len(out) >= total:
            return out
        page += 1
        time.sleep(0.2)


def build(items, active_gu, force_cat=None):
    pts = [p for p in (to_point(i, set(active_gu), force_cat) for i in items) if p]
    counts = {}
    for p in pts:
        counts[p[2]] = counts.get(p[2], 0) + 1
    return {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "source": "건강보험심사평가원 병원정보서비스",
        "sample": False,
        "categories": CAT_LABEL,
        "counts": counts,
        "points": pts,
    }


def main():
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=URL)
    ap.add_argument("--pharmacy-url", default=PHARMACY_URL)
    ap.add_argument("--no-pharmacy", action="store_true")
    ap.add_argument("--out", default=str(root / "web" / "data" / "hospitals.json"))
    args = ap.parse_args()
    load_env(root / ".env")
    key = os.getenv("PUBLIC_DATA_API_KEY")
    if not key:
        sys.exit(".env 에 PUBLIC_DATA_API_KEY 를 설정하세요.")
    active, _ = load_regions(root)
    import requests
    sess = requests.Session()
    items = fetch_all(sess, key, args.url)
    print(f"서울 전체 {len(items)}건 수신")
    kinds = {}
    for i in items:   # 종별코드 확인용: 코드 -> (이름, 건수)
        k = pick(i, "clCd")
        n, c = kinds.get(k, (pick(i, "clCdNm"), 0))
        kinds[k] = (n, c + 1)
    print("종별코드:", ", ".join(f"{k}={n}({c})" for k, (n, c) in sorted(kinds.items())))
    out = build(items, active)
    if not args.no_pharmacy:
        # 약국은 별도 API(활용신청 필요). 실패해도 병원 데이터는 저장하고, 이전에 받아 둔 약국이 있으면 그대로 둔다.
        try:
            ph = fetch_all(sess, key, args.pharmacy_url)
            print(f"약국 서울 전체 {len(ph)}건 수신")
            pp = build(ph, active, force_cat="P")["points"]
            if not pp:
                raise RuntimeError("활성 구의 약국이 0건")
        except Exception as e:
            print(f"[경고] 약국 수집 실패: {e}")
            pp = []
            old = Path(args.out)
            if old.exists():
                pp = [p for p in json.loads(old.read_text(encoding="utf-8")).get("points", []) if p[2] == "P"]
                print(f"       이전 약국 {len(pp)}곳을 유지합니다.")
        out["points"] += pp
        out["counts"] = {}
        for p in out["points"]:
            out["counts"][p[2]] = out["counts"].get(p[2], 0) + 1
    if not [p for p in out["points"] if p[2] != "P"]:
        sys.exit("활성 구에 해당하는 의료기관이 0건입니다. 응답 필드(sgguCdNm, clCd, XPos, YPos)를 확인하세요. 파일은 갱신하지 않았습니다.")
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"완료: {len(out['points'])}곳 {out['counts']} -> {args.out}")


if __name__ == "__main__":
    main()
