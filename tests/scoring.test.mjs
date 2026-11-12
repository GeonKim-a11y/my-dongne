// 실행: node --test tests/scoring.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, rank } from "../web/js/scoring.js";

const dong = (name, extra) => ({ gu: "테스트구", dong: name, trade: {}, jeonse: {}, wolse: {}, ...extra });
const A = dong("가동", { trade: { M: { n: 10, median: 60000, low_sample: false } },
  jeonse: { M: { n: 9, median: 30000, low_sample: false } },
  wolse: { M: { n: 8, median_deposit: 5000, median_rent: 80, low_sample: false } } });
const B = dong("나동", { trade: { M: { n: 10, median: 90000, low_sample: false } } });
const C = dong("다동", { trade: { M: { n: 1, median: 50000, low_sample: true } } });

test("매매: 예산 초과는 over, 여유 50%면 100점", () => {
  assert.equal(evaluate(B, "trade", "M", { price: 80000 }).status, "over");
  const r = evaluate(A, "trade", "M", { price: 120000 });   // 여유 50%
  assert.equal(r.status, "ok");
  assert.equal(r.score, 100);
  assert.equal(evaluate(A, "trade", "M", { price: 60000 }).score, 0);  // 딱 맞으면 0점
});

test("전세도 같은 방식", () => {
  assert.equal(evaluate(A, "jeonse", "M", { price: 40000 }).status, "ok");
  assert.equal(evaluate(A, "jeonse", "M", { price: 20000 }).status, "over");
});

test("월세: 보증금과 월세 중 더 빠듯한 쪽 기준", () => {
  const r = evaluate(A, "wolse", "M", { deposit: 10000, rent: 100 });
  assert.equal(r.status, "ok");
  assert.ok(Math.abs(r.margin - 0.2) < 1e-9);               // 월세 여유 20%가 더 작다
  assert.equal(evaluate(A, "wolse", "M", { deposit: 10000, rent: 70 }).status, "over");
});

test("데이터 없는 면적대는 nodata", () => {
  assert.equal(evaluate(A, "trade", "L", { price: 99999 }).status, "nodata");
});

test("rank: 표본 부족 제외 옵션과 정렬", () => {
  const dongs = [A, B, C];
  const hide = rank(dongs, "trade", "M", { price: 100000 }, { hideLow: true });
  assert.deepEqual(hide.ok.map((r) => r.d.dong), ["가동", "나동"]);
  assert.equal(hide.total, 2);
  const show = rank(dongs, "trade", "M", { price: 100000 }, { hideLow: false });
  assert.deepEqual(show.ok.map((r) => r.d.dong), ["다동", "가동", "나동"]); // 여유 큰 순
});
