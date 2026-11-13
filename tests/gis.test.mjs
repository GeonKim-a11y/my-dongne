import test from "node:test";
import assert from "node:assert/strict";
import { distM, pointInGeom, areaKm2, countPerFeature, percentileScores, withinRadius } from "../web/js/gis.js";

const sq = { type: "Polygon", coordinates: [[[127, 37.5], [127.01, 37.5], [127.01, 37.51], [127, 37.51], [127, 37.5]]] };

test("거리: 위도 0.01도는 약 1.11km", () => {
  const d = distM(127, 37.5, 127, 37.51);
  assert.ok(d > 1100 && d < 1120, d);
});
test("점이 도형 안/밖", () => {
  assert.equal(pointInGeom(127.005, 37.505, sq), true);
  assert.equal(pointInGeom(127.02, 37.505, sq), false);
});
test("구멍 안의 점은 밖으로 취급", () => {
  const g = { type: "Polygon", coordinates: [sq.coordinates[0], [[127.004, 37.504], [127.006, 37.504], [127.006, 37.506], [127.004, 37.506], [127.004, 37.504]]] };
  assert.equal(pointInGeom(127.005, 37.505, g), false);
  assert.equal(pointInGeom(127.001, 37.501, g), true);
});
test("넓이: 0.01x0.01도 사각형은 약 0.98㎢", () => {
  const a = areaKm2(sq);
  assert.ok(a > 0.95 && a < 1.01, a);
});
test("폴리곤별 개수와 밀도, 분류 필터", () => {
  const f = { geometry: sq };
  const pts = [[127.005, 37.505, "C", "a"], [127.002, 37.502, "H", "b"], [127.5, 37.5, "C", "c"]];
  const r = countPerFeature([f], pts, new Set(["C"])).get(f);
  assert.equal(r.count, 1);
  assert.ok(r.perKm2 > 1);
});
test("백분위 점수", () => {
  assert.deepEqual(percentileScores([1, 2, 3]), [0, 50, 100]);
  assert.deepEqual(percentileScores([5, 5, 5]), [50, 50, 50]);
});
test("반경 안의 점", () => {
  const pts = [[127, 37.5, "C", "near"], [127, 37.52, "C", "far"]];
  assert.equal(withinRadius(pts, 127, 37.5, 500, new Set(["C"])).length, 1);
});

test("가중치(면적) 합계", () => {
  const f = { geometry: sq };
  const pts = [[127.005, 37.505, "N", "a", 3000], [127.002, 37.502, "S", "b", 500]];
  const r = countPerFeature([f], pts, new Set(["N", "S"]), 4).get(f);
  assert.equal(r.sum, 3500);
  assert.ok(r.sumPerKm2 > 3500);
});
