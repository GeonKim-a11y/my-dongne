// 데이터 불러오기. 실데이터(market_by_dong.json)가 있으면 그것을, 없으면 가상 샘플을 쓴다.
export async function loadData() {
  for (const url of ["data/market_by_dong.json", "data/market_by_dong.sample.json"]) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) {
      /* 다음 후보로 */
    }
  }
  throw new Error("데이터 파일을 찾을 수 없습니다. web 폴더에서 `python -m http.server 8000`으로 실행했는지 확인하세요.");
}

// 의료기관 위치. 실데이터(hospitals.json)가 있으면 그것을, 없으면 가상 샘플, 둘 다 없으면 null.
export async function loadHospitals() {
  for (const url of ["data/hospitals.json", "data/hospitals.sample.json"]) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (e) {
      /* 다음 후보로 */
    }
  }
  return null;
}
