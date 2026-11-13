"""API 키 없이 파싱·집계 로직을 검증한다.  실행: python -m unittest discover -s tests"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import fetch_prices as fp  # noqa: E402

# 실제 응답 형태를 흉내 낸 가짜 XML (값은 임의)
TRADE_XML = """<?xml version="1.0" encoding="UTF-8"?>
<response><header><resultCode>000</resultCode><resultMsg>OK</resultMsg></header>
<body><items>
<item><aptNm>가</aptNm><dealAmount>85,000</dealAmount><excluUseAr>84.99</excluUseAr><umdNm>대치동</umdNm><cdealType></cdealType></item>
<item><aptNm>나</aptNm><dealAmount>90,000</dealAmount><excluUseAr>84.50</excluUseAr><umdNm>대치동</umdNm></item>
<item><aptNm>다</aptNm><dealAmount>70,000</dealAmount><excluUseAr>59.00</excluUseAr><umdNm>대치동</umdNm></item>
<item><aptNm>해제건</aptNm><dealAmount>99,000</dealAmount><excluUseAr>84.00</excluUseAr><umdNm>대치동</umdNm><cdealType>O</cdealType></item>
<item><aptNm>라</aptNm><dealAmount>30,000</dealAmount><excluUseAr>59.90</excluUseAr><umdNm>상계동</umdNm></item>
<item><aptNm>깨진값</aptNm><dealAmount>abc</dealAmount><excluUseAr>59.90</excluUseAr><umdNm>상계동</umdNm></item>
</items><numOfRows>1000</numOfRows><pageNo>1</pageNo><totalCount>6</totalCount></body></response>
"""

RENT_XML = """<?xml version="1.0" encoding="UTF-8"?>
<response><header><resultCode>000</resultCode><resultMsg>OK</resultMsg></header>
<body><items>
<item><aptNm>가</aptNm><deposit>50,000</deposit><monthlyRent>0</monthlyRent><excluUseAr>84.9</excluUseAr><umdNm>상계동</umdNm><contractType>신규</contractType></item>
<item><aptNm>나</aptNm><deposit>40,000</deposit><monthlyRent>0</monthlyRent><excluUseAr>84.1</excluUseAr><umdNm>상계동</umdNm><contractType>갱신</contractType></item>
<item><aptNm>다</aptNm><deposit>20,000</deposit><monthlyRent>100</monthlyRent><excluUseAr>59.0</excluUseAr><umdNm>상계동</umdNm><contractType>신규</contractType></item>
<item><aptNm>라</aptNm><deposit>10,000</deposit><monthlyRent>150</monthlyRent><excluUseAr>59.5</excluUseAr><umdNm>상계동</umdNm></item>
<item><aptNm>마</aptNm><deposit>0</deposit><monthlyRent>0</monthlyRent><excluUseAr>59.5</excluUseAr><umdNm>상계동</umdNm></item>
</items><numOfRows>1000</numOfRows><pageNo>1</pageNo><totalCount>5</totalCount></body></response>
"""


class TestTrade(unittest.TestCase):
    def setUp(self):
        self.code, self.total, self.items = fp.parse_response(TRADE_XML)
        self.trades = [t for t in (fp.to_trade(i, "강남구") for i in self.items) if t]

    def test_parse(self):
        self.assertEqual(self.code, "000")
        self.assertEqual(self.total, 6)
        self.assertEqual(len(self.items), 6)

    def test_filters_cancelled_and_bad_rows(self):
        self.assertEqual(len(self.trades), 4)  # 해제 1, 깨진 값 1 제외
        self.assertNotIn("해제건", [t["apt"] for t in self.trades])

    def test_bands(self):
        self.assertEqual(fp.band_of(59.9), "S")
        self.assertEqual(fp.band_of(60), "M")
        self.assertEqual(fp.band_of(84.99), "M")
        self.assertEqual(fp.band_of(85), "L")

    def test_aggregate_trade(self):
        rows = {r["dong"]: r for r in fp.aggregate(self.trades, [], min_n=2)}
        m = rows["대치동"]["trade"]["M"]
        self.assertEqual(m["n"], 2)
        self.assertEqual(m["median"], 87500)           # (85000+90000)/2
        self.assertFalse(m["low_sample"])
        self.assertTrue(rows["상계동"]["trade"]["S"]["low_sample"])  # 1건


class TestRent(unittest.TestCase):
    def setUp(self):
        _, _, items = fp.parse_response(RENT_XML)
        self.items = items

    def test_new_only_default(self):
        rents = [r for r in (fp.to_rent(i, "노원구") for i in self.items) if r]
        # 갱신 1건, 보증금·월세 둘 다 0인 1건 제외 -> 3건
        self.assertEqual(len(rents), 3)

    def test_include_renewal(self):
        rents = [r for r in (fp.to_rent(i, "노원구", new_only=False) for i in self.items) if r]
        self.assertEqual(len(rents), 4)

    def test_kind_split_and_aggregate(self):
        rents = [r for r in (fp.to_rent(i, "노원구") for i in self.items) if r]
        row = fp.aggregate([], rents, min_n=1)[0]
        self.assertEqual(row["jeonse"]["M"]["median"], 50000)       # 신규 전세 1건
        w = row["wolse"]["S"]
        self.assertEqual(w["n"], 2)
        self.assertEqual(w["median_deposit"], 15000)                 # (20000+10000)/2
        self.assertEqual(w["median_rent"], 125)                      # (100+150)/2


class TestMisc(unittest.TestCase):
    def test_recent_months_wraps_year(self):
        from datetime import date
        self.assertEqual(fp.recent_months(3, date(2026, 1, 15)), ["202512", "202511", "202510"])
        self.assertEqual(fp.recent_months(2, date(2026, 11, 12)), ["202610", "202609"])


if __name__ == "__main__":
    unittest.main()


# ---------- 월별 캐시 / 증분 수집 ----------
import json  # noqa: E402
import os  # noqa: E402
import tempfile  # noqa: E402
import types  # noqa: E402
from unittest import mock  # noqa: E402


class TestCache(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = self.tmp.name

    def tearDown(self):
        self.tmp.cleanup()

    def test_cache_hit_skips_fetch(self):
        calls = []
        f = lambda: calls.append(1) or [{"a": 1}]  # noqa: E731
        r1, how1 = fp.get_month(self.dir, "trade", "노원구", "202610", False, f)
        r2, how2 = fp.get_month(self.dir, "trade", "노원구", "202610", False, f)
        self.assertEqual((how1, how2, len(calls)), ("fetched", "cache", 1))
        self.assertEqual(r2, [{"a": 1}])

    def test_refresh_refetches_and_overwrites(self):
        fp.get_month(self.dir, "trade", "노원구", "202610", False, lambda: [{"v": 1}])
        r, how = fp.get_month(self.dir, "trade", "노원구", "202610", True, lambda: [{"v": 2}])
        self.assertEqual((how, r), ("fetched", [{"v": 2}]))

    def test_refresh_failure_falls_back_to_cache(self):
        fp.get_month(self.dir, "trade", "노원구", "202610", False, lambda: [{"v": 1}])

        def boom():
            raise RuntimeError("API down")
        r, how = fp.get_month(self.dir, "trade", "노원구", "202610", True, boom)
        self.assertEqual((how, r), ("stale", [{"v": 1}]))

    def test_failure_without_cache_raises(self):
        def boom():
            raise RuntimeError("API down")
        with self.assertRaises(RuntimeError):
            fp.get_month(self.dir, "trade", "노원구", "202610", False, boom)


class TestMainEndToEnd(unittest.TestCase):
    """requests 와 API 호출을 가짜로 바꿔 main() 전체 흐름을 검증한다."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = os.path.join(self.tmp.name, "cache")
        self.out = os.path.join(self.tmp.name, "out.json")
        self.calls = []

    def tearDown(self):
        self.tmp.cleanup()

    def fake_fetch(self, session, key, url, lawd, ymd, **kw):
        self.calls.append((url.split("/")[-1], lawd, ymd))
        if "Rent" in url:
            return [{"deposit": "20,000", "monthlyRent": "100", "excluUseAr": "59.0", "umdNm": "상계동", "contractType": "신규"},
                    {"deposit": "9,000", "monthlyRent": "0", "excluUseAr": "59.0", "umdNm": "상계동", "contractType": "갱신"}]
        return [{"aptNm": "가", "dealAmount": "50,000", "excluUseAr": "84.9", "umdNm": "상계동"}]

    def run_main(self, *extra):
        argv = ["fetch_prices.py", "--gu", "노원구", "--months", "3", "--cache-dir", self.cache,
                "--out", self.out, *extra]
        fake_requests = types.SimpleNamespace(Session=lambda: object())
        with mock.patch.object(sys, "argv", argv), \
             mock.patch.dict(os.environ, {"PUBLIC_DATA_API_KEY": "test"}), \
             mock.patch.dict(sys.modules, {"requests": fake_requests}), \
             mock.patch.object(fp, "fetch_month", self.fake_fetch):
            fp.main()

    def test_incremental_second_run_only_refreshes_recent(self):
        self.run_main("--refresh-months", "1")
        self.assertEqual(len(self.calls), 3 * 2)           # 3개월 x (매매+전월세), 전부 새로 받음
        out = json.load(open(self.out, encoding="utf-8"))
        self.assertEqual(out["window_months"], 3)
        row = out["dongs"][0]
        self.assertEqual(row["wolse"]["S"]["n"], 3)         # 신규 월세 1건 x 3개월
        # 갱신 계약(전세)은 기본 제외 -> 전세 통계 없음
        self.assertNotIn("S", row["jeonse"])
        self.assertEqual(row["trade"]["M"]["n"], 3)         # 3개월치가 쌓임

        self.calls.clear()
        self.run_main("--refresh-months", "1")
        self.assertEqual(len(self.calls), 1 * 2)           # 가장 최근 1개월만 다시 받음

    def test_include_renewal_uses_same_cache(self):
        self.run_main()
        self.calls.clear()
        self.run_main("--refresh-months", "0", "--include-renewal")
        self.assertEqual(self.calls, [])                    # 캐시만으로 옵션 변경 가능
        row = json.load(open(self.out, encoding="utf-8"))["dongs"][0]
        self.assertEqual(row["jeonse"]["S"]["n"], 3)

    def test_failure_does_not_overwrite_output(self):
        self.run_main()
        before = open(self.out, encoding="utf-8").read()

        def boom(*a, **k):
            raise RuntimeError("down")
        # 캐시 하나를 지우고(= 필수 데이터 누락) API 까지 실패하면 결과 파일을 건드리면 안 된다
        import glob
        victim = sorted(glob.glob(os.path.join(self.cache, "trade", "*", "노원구.json")))[-1]
        os.remove(victim)
        with mock.patch.object(sys, "argv", ["f", "--gu", "노원구", "--months", "3", "--refresh-months", "0",
                                              "--cache-dir", self.cache, "--out", self.out]), \
             mock.patch.dict(os.environ, {"PUBLIC_DATA_API_KEY": "test"}), \
             mock.patch.dict(sys.modules, {"requests": types.SimpleNamespace(Session=lambda: object())}), \
             mock.patch.object(fp, "fetch_month", boom):
            with self.assertRaises(SystemExit):
                fp.main()
        self.assertEqual(open(self.out, encoding="utf-8").read(), before)


# ---- 경계 매핑 ----
def test_boundary_match():
    import importlib.util, pathlib
    spec = importlib.util.spec_from_file_location("bb", pathlib.Path(__file__).resolve().parent.parent / "scripts/build_boundary.py")
    bb = importlib.util.module_from_spec(spec); spec.loader.exec_module(bb)
    names = {"상계동", "성수동1가", "신림동"}
    assert bb.match_legal("노원구", "상계10동", names) == ("상계동", "exact")
    assert bb.match_legal("성동구", "성수1가1동", names) == ("성수동1가", "approx")
    assert bb.match_legal("관악구", "대학동", names) == ("신림동", "approx")
    assert bb.match_legal("마포구", "서강동", names) == (None, None)


# ---- 의료기관 수집 ----
def _hosp_mod():
    import importlib.util, pathlib, sys
    d = pathlib.Path(__file__).resolve().parent.parent / "scripts"
    sys.path.insert(0, str(d))
    spec = importlib.util.spec_from_file_location("fh", d / "fetch_hospitals.py")
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


def test_hospital_point_filters_and_case_insensitive():
    fh = _hosp_mod()
    ok = {"sgguCdNm": "강남구", "clCd": "31", "XPos": "127.05", "YPos": "37.5", "yadmNm": "가의원"}
    assert fh.to_point(ok, {"강남구"}) == [127.05, 37.5, "C", "가의원"]
    lower = {"sgguCdNm": "강남구", "clCd": "01", "xPos": "127.05", "yPos": "37.5", "yadmNm": "나병원"}
    assert fh.to_point(lower, {"강남구"})[2] == "H"
    assert fh.to_point(ok, {"마포구"}) is None                       # 비활성 구
    assert fh.to_point({**ok, "clCd": "71"}, {"강남구"}) is None      # 분류에 없는 종별(보건소 등)
    assert [fh.to_point({**ok, "clCd": c}, {"강남구"})[2] for c in ("41", "51", "92", "93", "29")] == ["D", "D", "K", "K", "H"]
    assert fh.to_point({**ok, "XPos": "0", "YPos": "0"}, {"강남구"}) is None   # 잘못된 좌표
    assert fh.to_point({**ok, "XPos": ""}, {"강남구"}) is None


def test_hospital_fetch_all_pages_and_error():
    fh = _hosp_mod()

    def page(items, total, code="00"):
        body = "".join("<item>" + "".join(f"<{k}>{v}</{k}>" for k, v in it.items()) + "</item>" for it in items)
        return f"<response><header><resultCode>{code}</resultCode></header><body><items>{body}</items><totalCount>{total}</totalCount></body></response>"

    class R:
        def __init__(self, t): self.text = t
        def raise_for_status(self): pass

    class S:
        def __init__(self, pages): self.pages = pages; self.calls = 0
        def get(self, url, params, timeout):
            self.calls += 1
            return R(self.pages[params["pageNo"] - 1])

    a, b = {"yadmNm": "a"}, {"yadmNm": "b"}
    s = S([page([a], 2), page([b], 2)])
    assert len(fh.fetch_all(s, "k", rows=1)) == 2 and s.calls == 2
    import pytest
    with pytest.raises(RuntimeError):
        fh.fetch_all(S([page([], 0, code="30")]), "k")


# ---- 공원 수집 ----
def _park_mod():
    import importlib.util, pathlib, sys
    d = pathlib.Path(__file__).resolve().parent.parent / "scripts"
    sys.path.insert(0, str(d))
    spec = importlib.util.spec_from_file_location("fp", d / "fetch_parks.py")
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


def test_park_point_api_and_csv_fields():
    fp = _park_mod()
    api = {"parkNm": "서울숲", "parkSe": "근린공원", "rdnmadr": "서울특별시 성동구 뚝섬로 273", "latitude": "37.5444", "longitude": "127.0374", "parkAr": "1,156,498"}
    assert fp.to_point(api, ["성동구"]) == [127.0374, 37.5444, "N", "서울숲", 1156498]
    ko = {"공원명": "가어린이공원", "공원구분": "어린이공원", "소재지지번주소": "서울특별시 마포구 도화동 1", "위도": "37.54", "경도": "126.95", "공원면적": "1500"}
    assert fp.to_point(ko, ["마포구"])[2] == "S"
    assert fp.to_point(ko, ["성동구"]) is None                          # 비활성 구
    assert fp.to_point({**ko, "공원구분": "묘지공원"}, ["마포구"]) is None   # 묘지공원 제외
    assert fp.to_point({**ko, "공원면적": "0"}, ["마포구"]) is None
    assert fp.to_point({**ko, "소재지지번주소": "부산광역시 마포구"}, ["마포구"]) is None   # 서울이 아님


def test_park_build_dedup(tmp_path):
    fp = _park_mod()
    a = {"공원명": "가공원", "공원구분": "근린공원", "소재지도로명주소": "서울특별시 강남구 1", "위도": "37.5", "경도": "127.05", "공원면적": "1000"}
    out = fp.build([a, dict(a)], ["강남구"])
    assert len(out["points"]) == 1 and out["counts"] == {"N": 1} and out["total_area_m2"] == 1000
    p = tmp_path / "p.csv"
    p.write_text("공원명,공원구분,소재지도로명주소,위도,경도,공원면적\n나공원,소공원,서울특별시 강남구 2,37.5,127.05,500\n", encoding="cp949")
    assert fp.read_csv(p)[0]["공원명"] == "나공원"


# ---- CCTV 수집 ----
def _cctv_mod():
    import importlib.util, pathlib, sys
    d = pathlib.Path(__file__).resolve().parent.parent / "scripts"
    sys.path.insert(0, str(d))
    spec = importlib.util.spec_from_file_location("fc", d / "fetch_cctv.py")
    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m


def test_cctv_point_fields_and_classify():
    fc = _cctv_mod()
    ko = {"소재지도로명주소": "서울특별시 강남구 테헤란로 1", "설치목적구분": "생활방범", "카메라대수": "3", "WGS84위도": "37.5", "WGS84경도": "127.03"}
    assert fc.to_point(ko, ["강남구"]) == [127.03, 37.5, "B", 3]
    en = {"rdnmadr": "서울특별시 마포구 1", "installPurpose": "어린이보호", "cmrCnt": "1", "lat": "37.55", "lon": "126.92"}
    assert fc.to_point(en, ["마포구"])[2] == "K"
    assert fc.to_point(ko, ["마포구"]) is None
    assert fc.to_point({**ko, "WGS84위도": "0", "WGS84경도": "0"}, ["강남구"]) is None
    assert fc.to_point({**ko, "카메라대수": ""}, ["강남구"])[3] == 1
    assert fc.classify("불법주정차단속") == "T" and fc.classify("기타") == "O"


def test_cctv_parse_json_and_xml_and_merge():
    fc = _cctv_mod()
    js = '{"response":{"header":{"resultCode":"00"},"body":{"items":{"item":[{"a":1},{"a":2}]},"totalCount":2}}}'
    assert fc.parse_any(js) == ("00", 2, [{"a": 1}, {"a": 2}])
    xml = "<response><header><resultCode>00</resultCode></header><body><items><item><a>1</a></item></items><totalCount>1</totalCount></body></response>"
    assert fc.parse_any(xml)[1] == 1
    assert fc.merge([[127.0, 37.5, "B", 1], [127.0, 37.5, "B", 2], [127.0, 37.5, "K", 1]]) == [[127.0, 37.5, "B", 3], [127.0, 37.5, "K", 1]]


def test_cctv_real_api_fields():
    fc = _cctv_mod()
    real = {"CAM_CNTOM": "2", "CAM_PIXEL_CNT": "200", "INSTL_PRPS_SE_NM": "생활방범", "KPNG_DAY_CNT": "30",
            "LCTN_LOTNO_ADDR": "서울특별시 강남구 역삼동 1-1", "LCTN_ROAD_NM_ADDR": "서울특별시 강남구 테헤란로",
            "WGS84_LAT": "37.5", "WGS84_LOT": "127.03"}
    assert fc.to_point(real, ["강남구"]) == [127.03, 37.5, "B", 2]


def test_cctv_agency_name_fallback_when_address_empty():
    fc = _cctv_mod()
    row = {"MNG_INST_NM": "서울특별시 성동구청", "LCTN_ROAD_NM_ADDR": "", "LCTN_LOTNO_ADDR": "", "CAM_CNTOM": "1",
           "INSTL_PRPS_SE_NM": "생활방범", "WGS84_LAT": "37.55", "WGS84_LOT": "127.04"}
    assert fc.to_point(row, ["성동구"]) == [127.04, 37.55, "B", 1]
    assert fc.to_point(row, ["강남구"]) is None
