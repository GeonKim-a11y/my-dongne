// 질문 마법사: 한 화면에 질문 하나, 이전/다음, 진행 막대. 답은 steps 안의 build()가 직접 상태에 기록한다.
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/** 선택지를 큰 카드 버튼으로. options: [{v, label, sub}], value: 현재 값, onPick(v) */
export function optionCards(container, options, value, onPick, cls = "opts") {
  container.replaceChildren();
  const wrap = el("div", cls);
  options.forEach((o) => {
    const b = el("button", "opt" + (o.v === value ? " on" : ""));
    b.type = "button";
    b.appendChild(el("b", "", o.label));
    if (o.sub) b.appendChild(el("small", "", o.sub));
    b.onclick = () => {
      wrap.querySelectorAll(".opt").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      onPick(o.v);
    };
    wrap.appendChild(b);
  });
  container.appendChild(wrap);
}

/** 중요도 4단계 */
export const LEVELS = [
  { v: 0, label: "상관없어요" },
  { v: 1, label: "있으면 좋아요" },
  { v: 3, label: "중요해요" },
  { v: 5, label: "아주 중요해요" },
];

export const LEVELS_SHORT = [
  { v: 0, label: "상관없음" },
  { v: 1, label: "조금" },
  { v: 3, label: "중요" },
  { v: 5, label: "매우" },
];

/** 가까운 값으로 맞춰 현재 선택 표시 (0,1,3,5 사이의 값이 들어와도 동작) */
export function nearestLevel(v, levels = LEVELS) {
  return levels.reduce((best, l) => (Math.abs(l.v - v) < Math.abs(best.v - v) ? l : best), levels[0]).v;
}

/**
 * root 안에 마법사를 그린다.
 * steps: [{ id, title, sub, build(body, api), show?() }]  build 는 body 에 질문 UI 를 채운다. api.refresh() 로 다음 버튼 상태 갱신.
 * onDone(): 마지막에서 '결과 보기'를 눌렀을 때.
 */
export function runWizard(root, steps, onDone, startAt = 0) {
  const list = steps.filter((s) => !s.show || s.show());
  let i = Math.min(startAt, list.length - 1);
  const draw = () => {
    const s = list[i];
    root.replaceChildren();
    const bar = el("div", "bar");
    const fill = el("i");
    fill.style.width = `${((i + 1) / list.length) * 100}%`;
    bar.appendChild(fill);
    root.appendChild(bar);
    root.appendChild(el("div", "stepno", `${i + 1} / ${list.length}`));
    root.appendChild(el("h2", "q", s.title));
    if (s.sub) root.appendChild(el("p", "qsub", s.sub));
    const body = el("div", "qbody");
    root.appendChild(body);
    const foot = el("div", "foot");
    const back = el("button", "btn ghost", "이전");
    back.type = "button";
    back.disabled = i === 0;
    back.onclick = () => { i -= 1; draw(); };
    const next = el("button", "btn", i === list.length - 1 ? "결과 보기" : "다음");
    next.type = "button";
    next.onclick = () => { if (i === list.length - 1) onDone(); else { i += 1; draw(); } };
    foot.append(back, next);
    root.appendChild(foot);
    s.build(body, { refresh: () => { next.disabled = !!(s.invalid && s.invalid()); } });
    next.disabled = !!(s.invalid && s.invalid());
    window.scrollTo({ top: root.getBoundingClientRect().top + window.scrollY - 12, behavior: "smooth" });
  };
  draw();
}
