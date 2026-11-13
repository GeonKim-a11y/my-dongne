# 나의동네찾기 - 예산 모듈 (매매·전세·월세)

서울 아파트 실거래가(매매, 전월세)로 동네별 가격을 집계하고, 사용자의 예산에 맞는 동네를 걸러 주는 첫 번째 모듈입니다.
다른 지표(공원, 안전, 편의시설 등)는 같은 형식으로 나중에 추가합니다.

## 구성
```
config/regions.json        수집할 구 목록(active_gu). 구를 늘리려면 여기에 추가
scripts/fetch_prices.py    매매+전월세 API 수집(월별 캐시) -> 법정동 x 면적대 집계 -> JSON
data/cache/                월별 수집 결과 캐시 (커밋해서 보관. 다음 실행 때 재사용)
.github/workflows/         update-data.yml: 매월 자동 수집 + 커밋
tests/test_aggregate.py    API 키 없이 파싱·집계 검증 (python)
tests/scoring.test.mjs     점수 계산 검증 (node)
web/index.html             화면
web/js/data.js             데이터 불러오기 (실데이터 없으면 샘플)
web/js/scoring.js          예산 점수 계산 (순수 함수, 다른 지표와 합치기 쉬움)
web/js/app.js              탭·슬라이더·결과 표
web/data/                  market_by_dong.sample.json (가상), 수집 후 market_by_dong.json 생성
```

## 배포 (Vercel)
- Vercel 프로젝트에 이 저장소를 연결하고 **Root Directory를 `web`**으로 지정합니다
- GitHub `main` 브랜치에 커밋이 올라오면 Vercel이 자동으로 다시 배포합니다 (월간 자동 수집 결과도 같은 방식으로 반영)

## 시작하기
1. 공공데이터포털에서 아래 두 API를 활용신청 (승인에 시간이 걸릴 수 있으니 먼저)
   - 국토교통부_아파트 매매 실거래가 상세 자료
   - 국토교통부_아파트 전월세 실거래가 자료
2. `.env.example`을 `.env`로 복사하고 인증키(Decoding 키)를 붙여넣기. `.env`는 커밋 금지
3. 수집
   ```
   pip install -r requirements.txt
   python scripts/fetch_prices.py --kind rent --gu 노원구 --months 1   # 먼저 한 구, 전월세만 시험
   python scripts/fetch_prices.py                                      # active_gu, 최근 12개월, 매매+전월세
   python scripts/fetch_prices.py --all                                # 서울 25개 구
   ```
4. 웹 확인
   ```
   cd web
   python -m http.server 8000      # http://localhost:8000
   ```
   `market_by_dong.json`이 없으면 자동으로 샘플(가상) 데이터를 보여 줍니다.
5. 테스트
   ```
   python -m unittest discover -s tests
   node --test tests/scoring.test.mjs
   ```

## 자동 갱신 (1년치를 계속 끌어오기)
- 수집은 **월별 캐시**를 씁니다. 처음 한 번만 12개월 x 구 x (매매, 전월세)를 받고, 이후에는 최근 3개월만 다시 받아서 호출량이 크게 줄어듭니다. 거래는 계약 후 30일 안에 신고되는 경우가 있어 최근 몇 달은 계속 바뀌기 때문입니다 (`--refresh-months`)
- 일부 달을 못 받았는데 캐시도 없으면 **결과 파일을 갱신하지 않고** 실패로 끝냅니다. 반쯤 받은 데이터가 정상 데이터를 덮어쓰지 않게 하려는 장치입니다
- `--include-renewal` 같은 옵션은 캐시에서 다시 계산하므로 API를 다시 호출하지 않습니다
- `.github/workflows/update-data.yml`이 매월 6일 한국 시간 06:00에 위 명령을 실행하고 변경분을 커밋합니다. 주기를 바꾸려면 파일의 `cron` 줄만 고치면 됩니다. 커밋이 생기면 Vercel이 자동으로 재배포합니다

### 자동 갱신 켜는 순서
1. 이 프로젝트 전체(`.github` 폴더 포함)를 GitHub 저장소에 올립니다
2. GitHub 저장소 Settings -> Secrets and variables -> Actions -> New repository secret: 이름 `PUBLIC_DATA_API_KEY`, 값은 인증키(Decoding)
3. Vercel 프로젝트 Settings -> Git에서 이 저장소를 연결하고, General의 Root Directory를 `web`으로 지정합니다 (연결 전에는 Vercel이 자동 재배포하지 못합니다)
4. GitHub의 Actions 탭 -> update-market-data -> Run workflow로 첫 실행. 성공하면 `web/data/market_by_dong.json`과 `data/cache/`가 커밋되고 사이트가 바뀝니다
- 주의: 저장소가 한동안 활동이 없으면 GitHub가 예약 실행을 멈출 수 있습니다. 멈췄으면 Actions 탭에서 다시 켜거나 수동 실행하세요
- 주의: 공공데이터포털 개발계정은 하루 호출 한도가 있습니다. 첫 실행은 6개 구 기준으로 150번 안팎, 이후 매월은 40번 안팎입니다. 한도를 넘으면 실패로 끝나니 Actions 탭에서 다음 날 수동으로 다시 실행하세요

## 계산 방식
- 동네 x 면적대(소형 60㎡ 미만 / 중형 60~85㎡ / 중대형 85㎡ 이상)별로 **거래 중앙값**을 구합니다. 평균은 고가 단지 몇 건에 휘둘려서 쓰지 않았습니다
- 매매: 거래금액, 전세: 보증금, 월세: 보증금과 월세를 각각 중앙값으로 집계
- 매매 해제 거래 제외. 전월세는 기본적으로 **신규 계약만** 사용 (갱신 계약은 기존 가격이 이어져 시세보다 낮은 경우가 많음). `--include-renewal`로 포함 가능
- 예산 점수 = 예산 대비 여유율을 0~100점으로 환산 (여유 50% 이상이면 100점, 예산 초과는 제외). 월세는 보증금과 월세 중 더 빠듯한 쪽 기준
- 집계는 수집된 **전체 기간(기본 12개월)**의 거래를 한꺼번에 사용합니다. 표본이 안정적인 대신 최근 시세 변화에는 둔합니다. 최근 3개월 기준 통계를 따로 보여주는 방법도 있습니다
- 거래가 3건 미만이면 `low_sample`로 표시하고 기본 화면에서는 숨깁니다 (`--min-n`으로 조절)

## 확인되지 않았거나 정해야 할 것
- **전월세 응답 필드명**: 엔드포인트와 파라미터는 공공데이터포털 문서로 확인했지만, `deposit`, `monthlyRent`, `contractType`(신규/갱신), `umdNm` 같은 필드명은 실제 응답으로 한 번 확인하세요. 다르면 `to_rent()`, `to_trade()`만 고치면 됩니다. `contractType`이 없으면 갱신 필터는 자동으로 무시됩니다
- **월세의 한계**: 보증금과 월세는 서로 바꿔 쓸 수 있는 값이라(보증금을 올리면 월세가 내려감), 지금은 둘을 따로 비교합니다. 나중에 전월세 전환율로 하나의 값으로 합치는 방법도 있습니다
- **동 단위**: 실거래가는 법정동 기준입니다. 최종 추천 단위를 행정동으로 할지 정해야 합니다 (행정동 경계 GeoJSON은 구할 수 있는 것으로 확인됨, 실거래가는 아파트 주소를 지오코딩해 행정동에 넣는 작업이 필요)
- 아파트만 다룹니다. 연립·다세대, 오피스텔은 별도 API입니다
- 최근 달은 신고 지연으로 거래가 덜 잡힙니다 (스크립트는 이번 달을 제외)
- 지분 거래, 직거래, 이상치 필터링은 아직 없습니다

## 다음 단계
1. 실데이터로 동네별 중앙값 확인 (표본 부족 동네 처리 방식 결정)
2. 행정동 경계 GeoJSON을 구해 카카오맵 위에 예산 점수를 색칠
3. 다른 지표 모듈을 같은 형식(동 x 0~100점)으로 추가하고 가중치 합산으로 연결

## 지도 (GIS)
- `web/data/dong_boundary.json`: 6개 구의 행정동 경계(122개). `python scripts/build_boundary.py <행정동 geojson>`으로 다시 만들 수 있다. 원본은 vuski/admdongkor.
- 실거래가는 법정동, 경계는 행정동이라 이름 규칙 + 수동 표로 임시 매핑한다(근사 매핑은 지도에서 점선). 아파트 주소 지오코딩으로 바꾸면 정확해진다.
- 지도는 Leaflet + OpenStreetMap 배경지도(키 불필요). 예산 점수가 높을수록 진한 청록.
- `web/data/seoul_outline.json`: 서울 25개 구 외곽선과 서울 밖을 가리는 마스크. 분석 대상이 아닌 구는 경계선만 나온다. `build_boundary.py`가 함께 만든다(shapely 필요, 갱신 워크플로에는 불필요).

## 의료기관(병원 수) 분석
- 수집: `python scripts/fetch_hospitals.py` -> `web/data/hospitals.json` (병원급·의원·치과·한의원 위치). 공공데이터포털의 '건강보험심사평가원_병원정보서비스' **활용신청(승인)이 별도로 필요**하다. 승인 전에는 가상 샘플(`hospitals.sample.json`)이 대신 쓰이고 화면에 경고가 뜬다.
- 계산은 브라우저에서 한다(`web/js/gis.js`): 행정동 폴리곤 안 점 개수(point-in-polygon), 면적당 밀도(개/㎢) -> 백분위 점수, 지도에서 찍은 지점의 반경 분석(haversine).
- 종합 점수 = (예산 점수 x 예산 가중치 + 의료 점수 x 의료 가중치) / 가중치 합. 예산을 넘는 동네는 제외된다.
- 응답 필드명(sgguCdNm, clCd, XPos, YPos)과 엔드포인트는 문서 기준이며 실제 응답으로 한 번 확인이 필요하다.

## 공원 분석
- 수집: `python scripts/fetch_parks.py` (API) 또는 `--csv 파일.csv` (포털에서 받은 '전국도시공원정보표준데이터' CSV) -> `web/data/parks.json`. 묘지공원은 제외한다. API 주소·필드명은 문서 기준 추정이라 `--url`로 바꿀 수 있고, 안 되면 CSV를 `data/parks_source.csv`로 올리고 `update-parks` 워크플로를 실행하면 된다.
- 점수: 행정동 안 공원 면적 / 동 면적 의 백분위(0~100). 공원은 점(중심 좌표) 하나로만 있어서, 여러 동에 걸친 큰 공원은 한 동에 몰려 계산된다(한계).
- 승인·수집 전에는 가상 샘플(`parks.sample.json`)이 쓰이고 화면에 경고가 뜬다.
