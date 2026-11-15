// 카카오 지도 SDK의 주소/장소 검색만 사용한다. (JavaScript 키는 등록한 도메인에서만 동작하는 공개용 키)
export const KAKAO_JS_KEY = "123b8448ec1fea071481d628563973dd";
let loading = null;

export function loadKakao() {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    if (window.kakao && window.kakao.maps && window.kakao.maps.services) return resolve(window.kakao);
    const s = document.createElement("script");
    s.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${KAKAO_JS_KEY}&libraries=services&autoload=false`;
    s.onload = () => window.kakao.maps.load(() => resolve(window.kakao));
    s.onerror = () => reject(new Error("카카오 SDK를 불러오지 못했어요."));
    document.head.appendChild(s);
  });
  loading.catch(() => { loading = null; });
  return loading;
}

/** 주소(도로명·지번)를 먼저 찾고, 없으면 건물·장소명으로 찾는다. 결과: [{name, addr, lng, lat}] */
export async function searchPlace(query) {
  const kakao = await loadKakao();
  const q = query.trim();
  if (!q) return [];
  const svc = kakao.maps.services;
  const run = (fn) => new Promise((resolve) => fn((data, status) => resolve(status === svc.Status.OK ? data : [])));
  let rows = await run((cb) => new svc.Geocoder().addressSearch(q, cb));
  if (rows.length) return rows.slice(0, 5).map((r) => ({ name: r.address_name, addr: r.road_address ? r.road_address.address_name : r.address_name, lng: Number(r.x), lat: Number(r.y) }));
  rows = await run((cb) => new svc.Places().keywordSearch(q, cb, { location: new kakao.maps.LatLng(37.5665, 126.978), radius: 30000 }));
  return rows.slice(0, 5).map((r) => ({ name: r.place_name, addr: r.road_address_name || r.address_name, lng: Number(r.x), lat: Number(r.y) }));
}
