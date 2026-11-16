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

/** 주소와 장소(건물·역·터미널·회사명)를 함께 찾는다. 숫자가 들어 있으면 주소 결과를, 아니면 장소 결과를 먼저 보여준다. 결과: [{name, addr, lng, lat}] */
export async function searchPlace(query) {
  const kakao = await loadKakao();
  const q = query.trim();
  if (!q) return [];
  const svc = kakao.maps.services;
  const run = (fn) => new Promise((resolve) => fn((data, status) => {
    if (status === svc.Status.ERROR) console.warn("카카오 검색 오류", q);
    resolve(status === svc.Status.OK ? data : []);
  }));
  const [addr, place] = await Promise.all([
    run((cb) => new svc.Geocoder().addressSearch(q, cb)),
    run((cb) => new svc.Places().keywordSearch(q, cb, { location: new kakao.maps.LatLng(37.5665, 126.978), sort: kakao.maps.services.SortBy.DISTANCE })),
  ]);
  const fromAddr = addr.map((r) => {
    const road = r.road_address || null;
    const bname = road && road.building_name ? road.building_name : "";
    const base = road ? road.address_name : r.address_name;
    return { name: bname || base, addr: bname ? base : (r.address ? `지번 ${r.address.address_name}` : base), lng: Number(r.x), lat: Number(r.y) };
  });
  const fromPlace = place.map((r) => ({ name: r.place_name, addr: r.road_address_name || r.address_name, lng: Number(r.x), lat: Number(r.y) }));
  const merged = /\d/.test(q) ? [...fromAddr, ...fromPlace] : [...fromPlace, ...fromAddr];
  const seen = new Set();
  return merged.filter((r) => {
    const k = `${r.lng.toFixed(4)},${r.lat.toFixed(4)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 6);
}
