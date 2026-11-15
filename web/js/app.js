// 화면 로직: 매매/전세/월세 탭, 예산 입력, 결과 표.
import { loadData, loadHospitals, loadParks, loadCctv } from "./data.js";
import { MODES, MODE_LABEL, evaluate } from "./scoring.js";
import { countPerFeature, percentileScores, withinRadius, distM, centroid } from "./gis.js";
import { runWizard, optionCards, LEVELS, nearestLevel } from "./wizard.js";
import { initMap, updateMap, getFeatures, onProbe, showPoints, showParks, showCctv, showProbe, showWork, createPicker, refreshMap } from "./map.js";

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
const sel = { cats: new Set(["H", "C"]), wBudget: 3, wMed: 2, wParkArea: 1, wParkCnt: 1, radius: 1000, showPts: false, showParks: false, wSafe: 1, showCctv: false, cctvCats: new Set(["B", "K"]), wCommute: 0, work: null };
let densityCache = { key: "", map: null };
let parkCache = null;
let cctvCache = null;
let centroidCache = null;
const syncers = [];     // 슬라이더 값 표시를 sel 에서 다시 맞추는 함수들
let wizardStep = 0;

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

// 통근: 행정동 중심점에서 직장까지 직선거리(km). 가까울수록 높은 점수(백분위).
function commuteByUnit(units) {
  const out = new Map();
  if (!sel.work || !FEATURES) return out;
  if (!centroidCache) centroidCache = new Map(FEATURES.map((f) => [f, centroid(f.geometry)]));
  const items = units.filter((u) => u.feature).map((u) => {
    const [lng, lat] = centroidCache.get(u.feature);
    return { u, km: distM(sel.work.lng, sel.work.lat, lng, lat) / 1000 };
  });
  const scores = percentileScores(items.map((x) => -x.km));
  items.forEach((x, i) => out.set(x.u.key, { km: x.km, score: scores[i] }));
  return out;
}

// '왜 이 동네' 한 줄: 내가 중요하게 본 항목 중 강점(60점 이상)과 약점(30점 미만)
function reasonsOf(r, f) {
  const items = [];
  if (r.ev.score !== null && f.wB > 0) items.push([f.wB, r.ev.score, "예산 여유"]);
  if (f.useMed && r.m) items.push([f.wM, r.m.score, "병원·약국 밀도"]);
  if (f.usePark && r.pk) items.push([Math.max(f.wPA, f.wPC), Math.max(r.pk.scoreArea, r.pk.scoreCnt), "공원"]);
  if (f.useSafe && r.sf) items.push([f.wS, r.sf.score, "CCTV 밀도"]);
  if (f.useComm && r.cm) items.push([f.wC, r.cm.score, `직장 거리(${r.cm.km.toFixed(1)}km)`]);
  const strong = items.filter(([, sc]) => sc >= 60).sort((a, b) => b[0] * b[1] - a[0] * a[1]).slice(0, 3);
  const weak = items.filter(([w, sc]) => w >= 3 && sc < 30);
  if (!strong.length && !weak.length) return null;
  const d = document.createElement("div");
  d.className = "why";
  if (strong.length) {
    const b = document.createElement("b");
    b.textContent = strong.map(([, sc, n]) => (n === "예산 여유" ? `예산 여유 ${sc}점` : `${n} 상위 ${Math.max(1, 100 - sc)}%`)).join(" · ");
    d.appendChild(b);
  }
  if (weak.length) {
    const w = document.createElement("span");
    w.className = "weak";
    w.textContent = (strong.length ? " / " : "") + "아쉬운 점: " + weak.map(([, , n]) => n).join(", ");
    d.appendChild(w);
  }
  return d;
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
  const comm = commuteByUnit(units);
  const useComm = comm.size > 0 && sel.wCommute > 0;
  const wC = useComm ? sel.wCommute : 0;
  const wB = sel.wBudget, wM = useMed ? sel.wMed : 0;
  const budget = budgetInMan();

  const rows = units.map((u) => {
    const ev = u.d ? evaluate(u.d, mode, state.band, budget) : { status: "nodata", stat: null, margin: null, score: null };
    const m = med.get(u.key) || null;
    const pk = park.get(u.key) || null;
    const sf = safe.get(u.key) || null;
    const cm = comm.get(u.key) || null;
    let total = null;
    if (ev.status === "ok") {
      const parts = [[ev.score, wB], [m ? m.score : null, wM], [pk ? pk.scoreArea : null, wPA], [pk ? pk.scoreCnt : null, wPC], [sf ? sf.score : null, wS], [cm ? cm.score : null, wC]].filter(([v, w]) => v !== null && w > 0);
      const wsum = parts.reduce((a, [, w]) => a + w, 0);
      total = wsum ? Math.round(parts.reduce((a, [v, w]) => a + v * w, 0) / wsum) : ev.score;
    }
    const lowHidden = state.hideLow && ev.stat && ev.stat.low_sample;
    const status = lowHidden || ev.status === "nodata" ? "nodata" : ev.status;
    return { u, ev, m, pk, sf, cm, total, status };
  });
  const ok = rows.filter((r) => r.status === "ok").sort((a, b) => b.total - a.total || b.ev.score - a.ev.score);
  const over = rows.filter((r) => r.status === "over").sort((a, b) => b.ev.margin - a.ev.margin);
  const totalN = rows.filter((r) => r.status !== "nodata").length;

  const byKey = new Map(rows.map((r) => [r.u.key, { status: r.status, total: r.total, r }]));
  updateMap(byKey, ({ r }) => {
    const bits = [`가격 ${priceText(r)}`];
    if (r.ev.score !== null) bits.push(`예산 ${r.ev.score}점`);
    if (r.m) bits.push(`의료기관 ${r.m.count}곳 (${r.m.perKm2.toFixed(0)}곳/㎢, ${r.m.score}점)`);
    if (r.cm) bits.push(`직장까지 ${r.cm.km.toFixed(1)}km`);
    if (r.sf) bits.push(`CCTV ${Math.round(r.sf.cams).toLocaleString()}대 (${r.sf.perKm2.toFixed(0)}대/㎢, ${r.sf.score}점)`);
    if (r.pk) bits.push(`공원 ${r.pk.count}곳 (면적 비율 ${(Math.min(r.pk.ratio, 1) * 100).toFixed(1)}% ${r.pk.scoreArea}점 · 개수 ${r.pk.scoreCnt}점)`);
    return bits.join(" · ");
  });
  showPoints(HOSP && HOSP.points, sel.cats, sel.showPts);
  showParks(PARK && PARK.points, sel.showParks);
  showCctv(CCTV && CCTV.points, sel.cctvCats, sel.showCctv);
  showWork(sel.work);

  $("sum").textContent = ok.length ? `나에게 맞는 동네 ${ok.length}곳을 순위로 정리했어요` : "조건에 맞는 동네가 없어요";
  const prof = $("profile");
  prof.replaceChildren();
  const pchip = (t) => { const e = document.createElement("span"); e.className = "mini"; e.textContent = t; prof.appendChild(e); };
  const lvl = (w) => (LEVELS.find((l) => l.v === nearestLevel(w)) || LEVELS[0]).label;
  pchip(`예산 ${lvl(wB)}`);
  if (useMed) pchip(`의료 ${lvl(wM)}`);
  if (usePark) pchip(`공원 ${lvl(Math.max(wPA, wPC))}`);
  if (useSafe) pchip(`안전 ${lvl(wS)}`);
  if (useComm) pchip(`통근 ${lvl(wC)}`);
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
    if (useComm && r.cm) chips.appendChild(el("span", "mini", `직장 ${r.cm.km.toFixed(1)}km`));
    mid.appendChild(chips);
    if (no) {
      const why = reasonsOf(r, { useMed, usePark, useSafe, useComm, wM, wPA, wPC, wS, wC, wB });
      if (why) mid.appendChild(why);
    }
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
    (useComm ? "직장 점수: 동 중심점에서 직장까지 직선거리가 가까울수록 높은 백분위입니다(실제 대중교통 시간과는 다를 수 있습니다). " : "") +
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
  show("commuteControls", !!FEATURES);
  show("probeControls", !!(HOSP || PARK || CCTV));
  const mk = (id, key, fmt) => {
    const inp = $(id), out = $(id + "V");
    const sync = () => { inp.value = sel[key]; out.textContent = fmt(Number(inp.value)); };
    inp.addEventListener("input", () => { sel[key] = Number(inp.value); out.textContent = fmt(Number(inp.value)); render(); });
    syncers.push(sync);
    sync();
  };
  mk("wBudget", "wBudget", (v) => String(v));
  mk("radius", "radius", (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}km` : `${v}m`));
  mk("wCommute", "wCommute", (v) => String(v));
  if (HOSP) {
    const cats = $("cats");
    cats.replaceChildren();
    Object.entries(CATS).filter(([k]) => !HOSP.categories || k in HOSP.categories).forEach(([k, label]) => {   // 데이터에 있는 종류만
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip" + (sel.cats.has(k) ? " on" : "");
      b.textContent = label;
      b.dataset.cat = k;
      b.onclick = () => { sel.cats.has(k) ? sel.cats.delete(k) : sel.cats.add(k); b.classList.toggle("on"); render(); };
      cats.appendChild(b);
    });
    syncers.push(() => cats.querySelectorAll(".chip").forEach((c) => c.classList.toggle("on", sel.cats.has(c.dataset.cat))));
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
  syncers.push(() => {
    $("workInfo").textContent = sel.work ? `직장 위치: 위도 ${sel.work.lat.toFixed(4)}, 경도 ${sel.work.lng.toFixed(4)} (질문 다시 하기에서 바꿀 수 있어요)` : "직장 위치를 아직 고르지 않았어요. 질문 다시 하기에서 고를 수 있어요.";
  });
}

// ---------- 질문 마법사 ----------
const BAND_HINT = { S: "혼자 · 신혼", M: "2~3인 가족", L: "4인 이상" };

function buildWizardSteps() {
  const steps = [];
  steps.push({
    title: "어떤 형태의 집을 찾으세요?",
    build(body) {
      optionCards(body, MODES.map((m) => ({ v: m, label: MODE_LABEL[m] })), state.mode, (v) => { state.mode = v; }, "opts row");
    },
  });
  steps.push({
    title: "예산은 어느 정도예요?",
    sub: "이 금액을 넘는 동네는 순위에서 빠져요.",
    build(body) {
      const box = document.createElement("div");
      body.appendChild(box);
      const draw = () => {
        box.replaceChildren();
        SLIDERS[state.mode].forEach((sl) => {
          const wrap = document.createElement("div");
          wrap.style.marginBottom = "18px";
          const label = document.createElement("label");
          const name = document.createElement("span");
          name.textContent = sl.label;
          const val = document.createElement("span");
          val.className = "v";
          label.append(name, val);
          const input = document.createElement("input");
          Object.assign(input, { type: "range", min: sl.min, max: sl.max, step: sl.step, value: state.values[state.mode][sl.id] });
          const sync = () => { val.textContent = sl.fmt(Number(input.value)); };
          input.addEventListener("input", () => { state.values[state.mode][sl.id] = Number(input.value); sync(); });
          sync();
          wrap.append(label, input);
          box.appendChild(wrap);
        });
      };
      draw();
      const q = document.createElement("div");
      q.className = "qgap";
      const l = document.createElement("label");
      l.style.marginBottom = "10px";
      l.textContent = "필요한 크기는요?";
      const hold = document.createElement("div");
      q.append(l, hold);
      body.appendChild(q);
      optionCards(hold, Object.entries(DATA.bands).map(([k, label]) => ({ v: k, label: label.replace(/\s*\(.*\)/, ""), sub: `${(label.match(/\((.*)\)/) || [])[1] || ""}${BAND_HINT[k] ? " · " + BAND_HINT[k] : ""}` })), state.band, (v) => { state.band = v; }, "opts row");
    },
  });
  const level = (title, sub, key, show, extra) => ({
    title, sub, show,
    build(body) {
      optionCards(body, LEVELS, nearestLevel(Array.isArray(key) ? sel[key[0]] : sel[key]), (v) => {
        (Array.isArray(key) ? key : [key]).forEach((k) => { sel[k] = v; });
      });
      if (extra) extra(body);
    },
  });
  steps.push(level("병원·약국이 가까운 게 얼마나 중요해요?", "동네 안의 의료기관 밀도(㎢당 개수)로 비교해요.", "wMed", () => !!HOSP, (body) => {
    if (!(HOSP.categories && "P" in HOSP.categories)) return;
    const l = document.createElement("label");
    l.className = "chk qgap";
    const c = document.createElement("input");
    c.type = "checkbox";
    c.checked = sel.cats.has("P");
    c.addEventListener("input", () => { c.checked ? sel.cats.add("P") : sel.cats.delete("P"); });
    l.append(c, document.createTextNode(" 약국도 함께 셀게요"));
    body.appendChild(l);
  }));
  steps.push(level("집 근처에 공원이 있으면 좋겠어요?", "공원 면적 비율과 공원 개수를 함께 봐요.", ["wParkArea", "wParkCnt"], () => !!PARK));
  steps.push(level("방범·안전은 얼마나 신경 쓰세요?", "방범·어린이보호 CCTV 밀도로 비교해요. 지자체마다 등록 수준이 달라 참고용이에요.", "wSafe", () => !!CCTV));
  steps.push({
    title: "직장(또는 학교)은 어디예요?",
    sub: "지도를 눌러 위치를 고르면, 가까운 동네에 점수를 더 줘요. 건너뛰어도 돼요.",
    show: () => !!FEATURES,
    build(body, api) {
      const mapEl = document.createElement("div");
      mapEl.className = "pick";
      const info = document.createElement("p");
      info.className = "picked";
      const setInfo = () => { info.textContent = sel.work ? "✔ 위치를 골랐어요. 눌러서 바꿀 수 있어요." : ""; };
      setInfo();
      body.append(mapEl, info);
      createPicker(mapEl, FEATURES, sel.work, (lng, lat) => { sel.work = { lng, lat }; if (!sel.wCommute) sel.wCommute = 3; setInfo(); drawLevel(); });
      const lv = document.createElement("div");
      lv.className = "qgap";
      const l = document.createElement("label");
      l.style.marginBottom = "10px";
      l.textContent = "직장 가까움은 얼마나 중요해요?";
      const hold = document.createElement("div");
      lv.append(l, hold);
      body.appendChild(lv);
      const drawLevel = () => { lv.hidden = !sel.work; optionCards(hold, LEVELS.slice(1), nearestLevel(sel.wCommute || 3), (v) => { sel.wCommute = v; }); };
      drawLevel();
      const skip = document.createElement("button");
      skip.type = "button";
      skip.className = "skip";
      skip.textContent = "직장은 따로 없어요 (건너뛰기)";
      skip.onclick = () => { sel.work = null; sel.wCommute = 0; finishWizard(); };
      body.appendChild(skip);
    },
  });
  steps.push({
    title: "예산 여유는 얼마나 중요해요?",
    sub: "높을수록 예산보다 싼 동네가 위로 올라와요. 낮으면 예산 안에서 다른 조건을 우선해요.",
    build(body) { optionCards(body, LEVELS.slice(1), nearestLevel(sel.wBudget), (v) => { sel.wBudget = v; }); },
  });
  return steps;
}

function startWizard(at = 0) {
  $("results").hidden = true;
  $("wizard").hidden = false;
  runWizard($("wizard"), buildWizardSteps(), finishWizard, at);
}

function finishWizard() {
  $("wizard").hidden = true;
  $("results").hidden = false;
  state.expanded = false;
  syncers.forEach((f) => f());
  buildTabs(); buildSliders(); buildBands();
  render();
  refreshMap();
  window.scrollTo({ top: 0, behavior: "smooth" });
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
  $("redo").addEventListener("click", () => startWizard(0));
  $("more").addEventListener("click", () => { state.expanded = !state.expanded; render(); });
  $("showOut").addEventListener("input", (e) => { state.showOut = e.target.checked; render(); });
  $("hideLow").addEventListener("input", (e) => { state.hideLow = e.target.checked; render(); });
  startWizard(0);
}
init();
