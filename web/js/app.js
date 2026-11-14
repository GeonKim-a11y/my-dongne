// 화면 로직: 매매/전세/월세 탭, 예산 입력, 결과 표.
import { loadData, loadHospitals, loadParks, loadCctv } from "./data.js";
import { MODES, MODE_LABEL, evaluate } from "./scoring.js";
import { countPerFeature, percentileScores, withinRadius, distM } from "./gis.js";
import { initMap, updateMap, getFeatures, onProbe, showPoints, showParks, showCctv, showProbe } from "./map.js";

const $ = (id) => document.getElementById(id);

// 모드별 입력 슬라이더 정의. toMan: 슬라이더 값 -> 만원
const SLIDERS = {
  trade: [{ id: "price", label: "매매 예산", min: 2, max: 30, step: 0.5, def: 8, fmt: (v) => `${v.toFixed(1)}억 이하`, toMan: (v) => v * 10000 }],
  jeonse: [{ id: "price", label: "전세 보증금 예산", min: 1, max: 20, step: 0.5, def: 5, fmt: (v) => `${v.toFixed(1)}억 이하`, toMan: (v) => v * 10000 }],
  wolse: [
    { id: "deposit", label: "보증금 상한", min: 0.1, max: 5, step: 0.1, def: 1.0, fmt: (v) => `${v.toFixed(1)}억 이하`, toMan: (v) => v * 10000 },
    { id: "rent", label: "월세 상한", min: 20, max: 300, step: 10, def: 150, fmt: (v) => `${v}만원 이하`, toMan: (v) => v },
  ],
};

const state = {
  mode: "trade",
  band: "M",
  hideLow: true,
  expanded: false,
  showOut: false,
  values: Object.fromEntries(MODES.map((m) => [m, Object.fromEntries(SLIDERS[m].map((s) => [s.id, s.def]))])),
};
let DATA = null;
let HOSP = null;       // 의료기관 {points, sample, ...} 또는 null
let CCTV = null;       // CCTV {points:[lng,lat,분류,대수], sample, ...} 또는 null
let PARK = null;       // 공원 {points:[lng,lat,분류,이름,면적㎡], sample, ...} 또는 null
let FEATURES = null;   // 행정동 경계 feature 배열 또는 null
let probe = null;      // 지도에서 찍은 분석 지점 {lng, lat}
const CATS = { H: "병원급", C: "의원", D: "치과", K: "한의원", P: "약국" };
const sel = { cats: new Set(["H", "C"]), wBudget: 3, wMed: 2, wParkArea: 1, wParkCnt: 1, radius: 1000, showPts: false, showParks: false, wSafe: 1, showCctv: false, cctvCats: new Set(["B", "K"]) };
let densityCache = { key: "", map: null };
let parkCache = null;
let cctvCache = null;

function fmtMan(v) {
  return v >= 10000 ? `${(v / 10000).toFixed(1)}억` : `${Math.round(v).toLocaleString()}만`;
}
function budgetInMan() {
  const out = {};
  SLIDERS[state.mode].forEach((s) => (out[s.id] = s.toMan(state.values[state.mode][s.id])));
  return out;
}

function buildTabs() {
  const el = $("tabs");
  el.replaceChildren();
  MODES.forEach((m) => {
    const b = document.createElement("button");
    b.textContent = MODE_LABEL[m];
    b.className = m === state.mode ? "on" : "";
    b.onclick = () => { state.mode = m; buildTabs(); buildSliders(); render(); };
    el.appendChild(b);
  });
}

function buildSliders() {
  const box = $("sliders");
  box.replaceChildren();
  SLIDERS[state.mode].forEach((s) => {
    const wrap = document.createElement("div");
    const label = document.createElement("label");
    const name = document.createElement("span");
    name.textContent = s.label;
    const val = document.createElement("span");
    val.className = "v";
    label.append(name, val);
    const input = document.createElement("input");
    Object.assign(input, { type: "range", min: s.min, max: s.max, step: s.step, value: state.values[state.mode][s.id] });
    const sync = () => { val.textContent = s.fmt(Number(input.value)); };
    input.addEventListener("input", () => { state.values[state.mode][s.id] = Number(input.value); sync(); render(); });
    sync();
    wrap.append(label, input);
    box.appendChild(wrap);
  });
}

function buildBands() {
  const box = $("band");
  box.replaceChildren();
  Object.entries(DATA.bands).forEach(([k, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "chip" + (k === state.band ? " on" : "");
    b.textContent = label.replace(/\s*\(.*\)/, "");           // "중형 (60~85㎡)" -> "중형"
    const m = label.match(/\((.*)\)/);
    if (m) { const small = document.createElement("small"); small.textContent = m[1]; b.append(" ", small); }
    b.onclick = () => { state.band = k; buildBands(); render(); };
    box.appendChild(b);
  });
}

// 분석 단위(행정동) 목록. 경계 파일이 없으면 법정동 단위로 대신한다.
function buildUnits() {
  const legal = new Map(DATA.dongs.map((d) => [`${d.gu} ${d.dong}`, d]));
  if (FEATURES) {
    return FEATURES.map((f) => ({
      key: `${f.properties.gu} ${f.properties.hdong}`, gu: f.properties.gu, name: f.properties.hdong,
      feature: f, d: f.properties.legal ? legal.get(`${f.properties.gu} ${f.properties.legal}`) || null : null,
      approx: f.properties.match === "approx",
    }));
  }
  return DATA.dongs.map((d) => ({ key: `${d.gu} ${d.dong}`, gu: d.gu, name: d.dong, feature: null, d, approx: false }));
}

// 의료기관 밀도(개/㎢)를 행정동별로 구하고 백분위 점수로 바꾼다. 분류 선택이 같으면 재사용.
function medicalByUnit(units) {
  const out = new Map();
  if (!HOSP || !FEATURES) return out;
  const key = [...sel.cats].sort().join("");
  if (densityCache.key !== key) {
    densityCache = { key, map: countPerFeature(FEATURES, HOSP.points, sel.cats) };
  }
  const items = units.filter((u) => u.feature).map((u) => ({ u, m: densityCache.map.get(u.feature) }));
  const scores = percentileScores(items.map((x) => x.m.perKm2));
  items.forEach((x, i) => out.set(x.u.key, { count: x.m.count, perKm2: x.m.perKm2, score: scores[i] }));
  return out;
}

// 공원 면적 비율(행정동 면적 대비 공원 면적)을 구하고 백분위 점수로 바꾼다.
function parkByUnit(units) {
  const out = new Map();
  if (!PARK || !FEATURES) return out;
  if (!parkCache) parkCache = countPerFeature(FEATURES, PARK.points, new Set(["N", "S", "O"]), 4);
  const items = units.filter((u) => u.feature).map((u) => ({ u, m: parkCache.get(u.feature) }));
  const sArea = percentileScores(items.map((x) => x.m.sumPerKm2));   // 면적 비율 기준
  const sCnt = percentileScores(items.map((x) => x.m.perKm2));        // 개수(곳/㎢) 기준
  items.forEach((x, i) => out.set(x.u.key, {
    count: x.m.count, perKm2: x.m.perKm2, area: x.m.sum, ratio: x.m.area > 0 ? x.m.sum / (x.m.area * 1e6) : 0,
    scoreArea: sArea[i], scoreCnt: sCnt[i],
  }));
  return out;
}

// 안전: 방범·어린이보호 목적 CCTV 카메라 대수를 동 면적(㎢)으로 나눈 밀도의 백분위.
function safetyByUnit(units) {
  const out = new Map();
  if (!CCTV || !FEATURES) return out;
  const key = [...sel.cctvCats].sort().join("");
  if (!cctvCache || cctvCache.key !== key) cctvCache = { key, map: countPerFeature(FEATURES, CCTV.points, sel.cctvCats, 3) };
  const items = units.filter((u) => u.feature).map((u) => ({ u, m: cctvCache.map.get(u.feature) }));
  const scores = percentileScores(items.map((x) => x.m.sumPerKm2));
  items.forEach((x, i) => out.set(x.u.key, { cams: x.m.sum, spots: x.m.count, perKm2: x.m.sumPerKm2, score: scores[i] }));
  return out;
}

function priceText(r) {
  const s = r.ev.stat;
  if (!s) return "-";
  return state.mode === "wolse" ? `${fmtMan(s.median_deposit)} / ${s.median_rent.toLocaleString()}만` : fmtMan(s.median);
}

function render() {
  const mode = state.mode;
  const units = buildUnits();
  const med = medicalByUnit(units);
  const useMed = med.size > 0 && sel.wMed > 0;
  const park = parkByUnit(units);
  const hasPark = park.size > 0;
  const wPA = hasPark ? sel.wParkArea : 0, wPC = hasPark ? sel.wParkCnt : 0;
  const usePark = wPA + wPC > 0;
  const safe = safetyByUnit(units);
  const useSafe = safe.size > 0 && sel.wSafe > 0;
  const wS = useSafe ? sel.wSafe : 0;
  const wB = sel.wBudget, wM = useMed ? sel.wMed : 0;
  const budget = budgetInMan();

  const rows = units.map((u) => {
    const ev = u.d ? evaluate(u.d, mode, state.band, budget) : { status: "nodata", stat: null, margin: null, score: null };
    const m = med.get(u.key) || null;
    const pk = park.get(u.key) || null;
    const sf = safe.get(u.key) || null;
    let total = null;
    if (ev.status === "ok") {
      const parts = [[ev.score, wB], [m ? m.score : null, wM], [pk ? pk.scoreArea : null, wPA], [pk ? pk.scoreCnt : null, wPC], [sf ? sf.score : null, wS]].filter(([v, w]) => v !== null && w > 0);
      const wsum = parts.reduce((a, [, w]) => a + w, 0);
      total = wsum ? Math.round(parts.reduce((a, [v, w]) => a + v * w, 0) / wsum) : ev.score;
    }
    const lowHidden = state.hideLow && ev.stat && ev.stat.low_sample;
    const status = lowHidden || ev.status === "nodata" ? "nodata" : ev.status;
    return { u, ev, m, pk, sf, total, status };
  });
  const ok = rows.filter((r) => r.status === "ok").sort((a, b) => b.total - a.total || b.ev.score - a.ev.score);
  const over = rows.filter((r) => r.status === "over").sort((a, b) => b.ev.margin - a.ev.margin);
  const totalN = rows.filter((r) => r.status !== "nodata").length;

  const byKey = new Map(rows.map((r) => [r.u.key, { status: r.status, total: r.total, r }]));
  updateMap(byKey, ({ r }) => {
    const bits = [`가격 ${priceText(r)}`];
    if (r.ev.score !== null) bits.push(`예산 ${r.ev.score}점`);
    if (r.m) bits.push(`의료기관 ${r.m.count}곳 (${r.m.perKm2.toFixed(0)}곳/㎢, ${r.m.score}점)`);
    if (r.sf) bits.push(`CCTV ${Math.round(r.sf.cams).toLocaleString()}대 (${r.sf.perKm2.toFixed(0)}대/㎢, ${r.sf.score}점)`);
    if (r.pk) bits.push(`공원 ${r.pk.count}곳 (면적 비율 ${(Math.min(r.pk.ratio, 1) * 100).toFixed(1)}% ${r.pk.scoreArea}점 · 개수 ${r.pk.scoreCnt}점)`);
    return bits.join(" · ");
  });
  showPoints(HOSP && HOSP.points, sel.cats, sel.showPts);
  showParks(PARK && PARK.points, sel.showParks);
  showCctv(CCTV && CCTV.points, sel.cctvCats, sel.showCctv);

  $("sum").textContent =
    `예산에 맞는 동네 ${ok.length}곳` +
    (useMed || usePark || useSafe ? ` · 예산 ${wB}${useMed ? ` : 의료 ${wM}` : ""}${wPA ? ` : 공원면적 ${wPA}` : ""}${wPC ? ` : 공원개수 ${wPC}` : ""}${wS ? ` : 안전 ${wS}` : ""} 비율` : "");
  $("sumSub").textContent = `${MODE_LABEL[mode]} · ${DATA.bands[state.band]} · 거래 데이터가 있는 ${totalN}곳 중`;

  const list = $("list");
  list.replaceChildren();
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
  const add = (r, no) => {
    const item = el("div", "item" + (r.status === "over" ? " out" : "") + (no && no <= 3 ? " top" : ""));
    item.appendChild(el("div", "rank", no ?? "·"));
    const mid = el("div", "mid");
    const name = el("div", "nm", r.u.name);
    if (r.ev.stat && r.ev.stat.low_sample) name.appendChild(el("span", "tag", "표본 부족"));
    mid.append(name, el("div", "sb", `${r.u.gu} · ${priceText(r)}`));
    const chips = el("div", "chips");
    if (r.ev.score !== null) chips.appendChild(el("span", "mini", `예산 ${r.ev.score}`));
    if (useMed && r.m) chips.appendChild(el("span", "mini", `의료 ${r.m.score} · ${r.m.count}곳`));
    if (useSafe && r.sf) chips.appendChild(el("span", "mini", `안전 ${r.sf.score} · ${Math.round(r.sf.cams).toLocaleString()}대`));
    if (usePark && r.pk) chips.appendChild(el("span", "mini", `공원 면적 ${r.pk.scoreArea} · 개수 ${r.pk.scoreCnt} (${r.pk.count}곳)`));
    mid.appendChild(chips);
    const sc = el("div", "score");
    sc.appendChild(el("b", "", r.total === null ? "-" : String(r.total)));
    sc.appendChild(el("small", "", r.status === "over" ? "예산 초과" : "점"));
    item.append(mid, sc);
    list.appendChild(item);
  };
  const shown = state.expanded ? ok : ok.slice(0, 10);
  shown.forEach((r, i) => add(r, i + 1));
  if (state.showOut) over.forEach((r) => add(r, null));
  if (!ok.length && !(state.showOut && over.length)) list.appendChild(el("div", "empty", "예산 안에 들어오는 동네가 없어요. 예산을 올리거나 면적대를 바꿔 보세요."));
  const more = $("more");
  more.hidden = ok.length <= 10;
  more.textContent = state.expanded ? "접기" : `${ok.length - 10}곳 더 보기`;
  $("note").textContent =
    (mode === "wolse"
      ? "월세는 보증금과 월세를 각각 동네 중앙값과 비교하고, 더 빠듯한 쪽으로 여유율을 계산합니다. "
      : "예산 점수: 동네 중앙값과 예산을 비교해 여유 50% 이상이면 100점으로 환산합니다. 예산을 넘으면 제외됩니다. ") +
    (useMed ? "의료 점수: 행정동 안의 의료기관 수를 면적(㎢)으로 나눈 밀도를 서울 6개 구 행정동끼리 비교한 백분위(0~100)입니다. " : "") +
    (useSafe ? "안전 점수: 방범·어린이보호 목적 CCTV 카메라 대수를 동 면적으로 나눈 밀도의 백분위입니다(CCTV 입력 수준은 지자체마다 달라 구별 차이는 실제 안전도와 다를 수 있습니다). " : "") +
    (usePark ? "공원 면적 점수: 행정동 안 공원 면적 / 동 면적의 백분위, 공원 개수 점수: 행정동 안 공원 수 / 동 면적(곳/㎢)의 백분위입니다. 공원은 중심점 기준이라 큰 공원은 한 동에 몰려 계산됩니다. " : "") +
    "종합 점수는 가중치 비율의 평균입니다. 가격은 법정동 단위라 한 법정동에 여러 행정동이 속하면 같은 값을 씁니다.";
  renderProbe();
}

// 지도에서 찍은 지점의 반경 분석
function renderProbe() {
  const box = $("probe");
  box.hidden = !(HOSP || PARK || CCTV);
  if (box.hidden) return;
  if (!probe) {
    box.textContent = "지도를 눌러 보세요. 그 주변의 의료기관과 공원을 분석해 드려요.";
    showProbe(null, sel.radius);
    return;
  }
  showProbe(probe, sel.radius);
  const r = sel.radius >= 1000 ? `${(sel.radius / 1000).toFixed(1)}km` : `${sel.radius}m`;
  const lines = [`📍 선택한 지점 반경 ${r}`];
  if (HOSP) {
    const hit = withinRadius(HOSP.points, probe.lng, probe.lat, sel.radius, sel.cats);
    const by = {};
    hit.forEach((p) => (by[p[2]] = (by[p[2]] || 0) + 1));
    const parts = Object.keys(CATS).filter((c) => sel.cats.has(c)).map((c) => `${CATS[c]} ${by[c] || 0}곳`);
    let nearest = null;
    for (const p of HOSP.points) {
      if (p[2] !== "H") continue;
      const d = distM(probe.lng, probe.lat, p[0], p[1]);
      if (!nearest || d < nearest.d) nearest = { d, name: p[3] };
    }
    lines.push(`의료기관 ${hit.length}곳 (${parts.join(", ")})` + (nearest ? ` · 가장 가까운 병원급 ${Math.round(nearest.d).toLocaleString()}m` : ""));
  }
  if (PARK) {
    const all = new Set(["N", "S", "O"]);
    const hit = withinRadius(PARK.points, probe.lng, probe.lat, sel.radius, all);
    const area = hit.reduce((a, p) => a + p[4], 0);
    let nearest = null;
    for (const p of PARK.points) {
      if (p[4] < 10000) continue;                       // 1만㎡ 이상 공원만 '가까운 큰 공원'으로
      const d = distM(probe.lng, probe.lat, p[0], p[1]);
      if (!nearest || d < nearest.d) nearest = { d, name: p[3] };
    }
    lines.push(`공원 ${hit.length}곳 (합계 ${Math.round(area).toLocaleString()}㎡)` + (nearest ? ` · 가장 가까운 1만㎡ 이상 공원 ${Math.round(nearest.d).toLocaleString()}m (${nearest.name})` : ""));
  }
  if (CCTV) {
    const hit = withinRadius(CCTV.points, probe.lng, probe.lat, sel.radius, sel.cctvCats);
    lines.push(`CCTV ${hit.reduce((a, p) => a + p[3], 0).toLocaleString()}대 (방범·어린이보호)`);
  }
  box.textContent = lines.join(" · ");
}

function buildControls() {
  const show = (id, on) => { $(id).hidden = !on; };
  show("commonControls", !!(HOSP || PARK || CCTV));
  show("safeControls", !!CCTV);
  show("medControls", !!HOSP);
  show("parkControls", !!PARK);
  show("probeControls", !!(HOSP || PARK || CCTV));
  const mk = (id, key, fmt) => {
    const inp = $(id), out = $(id + "V");
    inp.value = sel[key];
    const sync = () => { out.textContent = fmt(Number(inp.value)); };
    inp.addEventListener("input", () => { sel[key] = Number(inp.value); sync(); render(); });
    sync();
  };
  mk("wBudget", "wBudget", (v) => String(v));
  mk("radius", "radius", (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}km` : `${v}m`));
  if (HOSP) {
    const cats = $("cats");
    cats.replaceChildren();
    Object.entries(CATS).filter(([k]) => !HOSP.categories || k in HOSP.categories).forEach(([k, label]) => {   // 데이터에 있는 종류만
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (sel.cats.has(k) ? " on" : "");
      b.textContent = label;
      b.onclick = () => { sel.cats.has(k) ? sel.cats.delete(k) : sel.cats.add(k); b.classList.toggle("on"); render(); };
      cats.appendChild(b);
    });
    mk("wMed", "wMed", (v) => String(v));
    $("showPts").addEventListener("input", (e) => { sel.showPts = e.target.checked; render(); });
  }
  if (CCTV) {
    mk("wSafe", "wSafe", (v) => String(v));
    $("showCctv").addEventListener("input", (e) => { sel.showCctv = e.target.checked; render(); });
  }
  if (PARK) {
    mk("wParkArea", "wParkArea", (v) => String(v));
    mk("wParkCnt", "wParkCnt", (v) => String(v));
    $("showParks").addEventListener("input", (e) => { sel.showParks = e.target.checked; render(); });
  }
}

async function init() {
  try { DATA = await loadData(); } catch (e) { $("banner").textContent = e.message; return; }
  const b = $("banner");
  if (DATA.sample) {
    b.textContent = "샘플 데이터입니다. 가격은 가상 값이며 실제 시세가 아닙니다. scripts/fetch_prices.py 로 실데이터를 만들면 자동으로 교체됩니다.";
  } else {
    b.className = "banner real";
    const renewal = DATA.rent_new_only ? "전월세는 신규 계약만" : "전월세는 갱신 포함";
    const ms = DATA.months;
    b.textContent = `실거래가 (${ms[ms.length - 1]} ~ ${ms[0]} 계약분, ${ms.length}개월) · ${DATA.gu.join(", ")} · ${renewal} · 생성 ${DATA.generated_at}`;
  }
  const mapOk = await initMap($("map"));
  FEATURES = mapOk ? getFeatures() : null;
  HOSP = FEATURES ? await loadHospitals() : null;   // 의료기관·공원 분석은 경계가 있어야 가능
  PARK = FEATURES ? await loadParks() : null;
  CCTV = FEATURES ? await loadCctv() : null;
  if (HOSP && HOSP.sample) {
    const w = document.createElement("div");
    w.className = "banner";
    w.textContent = "의료기관 위치는 샘플(가상)입니다. 실제 병원 수가 아닙니다. 실데이터 수집이 끝나면 자동으로 교체됩니다.";
    b.after(w);
  }
  if (PARK && PARK.sample) {
    const w = document.createElement("div");
    w.className = "banner";
    w.textContent = "공원 위치·면적은 샘플(가상)입니다. 실제 공원이 아닙니다. 실데이터 수집이 끝나면 자동으로 교체됩니다.";
    b.after(w);
  }
  if (CCTV && CCTV.sample) {
    const w = document.createElement("div");
    w.className = "banner";
    w.textContent = "CCTV 위치·대수는 샘플(가상)입니다. 실제 설치 현황이 아닙니다. 실데이터 수집이 끝나면 자동으로 교체됩니다.";
    b.after(w);
  }
  onProbe((lng, lat) => { if (HOSP || PARK || CCTV) { probe = { lng, lat }; renderProbe(); } });
  buildControls();
  buildTabs(); buildSliders(); buildBands();
  $("more").addEventListener("click", () => { state.expanded = !state.expanded; render(); });
  $("showOut").addEventListener("input", (e) => { state.showOut = e.target.checked; render(); });
  $("hideLow").addEventListener("input", (e) => { state.hideLow = e.target.checked; render(); });
  render();
}
init();
