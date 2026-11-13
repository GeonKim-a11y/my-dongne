// 지도 표시 (Leaflet). 경계 폴리곤을 점수로 칠한다. 점수 계산은 scoring.js가 하고, 여기서는 그리기만 한다.
let map = null;
let layer = null;
let boundary = null;
let pointLayer = null;
let probeLayer = null;
let onProbeCb = null;
let unitRows = new Map();

const GRAY_OVER = "#cfd4dc";
const GRAY_NONE = "#eceef2";

function scoreColor(score) {
  // 0점 연한 파랑 -> 100점 진한 파랑
  const t = Math.max(0, Math.min(100, score)) / 100;
  const a = [219, 233, 254], b = [27, 100, 218];
  const c = a.map((v, i) => Math.round(v + (b[i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

export function getFeatures() { return boundary ? boundary.features : null; }

/** 지도 클릭(분석 지점 선택) 콜백 등록: cb(lng, lat) */
export function onProbe(cb) { onProbeCb = cb; }

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
  el.textContent = "";
  el.style.display = "block";
  map = L.map(el, { zoomControl: true, attributionControl: true, minZoom: 10, zoomSnap: 0.25 });
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
      style: { stroke: false, fillColor: getComputedStyle(document.body).backgroundColor || "#f2f4f6", fillOpacity: 1 },
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
    L.geoJSON({ type: "FeatureCollection", features: act }, { interactive: false, style: { color: "#1b64da", weight: 2, fill: false } }).addTo(map);
  }
  map.fitBounds(seoulBounds || layer.getBounds());
  map.on("click", (e) => { if (onProbeCb) onProbeCb(e.latlng.lng, e.latlng.lat); });
  return true;
}

/** rows: Map("구 행정동" -> {status:"ok"|"over"|"nodata", total, ...}), describe(row)->문구 */
export function updateMap(rows, describe) {
  if (!layer) return;
  unitRows = rows;
  layer.eachLayer((l) => {
    const p = l.feature.properties;
    const r = rows.get(`${p.gu} ${p.hdong}`);
    let fill = GRAY_NONE, status = "데이터 없음 / 표본 부족";
    if (r && r.status === "ok") { fill = scoreColor(r.total); status = `종합 점수 ${r.total}점`; }
    else if (r && r.status === "over") { fill = GRAY_OVER; status = "예산 초과"; }
    l.setStyle({ fillColor: fill, dashArray: p.match === "approx" ? "3 3" : null, weight: p.match === "approx" ? 1.2 : 1 });
    const basis = !p.legal ? "가격 데이터와 연결되지 않음"
      : `가격은 ${esc(p.legal)} 거래 기준${p.match === "approx" ? " (근사 매핑)" : ""}`;
    const detail = r ? `<br>${esc(describe(r))}` : "";
    l.bindTooltip(`<b>${esc(p.gu)} ${esc(p.hdong)}</b><br>${esc(status)}${detail}<br><small>${basis}</small>`, { sticky: true });
  });
}

const CAT_COLOR = { H: "#c2410c", C: "#2563eb", D: "#7c3aed", K: "#15803d" };

/** 의료기관 점 표시. cats: 보여줄 분류 집합, show: false면 숨김 */
export function showPoints(points, cats, show) {
  if (!map) return;
  if (pointLayer) { map.removeLayer(pointLayer); pointLayer = null; }
  if (!show || !points) return;
  const canvas = L.canvas({ padding: 0.3 });
  pointLayer = L.layerGroup(points.filter((p) => cats.has(p[2])).map((p) =>
    L.circleMarker([p[1], p[0]], { renderer: canvas, radius: p[2] === "H" ? 4 : 2.5, weight: 0.5, color: "#fff", fillColor: CAT_COLOR[p[2]] || "#444", fillOpacity: 0.9 })
      .bindTooltip(esc(p[3] || "의료기관"))));
  pointLayer.addTo(map);
}

/** 분석 지점과 반경 원을 그린다. 지점이 null이면 지운다. */
export function showProbe(point, meters) {
  if (!map) return;
  if (probeLayer) { map.removeLayer(probeLayer); probeLayer = null; }
  if (!point) return;
  probeLayer = L.layerGroup([
    L.circle([point.lat, point.lng], { radius: meters, color: "#1b64da", weight: 2, fillColor: "#3182f6", fillOpacity: 0.12, interactive: false }),
    L.circleMarker([point.lat, point.lng], { radius: 5, color: "#fff", weight: 2, fillColor: "#1b64da", fillOpacity: 1, interactive: false }),
  ]).addTo(map);
}
