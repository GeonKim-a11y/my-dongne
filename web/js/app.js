// 화면 로직: 매매/전세/월세 탭, 예산 입력, 결과 표.
import { loadData, loadHospitals } from "./data.js";
import { MODES, MODE_LABEL, evaluate } from "./scoring.js";
import { countPerFeature, percentileScores, withinRadius, distM } from "./gis.js";
import { initMap, updateMap, getFeatures, onProbe, showPoints, showProbe } from "./map.js";

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
  showOut: false,
  values: Object.fromEntries(MODES.map((m) => [m, Object.fromEntries(SLIDERS[m].map((s) => [s.id, s.def]))])),
};
let DATA = null;
let HOSP = null;       // 의료기관 {points, sample, ...} 또는 null
let FEATURES = null;   // 행정동 경계 feature 배열 또는 null
let probe = null;      // 지도에서 찍은 분석 지점 {lng, lat}
const CATS = { H: "병원급", C: "의원", D: "치과", K: "한의원" };
const sel = { cats: new Set(["H", "C"]), wBudget: 3, wMed: 2, radius: 1000, showPts: false };
let densityCache = { key: "", map: null };

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
  const sel = $("band");
  sel.replaceChildren();
  Object.entries(DATA.bands).forEach(([k, label]) => {
    const o = document.createElement("option");
    o.value = k; o.textContent = label;
    if (k === state.band) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener("input", () => { state.band = sel.value; render(); });
}

function cell(tr, text, cls) {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  tr.appendChild(td);
  return td;
}
function scoreCell(tr, score) {
  const td = document.createElement("td");
  const bar = document.createElement("span");
  bar.className = "bar";
  const fill = document.createElement("b");
  fill.style.width = `${score ?? 0}%`;
  bar.appendChild(fill);
  td.append(bar, document.createTextNode(score === null ? "-" : String(score)));
  tr.appendChild(td);
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
  const wB = sel.wBudget, wM = useMed ? sel.wMed : 0;
  const budget = budgetInMan();

  const rows = units.map((u) => {
    const ev = u.d ? evaluate(u.d, mode, state.band, budget) : { status: "nodata", stat: null, margin: null, score: null };
    const m = med.get(u.key) || null;
    let total = null;
    if (ev.status === "ok") {
      const parts = [[ev.score, wB], [m ? m.score : null, wM]].filter(([v, w]) => v !== null && w > 0);
      const wsum = parts.reduce((a, [, w]) => a + w, 0);
      total = wsum ? Math.round(parts.reduce((a, [v, w]) => a + v * w, 0) / wsum) : ev.score;
    }
    const lowHidden = state.hideLow && ev.stat && ev.stat.low_sample;
    const status = lowHidden || ev.status === "nodata" ? "nodata" : ev.status;
    return { u, ev, m, total, status };
  });
  const ok = rows.filter((r) => r.status === "ok").sort((a, b) => b.total - a.total || b.ev.score - a.ev.score);
  const over = rows.filter((r) => r.status === "over").sort((a, b) => b.ev.margin - a.ev.margin);
  const totalN = rows.filter((r) => r.status !== "nodata").length;

  const byKey = new Map(rows.map((r) => [r.u.key, { status: r.status, total: r.total, r }]));
  updateMap(byKey, ({ r }) => {
    const bits = [`가격 ${priceText(r)}`];
    if (r.ev.score !== null) bits.push(`예산 ${r.ev.score}점`);
    if (r.m) bits.push(`의료기관 ${r.m.count}곳 (${r.m.perKm2.toFixed(0)}곳/㎢, ${r.m.score}점)`);
    return bits.join(" · ");
  });
  showPoints(HOSP && HOSP.points, sel.cats, sel.showPts);

  $("sum").textContent =
    `${MODE_LABEL[mode]} · ${DATA.bands[state.band]} 기준, 예산 안에 들어오는 동네 ${ok.length}곳 / 거래 데이터가 있는 ${totalN}곳` +
    (useMed ? ` · 예산 ${wB} : 의료 ${wM} 비율로 종합` : "");

  const heads = ["#", "동네", mode === "wolse" ? "보증금 / 월세(중앙값)" : mode === "trade" ? "매매가(중앙값)" : "전세 보증금(중앙값)",
    "예산 점수", ...(useMed ? ["의료기관", "의료 점수"] : []), "종합 점수"];
  const numCols = [2, ...(useMed ? [4] : [])];
  const thead = $("head");
  thead.replaceChildren();
  heads.forEach((h, i) => {
    const th = document.createElement("th");
    th.textContent = h;
    if (numCols.includes(i)) th.className = "num";
    thead.appendChild(th);
  });

  const tb = $("rows");
  tb.replaceChildren();
  const add = (r, no) => {
    const tr = document.createElement("tr");
    if (r.status === "over") tr.className = "out";
    cell(tr, no ?? "-");
    const nameTd = cell(tr, `${r.u.gu} ${r.u.name}`);
    if (r.ev.stat && r.ev.stat.low_sample) {
      const t = document.createElement("span");
      t.className = "tag"; t.textContent = "표본 부족";
      nameTd.appendChild(t);
    }
    cell(tr, priceText(r), "num");
    scoreCell(tr, r.ev.score);
    if (useMed) {
      cell(tr, r.m ? `${r.m.count}곳 · ${r.m.perKm2.toFixed(0)}/㎢` : "-", "num");
      scoreCell(tr, r.m ? r.m.score : null);
    }
    scoreCell(tr, r.total);
    tb.appendChild(tr);
  };
  ok.forEach((r, i) => add(r, i + 1));
  if (state.showOut) over.forEach((r) => add(r, null));
  if (!ok.length && !(state.showOut && over.length)) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = heads.length;
    td.className = "empty";
    td.textContent = "예산 안에 들어오는 동네가 없습니다. 예산을 올리거나 면적대를 바꿔 보세요.";
    tr.appendChild(td);
    tb.appendChild(tr);
  }
  $("note").textContent =
    (mode === "wolse"
      ? "월세는 보증금과 월세를 각각 동네 중앙값과 비교하고, 더 빠듯한 쪽으로 여유율을 계산합니다. "
      : "예산 점수: 동네 중앙값과 예산을 비교해 여유 50% 이상이면 100점으로 환산합니다. 예산을 넘으면 제외됩니다. ") +
    (useMed ? "의료 점수: 행정동 안의 의료기관 수를 면적(㎢)으로 나눈 밀도를 서울 6개 구 행정동끼리 비교한 백분위(0~100)입니다. " : "") +
    "종합 점수는 가중치 비율의 평균입니다. 가격은 법정동 단위라 한 법정동에 여러 행정동이 속하면 같은 값을 씁니다.";
  renderProbe();
}

// 지도에서 찍은 지점의 반경 분석
function renderProbe() {
  const box = $("probe");
  if (!HOSP) { box.textContent = ""; return; }
  if (!probe) {
    box.textContent = "지도를 클릭하면 그 지점에서 반경 안의 의료기관을 분석합니다.";
    showProbe(null, sel.radius);
    return;
  }
  showProbe(probe, sel.radius);
  const all = HOSP.points;
  const hit = withinRadius(all, probe.lng, probe.lat, sel.radius, sel.cats);
  const by = {};
  hit.forEach((p) => (by[p[2]] = (by[p[2]] || 0) + 1));
  const parts = Object.keys(CATS).filter((c) => sel.cats.has(c)).map((c) => `${CATS[c]} ${by[c] || 0}곳`);
  let nearest = null;
  for (const p of all) {
    if (p[2] !== "H") continue;
    const d = distM(probe.lng, probe.lat, p[0], p[1]);
    if (!nearest || d < nearest.d) nearest = { d, name: p[3] };
  }
  const r = sel.radius >= 1000 ? `${(sel.radius / 1000).toFixed(1)}km` : `${sel.radius}m`;
  box.textContent = `📍 선택한 지점 반경 ${r}: 의료기관 ${hit.length}곳 (${parts.join(", ")})` +
    (nearest ? ` · 가장 가까운 병원급 ${Math.round(nearest.d).toLocaleString()}m (${nearest.name})` : "");
}

function buildMedControls() {
  const box = $("medControls");
  if (!HOSP) { box.hidden = true; return; }
  box.hidden = false;
  const cats = $("cats");
  cats.replaceChildren();
  Object.entries(CATS).forEach(([k, label]) => {
    const l = document.createElement("label");
    l.className = "chk";
    const c = document.createElement("input");
    c.type = "checkbox"; c.checked = sel.cats.has(k);
    c.addEventListener("input", () => { c.checked ? sel.cats.add(k) : sel.cats.delete(k); render(); });
    l.append(c, document.createTextNode(` ${label}`));
    cats.appendChild(l);
  });
  const mk = (id, key, fmt) => {
    const inp = $(id), out = $(id + "V");
    inp.value = sel[key];
    const sync = () => { out.textContent = fmt(Number(inp.value)); };
    inp.addEventListener("input", () => { sel[key] = Number(inp.value); sync(); render(); });
    sync();
  };
  mk("wBudget", "wBudget", (v) => String(v));
  mk("wMed", "wMed", (v) => String(v));
  mk("radius", "radius", (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}km` : `${v}m`));
  $("showPts").addEventListener("input", (e) => { sel.showPts = e.target.checked; render(); });
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
  HOSP = FEATURES ? await loadHospitals() : null;   // 의료기관 분석은 경계가 있어야 가능
  if (HOSP && HOSP.sample) {
    const w = document.createElement("div");
    w.className = "banner";
    w.textContent = "의료기관 위치는 샘플(가상)입니다. 실제 병원 수가 아닙니다. 실데이터 수집이 끝나면 자동으로 교체됩니다.";
    b.after(w);
  }
  onProbe((lng, lat) => { if (HOSP) { probe = { lng, lat }; renderProbe(); } });
  buildMedControls();
  buildTabs(); buildSliders(); buildBands();
  $("showOut").addEventListener("input", (e) => { state.showOut = e.target.checked; render(); });
  $("hideLow").addEventListener("input", (e) => { state.hideLow = e.target.checked; render(); });
  render();
}
init();
