// 공간 계산 (순수 함수). 지도·화면과 분리해 두어 테스트하기 쉽다. 좌표는 [경도, 위도].

const R = 6371008.8; // 지구 반지름(m)
const rad = (d) => (d * Math.PI) / 180;

/** 두 점 사이 거리(m), haversine */
export function distM(lng1, lat1, lng2, lat2) {
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** geometry(Polygon/MultiPolygon)를 폴리곤 배열로 통일: [ [ring, hole...], ... ] */
function polys(geom) {
  return geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
}

function inRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 점이 도형 안에 있는가 (구멍 처리 포함) */
export function pointInGeom(x, y, geom) {
  return polys(geom).some(([outer, ...holes]) => inRing(x, y, outer) && !holes.some((h) => inRing(x, y, h)));
}

/** 도형 넓이(㎢). 서울 규모에서 정확한 등장방형 근사(위도별 경도 길이 보정). */
export function areaKm2(geom) {
  let total = 0;
  for (const [outer, ...holes] of polys(geom)) {
    const ring = (r) => {
      const lat0 = r.reduce((s, p) => s + p[1], 0) / r.length;
      const kx = (Math.PI / 180) * R * Math.cos(rad(lat0)), ky = (Math.PI / 180) * R;
      let a = 0;
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        a += (r[j][0] * kx) * (r[i][1] * ky) - (r[i][0] * kx) * (r[j][1] * ky);
      }
      return Math.abs(a) / 2;
    };
    total += ring(outer) - holes.reduce((s, h) => s + ring(h), 0);
  }
  return total / 1e6;
}

/**
 * 점들을 행정동 폴리곤에 배정해 센다.
 * features: GeoJSON feature 배열, points: [lng, lat, cat, name], cats: 셀 분류 집합
 * weightIdx: 점 배열에서 합산할 값의 위치(예: 공원 면적). 반환: Map(feature -> {count, sum, perKm2, sumPerKm2, area})
 */
export function countPerFeature(features, points, cats, weightIdx = -1) {
  const use = points.filter((p) => cats.has(p[2]));
  const out = new Map();
  for (const f of features) {
    const area = f._area ?? (f._area = areaKm2(f.geometry));
    if (!f._bbox) {
      let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
      for (const [outer] of polys(f.geometry)) for (const [x, y] of outer) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      f._bbox = [x0, y0, x1, y1];
    }
    const [x0, y0, x1, y1] = f._bbox;
    let count = 0, sum = 0;
    for (const p of use) {
      if (p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) continue;
      if (pointInGeom(p[0], p[1], f.geometry)) { count++; if (weightIdx >= 0) sum += Number(p[weightIdx]) || 0; }
    }
    out.set(f, { count, sum, area, perKm2: area > 0 ? count / area : 0, sumPerKm2: area > 0 ? sum / area : 0 });
  }
  return out;
}

/** 백분위 점수 0~100: 값이 클수록 높음. 같은 값은 같은 점수. */
export function percentileScores(values) {
  const n = values.length;
  if (n <= 1) return values.map(() => 100);
  const sorted = [...values].sort((a, b) => a - b);
  return values.map((v) => {
    const below = sorted.filter((x) => x < v).length;
    const equal = sorted.filter((x) => x === v).length;
    return Math.round(((below + (equal - 1) / 2) / (n - 1)) * 100);
  });
}

/** 한 지점 반경 안의 점들 */
export function withinRadius(points, lng, lat, meters, cats) {
  return points.filter((p) => cats.has(p[2]) && distM(lng, lat, p[0], p[1]) <= meters);
}
