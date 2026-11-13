#!/usr/bin/env python3
"""서울 CCTV 위치 수집 -> web/data/cctv.json (나의동네찾기, 안전 지표)

출처: 공공데이터포털 '행정안전부_CCTV정보 조회서비스' (전국CCTV표준데이터를 API로 제공)
  * 실제 응답 필드(확인됨): WGS84_LAT, WGS84_LOT(경도), INSTL_PRPS_SE_NM(설치목적), CAM_CNTOM(대수), LCTN_LOTNO_ADDR/LCTN_ROAD_NM_ADDR(주소).
    다른 표기(한글 CSV 등)도 이름 끝/일부로 찾는다.
  * 서버 필터가 된다(확인됨): cond[LCTN_ROAD_NM_ADDR::LIKE]=서울특별시 강남구. 구별로 걸러 받는다.
  * 한 번에 100건만 주므로 전체(약 38만 건)를 받으면 1시간이 넘는다.
  * JSON/XML 응답을 모두 처리한다.
  * --probe : 실제 요청을 여러 형태로 시험하고 상태·응답 앞부분을 출력한다 (주소/파라미터를 확인할 때).
  * --csv   : 포털에서 받은 표준데이터 CSV(utf-8/cp949)로 만든다 (용량이 커서 GitHub 웹 업로드는 어렵다).
점 하나는 [경도, 위도, 분류, 카메라대수]. 같은 좌표는 합친다.
분류: B 방범·안전, K 어린이보호, T 교통(단속·정보), O 그 밖.
"""
import argparse
import csv
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fetch_prices import load_env, load_regions, parse_response  # noqa: E402

URL = "https://apis.data.go.kr/1741000/cctv_info/info"
CAT_LABEL = {"B": "방범·안전", "K": "어린이보호", "T": "교통(단속·정보)", "O": "그 밖"}


def find(item, *subs):
    """키 이름에 subs 중 하나가 들어 있는 첫 값을 돌려준다 (대소문자 무시)."""
    for k, v in item.items():
        lk = str(k).lower()
        if any(s in lk for s in subs) and v not in ("", None):
            return v
    return ""


def find_end(item, *suffixes):
    """키 이름이 suffixes 중 하나로 '끝나는' 첫 값. (LCTN_LOTNO_ADDR 같은 키와 WGS84_LOT 를 구분하려고 쓴다)"""
    for k, v in item.items():
        lk = str(k).lower()
        if any(lk.endswith(s) for s in suffixes) and v not in ("", None):
            return v
    return ""


def camera_count(item):
    """카메라 대수: CAM_CNTOM(실제 응답), '대수', cmrCnt 등. 화소수·보관일수 같은 *_CNT 는 제외."""
    for k, v in item.items():
        lk = str(k).lower()
        if v in ("", None) or "pixel" in lk or "day" in lk or "화소" in lk or "일수" in lk:
            continue
        if "cntom" in lk or "대수" in lk or lk.endswith("cnt") or lk.endswith("count"):
            return v
    return ""


def classify(purpose):
    p = str(purpose)
    if "어린이" in p or "보호구역" in p:
        return "K"
    if "방범" in p or "범죄" in p or "안전" in p or "재난" in p:
        return "B"
    if "교통" in p or "주정차" in p or "과속" in p or "단속" in p:
        return "T"
    return "O"


def to_point(item, active_gu):
    """원시 item -> [lng, lat, 분류, 대수] 또는 None. 주소에 서울+활성 구가 있어야 한다."""
    addr = " ".join(str(v) for k, v in item.items() if "adr" in str(k).lower() or "주소" in str(k) or "addr" in str(k).lower())
    if "서울" not in addr or not any(g in addr for g in active_gu):
        return None
    try:
        lat = float(find_end(item, "lat", "위도", "latitude"))
        lng = float(find_end(item, "lot", "lon", "lng", "longitude", "경도"))      # 실제 응답: WGS84_LAT / WGS84_LOT
    except ValueError:
        return None
    if not (126.7 < lng < 127.3 and 37.4 < lat < 37.8):
        return None
    try:
        n = max(1, int(float(str(camera_count(item) or 1).replace(",", ""))))
    except ValueError:
        n = 1
    return [round(lng, 5), round(lat, 5), classify(find(item, "목적", "purp", "prps")), n]


def parse_any(text):
    """XML이면 parse_response, JSON이면 안에서 dict 리스트와 totalCount를 찾는다. -> (code, total, items)"""
    t = text.lstrip()
    if not t.startswith(("{", "[")):
        return parse_response(text)
    data = json.loads(t)
    items, total, code = [], 0, "00"

    def walk(o):
        nonlocal items, total, code
        if isinstance(o, dict):
            for k, v in o.items():
                lk = k.lower()
                if lk == "totalcount":
                    try: total = int(v)
                    except (TypeError, ValueError): pass
                elif lk == "resultcode":
                    code = str(v)
                elif isinstance(v, list) and v and isinstance(v[0], dict) and not items:
                    items = v
                else:
                    walk(v)
        elif isinstance(o, list) and o and isinstance(o[0], dict) and not items:
            items = o
    walk(data)
    return code, total or len(items), items


def fetch_all(session, key, url=URL, rows=1000, retries=3, active_gu=None, max_pages=5000, verbose=True, cond=None, seen_ids=None):
    """끝까지 받으면서 곧바로 서울 활성 구만 걸러 메모리를 아낀다. 서버 페이지 크기가 달라도 totalCount 로 끝낸다."""
    pts, seen, page = [], 0, 1
    while page <= max_pages:
        params = {"serviceKey": key, "numOfRows": rows, "pageNo": page, "returnType": "JSON", **(cond or {})}
        for attempt in range(retries):
            try:
                r = session.get(url, params=params, timeout=60)
                r.raise_for_status()
                code, total, items = parse_any(r.text)
                break
            except Exception as e:
                body = getattr(locals().get("r"), "text", "")[:200]
                if attempt == retries - 1:
                    raise RuntimeError(f"페이지 {page} 실패: {e} {body}") from e
                time.sleep(1.5 * (attempt + 1))
        if code not in ("00", "000", "0"):
            raise RuntimeError(f"API 오류 코드 {code}. 인증키와 'CCTV정보 조회서비스' 활용신청 승인 상태를 확인하세요. 응답: {r.text[:200]}")
        for i in items:
            mid = find_end(i, "mng_no")
            if seen_ids is not None and mid:
                if mid in seen_ids:
                    continue
                seen_ids.add(mid)
            p = to_point(i, active_gu)
            if p:
                pts.append(p)
        seen += len(items)
        if verbose and (page <= 3 or page % 25 == 0):
            print(f"  페이지 {page}: {len(items)}건 (누적 {seen}/{total}, 서울 활성 구 {len(pts)}건) {time.strftime('%H:%M:%S')}", flush=True)
        if not items or seen >= total:
            break
        page += 1
        time.sleep(0.1)
    return pts, seen


def fetch_regions(session, key, url, gus, rows=1000, **kw):
    """구마다 '주소에 구 이름이 들어간' CCTV만 서버에서 걸러 받는다 (전체 38만 건은 100건씩이라 1시간 넘게 걸림).
    도로명주소·지번주소 두 조건으로 받아 관리번호로 중복을 없앤다. 필터 형식: cond[필드::LIKE]=값"""
    pts, seen_total, ids = [], 0, set()
    for gu in gus:
        for field in ("LCTN_ROAD_NM_ADDR", "LCTN_LOTNO_ADDR"):
            cond = {f"cond[{field}::LIKE]": f"서울특별시 {gu}"}
            got, seen = fetch_all(session, key, url, rows=rows, active_gu=gus, cond=cond, seen_ids=ids, **kw)
            pts.extend(got)
            seen_total += seen
            print(f"  {gu} {field}: 응답 {seen}건 -> 누적 지점 {len(pts)}", flush=True)
    return pts, seen_total


def merge(points):
    """같은 좌표·분류는 대수를 합친다."""
    acc = {}
    for lng, lat, cat, n in points:
        k = (lng, lat, cat)
        acc[k] = acc.get(k, 0) + n
    return [[k[0], k[1], k[2], n] for k, n in acc.items()]


def read_csv(path):
    raw = Path(path).read_bytes()
    for enc in ("utf-8-sig", "cp949"):
        try:
            return list(csv.DictReader(raw.decode(enc).splitlines()))
        except UnicodeDecodeError:
            continue
    sys.exit("CSV 인코딩을 읽을 수 없습니다.")


def build(points):
    pts = merge(points)
    cams, spots = {}, {}
    for _, _, c, n in pts:
        cams[c] = cams.get(c, 0) + n
        spots[c] = spots.get(c, 0) + 1
    return {"generated_at": datetime.now().isoformat(timespec="seconds"), "source": "행정안전부 CCTV정보",
            "sample": False, "categories": CAT_LABEL, "cameras": cams, "spots": spots, "points": pts}


def probe_filters(session, key, base):
    """서버 쪽 필터(지역 조건) 파라미터가 먹는지 totalCount 로 확인한다. 전체는 약 38만 건, 한 번에 100건뿐이라 필터가 필요하다."""
    variants = [
        {}, {"OPN_ATMY_GRP_CD": "3220000"}, {"cond[OPN_ATMY_GRP_CD::EQ]": "3220000"},
        {"cond[MNG_INST_NM::LIKE]": "서울특별시 강남구"}, {"cond[MNG_INST_NM::EQ]": "서울특별시 강남구"},
        {"cond[LCTN_ROAD_NM_ADDR::LIKE]": "서울특별시 강남구"}, {"MNG_INST_NM": "서울특별시 강남구"},
    ]
    for extra in variants:
        try:
            r = session.get(base, params={"serviceKey": key, "pageNo": 1, "numOfRows": 2, "returnType": "JSON", **extra}, timeout=40)
            code, total, items = parse_any(r.text)
            first = (items[0].get("MNG_INST_NM"), items[0].get("OPN_ATMY_GRP_CD")) if items else None
            print(f"[{r.status_code}] {extra or '(필터 없음)'} -> total={total} 첫행={first}")
        except Exception as e:
            print(f"[ERR] {extra}: {e}")


def probe(session, key, base):
    """주소/파라미터를 모를 때: 여러 후보를 시험해 상태와 응답 앞부분을 보여 준다."""
    root = base.rsplit("/", 1)[0]
    for url in dict.fromkeys([base, root, root + "/getCctvInfo", root + "/cctv", root + "/list"]):
        for extra in ({}, {"returnType": "JSON"}, {"type": "json"}):
            try:
                r = session.get(url, params={"serviceKey": key, "pageNo": 1, "numOfRows": 2, **extra}, timeout=40)
                print(f"[{r.status_code}] {url} {extra or ''}\n   {r.text[:(1800 if r.status_code == 200 else 300)]!r}")
            except Exception as e:
                print(f"[ERR] {url} {extra or ''}: {e}")


def main():
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default=URL)
    ap.add_argument("--csv")
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--max-pages", type=int, default=5000, help="시험용: 앞쪽 몇 페이지만 받는다")
    ap.add_argument("--rows", type=int, default=1000)
    ap.add_argument("--out", default=str(root / "web" / "data" / "cctv.json"))
    args = ap.parse_args()
    active, _ = load_regions(root)
    import requests
    if args.csv:
        pts = [p for p in (to_point(i, active) for i in read_csv(args.csv)) if p]
        seen = len(pts)
    else:
        load_env(root / ".env")
        key = os.getenv("PUBLIC_DATA_API_KEY")
        if not key:
            sys.exit(".env 에 PUBLIC_DATA_API_KEY 를 설정하세요.")
        s = requests.Session()
        if args.probe:
            probe_filters(s, key, args.url)
            return probe(s, key, args.url)
        pts, seen = fetch_regions(s, key, args.url, active, rows=args.rows, max_pages=args.max_pages)
    print(f"전체 {seen}건 확인, 활성 구 {len(pts)}건")
    out = build(pts)
    if not out["points"]:
        sys.exit("활성 구의 CCTV가 0건입니다. 응답 필드(주소/위도/경도/설치목적/대수)를 --probe 로 확인하세요. 파일은 갱신하지 않았습니다.")
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"완료: 지점 {len(out['points'])}곳, 카메라 {out['cameras']} -> {args.out}")


if __name__ == "__main__":
    main()
