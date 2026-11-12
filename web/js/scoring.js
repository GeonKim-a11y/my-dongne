// 점수 계산 (순수 함수만). 화면과 분리해 두어서 테스트하거나 다른 지표 모듈과 합치기 쉽다.
// 금액 단위는 모두 만원.

export const MODES = ["trade", "jeonse", "wolse"];
export const MODE_LABEL = { trade: "매매", jeonse: "전세", wolse: "월세" };

export function getStat(dong, mode, band) {
  return (dong[mode] && dong[mode][band]) || null;
}

/**
 * 한 동네가 예산에 맞는지 평가한다.
 * budget: 매매/전세 {price}, 월세 {deposit, rent}  (만원)
 * 반환: {status: "ok"|"over"|"nodata", margin, score, stat}
 *   margin = 예산 대비 여유율 (월세는 보증금·월세 중 더 빠듯한 쪽)
 *   score  = 여유율 0~50%를 0~100점으로 환산 (예산 초과면 null)
 */
export function evaluate(dong, mode, band, budget) {
  const stat = getStat(dong, mode, band);
  if (!stat) return { status: "nodata", stat: null, margin: null, score: null };

  let margin;
  if (mode === "wolse") {
    const mDep = (budget.deposit - stat.median_deposit) / budget.deposit;
    const mRent = (budget.rent - stat.median_rent) / budget.rent;
    margin = Math.min(mDep, mRent);
  } else {
    margin = (budget.price - stat.median) / budget.price;
  }
  if (margin < 0) return { status: "over", stat, margin, score: null };
  return { status: "ok", stat, margin, score: Math.round(Math.min(1, margin / 0.5) * 100) };
}

/** 모든 동네를 평가하고 예산 안(ok)은 점수순, 초과(over)는 부담 적은 순으로 나눠 돌려준다. */
export function rank(dongs, mode, band, budget, { hideLow = true } = {}) {
  const rows = dongs
    .map((d) => ({ d, ...evaluate(d, mode, band, budget) }))
    .filter((r) => r.status !== "nodata" && !(hideLow && r.stat.low_sample));
  const ok = rows.filter((r) => r.status === "ok").sort((a, b) => b.score - a.score || b.margin - a.margin);
  const over = rows.filter((r) => r.status === "over").sort((a, b) => b.margin - a.margin);
  return { ok, over, total: rows.length };
}
