#!/usr/bin/env python3
"""서울 아파트 매매·전월세 실거래가 -> 법정동 x 면적대별 집계 (나의동네찾기)

사용법
    1) .env 파일에 PUBLIC_DATA_API_KEY=발급받은_Decoding_키 를 적는다
    2) python scripts/fetch_prices.py --months 3            # 매매+전월세 모두
       python scripts/fetch_prices.py --kind rent --gu 노원구 --months 1   # 시험
    3) web/data/market_by_dong.json 이 생성된다

데이터 출처 (공공데이터포털, 국토교통부)
    매매   RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev
    전월세 RTMSDataSvcAptRent/getRTMSDataSvcAptRent
"""
import argparse
import json
import os
import statistics
import sys
import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import date, datetime
from pathlib import Path

ENDPOINTS = {
    "trade": "https://apis.data.go.kr/1613000/RTMSDataSvcAptTradeDev/getRTMSDataSvcAptTradeDev",
    "rent": "https://apis.data.go.kr/1613000/RTMSDataSvcAptRent/getRTMSDataSvcAptRent",
}

# 면적대: 전용면적(㎡) 기준. (키, 이름, 이상, 미만)
BANDS = [
    ("S", "소형 (60㎡ 미만)", 0, 60),
    ("M", "중형 (60~85㎡)", 60, 85),
    ("L", "중대형 (85㎡ 이상)", 85, 10**6),
]


# ---------- 입출력 보조 ----------
def load_regions(root):
    """config/regions.json -> (활성 구 목록, 전체 구 코드표)."""
    cfg = json.loads((Path(root) / "config" / "regions.json").read_text(encoding="utf-8"))
    return cfg["active_gu"], cfg["all_gu"]


def load_env(path):
    """의존성 없이 .env 한 줄씩 읽어 환경변수에 넣는다."""
    p = Path(path)
    if not p.exists():
        return
    for line in p.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def recent_months(n, today=None):
    """오늘이 속한 달 직전부터 n개월(YYYYMM). 이번 달은 신고가 덜 들어와서 제외한다."""
    today = today or date.today()
    y, m = today.year, today.month
    out = []
    for _ in range(n):
        m -= 1
        if m == 0:
            y, m = y - 1, 12
        out.append(f"{y}{m:02d}")
    return out


# ---------- API 호출 / 파싱 ----------
def parse_response(xml_text):
    """(resultCode, totalCount, items[dict]) 반환."""
    root = ET.fromstring(xml_text)
    code = (root.findtext(".//resultCode") or "").strip()
    total = int((root.findtext(".//totalCount") or "0").strip() or 0)
    items = []
    for it in root.findall(".//item"):
        items.append({c.tag: (c.text or "").strip() for c in it})
    return code, total, items


def fetch_month(session, key, url, lawd_cd, ymd, rows=1000, retries=3):
    """한 구, 한 달의 모든 거래를 페이지 끝까지 가져온다."""
    all_items, page = [], 1
    while True:
        params = {"serviceKey": key, "LAWD_CD": lawd_cd, "DEAL_YMD": ymd,
                  "numOfRows": rows, "pageNo": page}
        for attempt in range(retries):
            try:
                r = session.get(url, params=params, timeout=30)
                r.raise_for_status()
                code, total, items = parse_response(r.text)
                break
            except Exception as e:  # 네트워크/파싱 오류는 재시도
                if attempt == retries - 1:
                    raise RuntimeError(f"{lawd_cd} {ymd} p{page} 실패: {e}") from e
                time.sleep(1.5 * (attempt + 1))
        if code not in ("00", "000"):
            raise RuntimeError(f"API 오류 코드 {code} ({lawd_cd} {ymd}). 인증키/활용신청 상태를 확인하세요.")
        all_items.extend(items)
        if page * rows >= total or not items:
            return all_items
        page += 1
        time.sleep(0.2)


# ---------- 원시 item -> 분석용 레코드 ----------
def band_of(area):
    for key, _, lo, hi in BANDS:
        if lo <= area < hi:
            return key
    return None


def _num(text, default=None):
    try:
        return int(str(text).replace(",", "").strip())
    except (ValueError, TypeError):
        return default


def to_trade(item, gu):
    """매매 item -> 레코드. 해제 거래나 값이 이상하면 None."""
    if (item.get("cdealType") or "").strip():  # 'O' 이면 계약 해제
        return None
    amount = _num(item.get("dealAmount"))        # 만원
    try:
        area = float(item["excluUseAr"])          # 전용면적 ㎡
    except (KeyError, ValueError):
        return None
    dong = item.get("umdNm") or item.get("법정동")
    if not dong or not amount or amount <= 0 or area <= 0:
        return None
    return {"gu": gu, "dong": dong, "apt": item.get("aptNm", ""), "amount": amount,
            "area": area, "band": band_of(area)}


def to_rent(item, gu, new_only=True):
    """전월세 item -> 레코드. 월세 0이면 전세, 아니면 월세."""
    # 갱신 계약은 기존 가격이 이어져 시세보다 낮은 경우가 많아 기본적으로 제외 (필드가 있을 때만)
    renewal = (item.get("contractType") or "").strip() == "갱신"
    if new_only and renewal:
        return None
    deposit = _num(item.get("deposit"))            # 보증금 만원
    rent = _num(item.get("monthlyRent"), 0) or 0   # 월세 만원
    try:
        area = float(item["excluUseAr"])
    except (KeyError, ValueError):
        return None
    dong = item.get("umdNm") or item.get("법정동")
    if not dong or deposit is None or area <= 0 or (deposit == 0 and rent == 0):
        return None
    return {"gu": gu, "dong": dong, "kind": "jeonse" if rent == 0 else "wolse",
            "deposit": deposit, "rent": rent, "area": area, "band": band_of(area), "renewal": renewal}


# ---------- 집계 ----------
def pct(values, q):
    """간단한 분위수. 표본이 적으면 양끝/중앙값으로 대체."""
    s = sorted(values)
    if len(s) < 4:
        return s[0] if q < 50 else s[-1] if q > 50 else statistics.median(s)
    return statistics.quantiles(s, n=100, method="inclusive")[q - 1]


def aggregate(trades, rents, min_n=3):
    """(구, 법정동)별로 trade/jeonse/wolse x 면적대 통계를 만든다."""
    dongs = {}

    def slot(gu, dong):
        return dongs.setdefault((gu, dong), {"gu": gu, "dong": dong, "trade": {}, "jeonse": {}, "wolse": {}})

    g_trade = defaultdict(list)
    for t in trades:
        g_trade[(t["gu"], t["dong"], t["band"])].append(t["amount"])
    for (gu, dong, band), v in g_trade.items():
        slot(gu, dong)["trade"][band] = {
            "n": len(v), "median": round(statistics.median(v)),
            "p25": round(pct(v, 25)), "p75": round(pct(v, 75)), "low_sample": len(v) < min_n}

    g_jeonse, g_wolse = defaultdict(list), defaultdict(list)
    for r in rents:
        (g_jeonse if r["kind"] == "jeonse" else g_wolse)[(r["gu"], r["dong"], r["band"])].append(r)
    for (gu, dong, band), v in g_jeonse.items():
        dep = [x["deposit"] for x in v]
        slot(gu, dong)["jeonse"][band] = {
            "n": len(v), "median": round(statistics.median(dep)),
            "p25": round(pct(dep, 25)), "p75": round(pct(dep, 75)), "low_sample": len(v) < min_n}
    for (gu, dong, band), v in g_wolse.items():
        slot(gu, dong)["wolse"][band] = {
            "n": len(v),
            "median_deposit": round(statistics.median(x["deposit"] for x in v)),
            "median_rent": round(statistics.median(x["rent"] for x in v)),
            "low_sample": len(v) < min_n}
    return [dongs[k] for k in sorted(dongs)]


# ---------- 월별 캐시 (증분 수집) ----------
def cache_path(cache_dir, kind, ymd, gu):
    return Path(cache_dir) / kind / ymd / f"{gu}.json"


def get_month(cache_dir, kind, gu, ymd, refresh, fetch_fn):
    """월별 캐시를 우선 사용한다.
    - 캐시가 있고 refresh=False  -> 캐시 그대로 (API 호출 없음)
    - refresh=True               -> 다시 받아 덮어씀. 실패하면 기존 캐시로 대체
    - 캐시도 없고 호출도 실패     -> 예외 (호출한 쪽에서 처리)
    반환: (레코드 목록, 'cache' | 'fetched' | 'stale')
    """
    p = cache_path(cache_dir, kind, ymd, gu)
    cached = json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
    if cached is not None and not refresh:
        return cached, "cache"
    try:
        records = fetch_fn()
    except Exception as e:
        if cached is not None:
            print(f"  경고: {gu} {ymd} {kind} 갱신 실패, 기존 캐시를 사용합니다 ({e})")
            return cached, "stale"
        raise
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(records, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return records, "fetched"


def main():
    root = Path(__file__).resolve().parent.parent
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--kind", choices=["all", "trade", "rent"], default="all", help="수집 대상 (기본: 매매+전월세)")
    ap.add_argument("--months", type=int, default=12, help="최근 몇 개월을 모을지 (기본 12)")
    ap.add_argument("--refresh-months", type=int, default=3,
                    help="가장 최근 몇 개월은 캐시가 있어도 다시 받을지 (신고 지연 보정, 기본 3)")
    ap.add_argument("--cache-dir", default=str(root / "data" / "cache"), help="월별 수집 결과 캐시 폴더")
    ap.add_argument("--min-n", type=int, default=3, help="이 건수 미만이면 low_sample 표시")
    ap.add_argument("--include-renewal", action="store_true", help="전월세에서 갱신 계약도 포함 (기본은 신규만)")
    ap.add_argument("--gu", nargs="*", help="구를 직접 지정. 생략하면 config/regions.json 의 active_gu")
    ap.add_argument("--all", action="store_true", help="서울 25개 구 전체 수집")
    ap.add_argument("--out", default=str(root / "web" / "data" / "market_by_dong.json"))
    args = ap.parse_args()

    load_env(root / ".env")
    key = os.getenv("PUBLIC_DATA_API_KEY")
    if not key:
        sys.exit(".env 에 PUBLIC_DATA_API_KEY 를 설정하세요 (README 참고).")

    active, all_gu = load_regions(root)
    names = list(all_gu) if args.all else (args.gu or active)
    unknown = [g for g in names if g not in all_gu]
    if unknown:
        sys.exit(f"알 수 없는 구: {unknown}")

    import requests  # 지연 import: 집계 테스트는 requests 없이도 가능
    months = recent_months(args.months)               # 최신 달이 앞에 온다
    refresh_set = set(months[:args.refresh_months])
    session = requests.Session()
    trades, rents, failures = [], [], []
    stats = {"cache": 0, "fetched": 0, "stale": 0}

    def run(kind, gu, ymd, label, make_records):
        try:
            recs, how = get_month(args.cache_dir, kind, gu, ymd, ymd in refresh_set, make_records)
        except Exception as e:
            failures.append(f"{label} {gu} {ymd}: {e}")
            print(f"  실패: {label} {gu} {ymd}: {e}")
            return []
        stats[how] += 1
        if how != "cache":
            print(f"[{label}] {gu} {ymd}: {len(recs)}건 ({'새로 받음' if how == 'fetched' else '기존 캐시 사용'})")
            time.sleep(0.2)
        return recs

    for gu in names:
        for ymd in months:
            if args.kind in ("all", "trade"):
                trades.extend(run("trade", gu, ymd, "매매", lambda: [
                    t for t in (to_trade(i, gu) for i in fetch_month(
                        session, key, ENDPOINTS["trade"], all_gu[gu], ymd)) if t]))
            if args.kind in ("all", "rent"):
                recs = run("rent", gu, ymd, "전월세", lambda: [
                    r for r in (to_rent(i, gu, new_only=False) for i in fetch_month(
                        session, key, ENDPOINTS["rent"], all_gu[gu], ymd)) if r])
                rents.extend(r for r in recs if args.include_renewal or not r.get("renewal"))

    print(f"요약: 캐시 {stats['cache']}, 새로 받음 {stats['fetched']}, 갱신 실패로 캐시 대체 {stats['stale']}")
    if failures:  # 일부만 받은 채로 기존 결과를 덮어쓰지 않는다
        sys.exit("수집 실패가 있어 결과 파일을 갱신하지 않았습니다:\n  " + "\n  ".join(failures[:10]))

    out = {
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "months": months,
        "window_months": args.months,
        "gu": names,
        "unit": "만원",
        "bands": {k: label for k, label, _, _ in BANDS},
        "source": "국토교통부 아파트 매매·전월세 실거래가",
        "rent_new_only": not args.include_renewal,
        "sample": False,
        "dongs": aggregate(trades, rents, args.min_n),
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"완료: {len(out['dongs'])}개 법정동 -> {args.out}")


if __name__ == "__main__":
    main()
