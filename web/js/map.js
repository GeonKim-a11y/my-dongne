// 지도 표시 (Leaflet). 경계 폴리곤을 점수로 칠한다. 점수 계산은 scoring.js가 하고, 여기서는 그리기만 한다.
let map = null;
let layer = null;
let boundary = null;
let byLegal = new Map();

const GRAY_OVER = "#cfd4dc";
const GRAY_NONE = "#eceef2";

function scoreColor(score) {
  // 0점 연한 청록 -> 100점 진한 청록
  const t = Math.max(0, Math.min(100, score)) / 100;
  const a = [207, 236, 236], b = [8, 107, 109];
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export async function initMap(el, url = "data/dong_boundary.json") {
  if (typeof L === "undefined") { el.textContent = "지도 라이브러리를 불러오지 못했습니다."; return false; }
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    boundary = await r.json();
  } catch (e) {
    el.textContent = "경계 파일(data/dong_boundary.json)을 찾을 수 없습니다.";
    return false;
  }
  map = L.map(el, { zoomControl: true, attributionControl: true });
  L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
  }).addTo(map);
  layer = L.geoJSON(boundary, { style: () => ({ weight: 1, color: "#ffffff", fillOpacity: 0.85, fillColor: GRAY_NONE }) }).addTo(map);
  map.fitBounds(layer.getBounds());
  return true;
}

/** results: {ok, over} (scoring.rank 결과), fmt: (stat)=>문구 */
export function updateMap({ ok, over }, describe) {
  if (!layer) return;
  byLegal = new Map();
  ok.forEach((r) => byLegal.set(`${r.d.gu} ${r.d.dong}`, r));
  over.forEach((r) => byLegal.set(`${r.d.gu} ${r.d.dong}`, r));

  layer.eachLayer((l) => {
    const p = l.feature.properties;
    const r = p.legal ? byLegal.get(`${p.gu} ${p.legal}`) : null;
    let fill = GRAY_NONE, status = "데이터 없음 / 표본 부족";
    if (r && r.status === "ok") { fill = scoreColor(r.score); status = `예산 점수 ${r.score}점`; }
    else if (r && r.status === "over") { fill = GRAY_OVER; status = "예산 초과"; }
    l.setStyle({ fillColor: fill, dashArray: p.match === "approx" ? "3 3" : null, weight: p.match === "approx" ? 1.2 : 1 });
    const basis = !p.legal ? "법정동 데이터와 연결되지 않음"
      : `${esc(p.legal)} 거래 기준${p.match === "approx" ? " (근사 매핑)" : ""}`;
    const detail = r ? `<br>${esc(describe(r))}` : "";
    l.bindTooltip(`<b>${esc(p.gu)} ${esc(p.hdong)}</b><br>${esc(status)}${detail}<br><small>${basis}</small>`, { sticky: true });
  });
}
