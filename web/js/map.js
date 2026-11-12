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

export async function initMap(el, url = "data/dong_boundary.json", outlineUrl = "data/seoul_outline.json") {
  if (typeof L === "undefined") { el.textContent = "지도 라이브러리를 불러오지 못했습니다."; return false; }
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error(r.status);
    boundary = await r.json();
  } catch (e) {
    el.textContent = "경계 파일(data/dong_boundary.json)을 찾을 수 없습니다.";
    return false;
  }
  let outline = null;
  try {
    const r2 = await fetch(outlineUrl);
    if (r2.ok) outline = await r2.json();
  } catch (e) { /* 외곽선 없이도 지도는 동작 */ }
  map = L.map(el, { zoomControl: true, attributionControl: true, minZoom: 10 });
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  let seoulBounds = null;
  if (outline) {
    const feats = outline.features;
    const guFeats = { type: "FeatureCollection", features: feats.filter((f) => f.properties.kind === "gu") };
    // 서울 밖은 가린다 (배경지도 위에 불투명 마스크).
    map.createPane("mask"); map.getPane("mask").style.zIndex = 350;
    L.geoJSON(feats.find((f) => f.properties.kind === "mask"), {
      pane: "mask", interactive: false,
      style: { stroke: false, fillColor: getComputedStyle(document.body).backgroundColor || "#f6f7f9", fillOpacity: 1 },
    }).addTo(map);
    // 아직 분석하지 않는 구는 경계선만.
    L.geoJSON({ type: "FeatureCollection", features: guFeats.features.filter((f) => !f.properties.active) }, {
      style: { color: "#98a2b3", weight: 1.2, fill: true, fillOpacity: 0, dashArray: null },
      onEachFeature: (f, l) => l.bindTooltip(`${esc(f.properties.gu)} · 아직 분석 대상이 아닙니다`, { sticky: true }),
    }).addTo(map);
    seoulBounds = L.geoJSON(guFeats).getBounds();
    map.setMaxBounds(seoulBounds.pad(0.15));
  }
  layer = L.geoJSON(boundary, { style: () => ({ weight: 1, color: "#ffffff", fillOpacity: 0.85, fillColor: GRAY_NONE }) }).addTo(map);
  if (outline) {
    // 분석 대상 구의 바깥 경계를 진하게 덧그린다.
    const act = outline.features.filter((f) => f.properties.kind === "gu" && f.properties.active);
    L.geoJSON({ type: "FeatureCollection", features: act }, { interactive: false, style: { color: "#0b6e70", weight: 2, fill: false } }).addTo(map);
  }
  map.fitBounds(seoulBounds || layer.getBounds());
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
