// 화면 로직: 매매/전세/월세 탭, 예산 입력, 결과 표.
import { loadData } from "./data.js";
import { MODES, MODE_LABEL, rank } from "./scoring.js";

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

function render() {
  const mode = state.mode;
  const { ok, over, total } = rank(DATA.dongs, mode, state.band, budgetInMan(), { hideLow: state.hideLow });
  $("sum").textContent =
    `${MODE_LABEL[mode]} · ${DATA.bands[state.band]} 기준, 예산 안에 들어오는 동네 ${ok.length}곳 / 거래 데이터가 있는 ${total}곳`;

  const heads = mode === "wolse"
    ? ["#", "동네", "보증금(중앙값)", "월세(중앙값)", "예산 여유", "예산 점수", "거래 수"]
    : ["#", "동네", mode === "trade" ? "매매가(중앙값)" : "전세 보증금(중앙값)", "예산 여유", "예산 점수", "거래 수"];
  const numCols = mode === "wolse" ? [2, 3, 4, 6] : [2, 3, 5];
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
    cell(tr, `${r.d.gu} ${r.d.dong}`);
    if (mode === "wolse") {
      cell(tr, fmtMan(r.stat.median_deposit), "num");
      cell(tr, `${r.stat.median_rent.toLocaleString()}만`, "num");
    } else {
      cell(tr, fmtMan(r.stat.median), "num");
    }
    const pct = Math.round(Math.abs(r.margin) * 100);
    cell(tr, r.status === "over" ? `${pct}% 초과` : `${pct}%`, "num");
    scoreCell(tr, r.score);
    const nTd = cell(tr, r.stat.n, "num");
    if (r.stat.low_sample) {
      const t = document.createElement("span");
      t.className = "tag"; t.textContent = "표본 부족";
      nTd.appendChild(t);
    }
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
  $("note").textContent = mode === "wolse"
    ? "월세는 보증금과 월세를 각각 동네 중앙값과 비교하고, 더 빠듯한 쪽으로 여유율을 계산합니다. 월세 데이터는 보증금과 월세가 따로 있어 한 값으로 합치지 않았습니다."
    : "동네 중앙값과 예산을 비교해 여유율을 계산하고, 여유 50% 이상이면 100점으로 환산합니다. 예산을 넘으면 제외됩니다.";
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
  buildTabs(); buildSliders(); buildBands();
  $("showOut").addEventListener("input", (e) => { state.showOut = e.target.checked; render(); });
  $("hideLow").addEventListener("input", (e) => { state.hideLow = e.target.checked; render(); });
  render();
}
init();
