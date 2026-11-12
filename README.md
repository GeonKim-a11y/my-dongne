# 나의동네찾기 - 예산 모듈 (매매·전세·월세)

서울 아파트 실거래가(매매, 전월세)로 동네별 가격을 집계하고, 사용자의 예산에 맞는 동네를 걸러 주는 첫 번째 모듈입니다.
다른 지표(공원, 안전, 편의시설 등)는 같은 형식으로 나중에 추가합니다.

## 구성
```
config/regions.json        수집할 구 목록(active_gu). 구를 늘리려면 여기에 추가
scripts/fetch_prices.py    매매+전월세 API 수집 -> 법정동 x 면적대 집계 -> JSON
tests/test_aggregate.py    API 키 없이 파싱·집계 검증 (python)
tests/scoring.test.mjs     점수 계산 검증 (node)
web/index.html             화면
web/js/data.js             데이터 불러오기 (실데이터 없으면 샘플)
web/js/scoring.js          예산 점수 계산 (순수 함수, 다른 지표와 합치기 쉬움)
web/js/app.js              탭·슬라이더·결과 표
web/data/                  market_by_dong.sample.json (가상), 수집 후 market_by_dong.json 생성
```

## 시작하기
1. 공공데이터포털에서 아래 두 API를 활용신청 (승인에 시간이 걸릴 수 있으니 먼저)
   - 국토교통부_아파트 매매 실거래가 상세 자료
   - 국토교통부_아파트 전월세 실거래가 자료
2. `.env.example`을 `.env`로 복사하고 인증키(Decoding 키)를 붙여넣기. `.env`는 커밋 금지
3. 수집
   ```
   pip install -r requirements.txt
   python scripts/fetch_prices.py --kind rent --gu 노원구 --months 1   # 먼저 한 구, 전월세만 시험
   python scripts/fetch_prices.py --months 3                           # active_gu 전체, 매매+전월세
   python scripts/fetch_prices.py --all --months 3                     # 서울 25개 구
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

## 계산 방식
- 동네 x 면적대(소형 60㎡ 미만 / 중형 60~85㎡ / 중대형 85㎡ 이상)별로 **거래 중앙값**을 구합니다. 평균은 고가 단지 몇 건에 휘둘려서 쓰지 않았습니다
- 매매: 거래금액, 전세: 보증금, 월세: 보증금과 월세를 각각 중앙값으로 집계
- 매매 해제 거래 제외. 전월세는 기본적으로 **신규 계약만** 사용 (갱신 계약은 기존 가격이 이어져 시세보다 낮은 경우가 많음). `--include-renewal`로 포함 가능
- 예산 점수 = 예산 대비 여유율을 0~100점으로 환산 (여유 50% 이상이면 100점, 예산 초과는 제외). 월세는 보증금과 월세 중 더 빠듯한 쪽 기준
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
