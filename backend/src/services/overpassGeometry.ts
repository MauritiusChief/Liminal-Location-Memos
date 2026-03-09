import type {
  Feature,
  Geometry,
  LineString,
  MultiLineString,
  MultiPolygon,
  Point,
  Polygon,
  Position,
} from 'geojson';

export const GEOMETRY_EPSILON = 1e-10;

export type BoundingBox = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

// 这一层只放“与具体业务无关”的纯几何工具。
// normalize 和 micro grid 都可以复用这里的能力，避免两边维护两套点落面逻辑。
export function isPointGeometry(geometry: Geometry): geometry is Point {
  return geometry.type === 'Point';
}

// 这里把 Polygon / MultiPolygon 统一视为“面几何”，
// 后续凡是涉及面积、点落面、面命中判断，都优先走这个守卫。
export function isPolygonalGeometry(geometry: Geometry): geometry is Polygon | MultiPolygon {
  return geometry.type === 'Polygon' || geometry.type === 'MultiPolygon';
}

// 网格里“道路命中格子”主要依赖线几何，因此单独抽一个线类型守卫。
export function isLinearGeometryType(geometry: Geometry): geometry is LineString | MultiLineString {
  return geometry.type === 'LineString' || geometry.type === 'MultiLineString';
}

// Point 坐标统一规整成 [lon, lat]，这样调用方不需要再反复做数组判空和类型判断。
export function extractPointCoordinate(geometry: Geometry): [number, number] | null {
  if (!isPointGeometry(geometry)) {
    return null;
  }

  const coordinates = geometry.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return null;
  }

  const [lon, lat] = coordinates;
  if (typeof lon !== 'number' || typeof lat !== 'number') {
    return null;
  }

  return [lon, lat];
}

// GeoJSON 的 Position 允许有第三维甚至更多维；
// 这里几何工具只关心经纬度，所以只验证前两位是有限数字。
export function isFinitePosition(position: Position): position is [number, number] {
  return (
    Array.isArray(position) &&
    position.length >= 2 &&
    typeof position[0] === 'number' &&
    Number.isFinite(position[0]) &&
    typeof position[1] === 'number' &&
    Number.isFinite(position[1])
  );
}

// ring bbox 用来给 Polygon / MultiPolygon 做快速预筛；
// 真正的空间关系判断仍然交给更精确的函数。
function expandBoundingBoxWithRing(ring: Position[], boundingBox: BoundingBox): void {
  for (const position of ring) {
    if (!isFinitePosition(position)) {
      continue;
    }

    const [x, y] = position;
    boundingBox.minX = Math.min(boundingBox.minX, x);
    boundingBox.minY = Math.min(boundingBox.minY, y);
    boundingBox.maxX = Math.max(boundingBox.maxX, x);
    boundingBox.maxY = Math.max(boundingBox.maxY, y);
  }
}

// line bbox 的用途和 ring 类似，主要服务于“线是否接近某个格子”的判断。
function expandBoundingBoxWithLine(line: Position[], boundingBox: BoundingBox): void {
  for (const position of line) {
    if (!isFinitePosition(position)) {
      continue;
    }

    const [x, y] = position;
    boundingBox.minX = Math.min(boundingBox.minX, x);
    boundingBox.minY = Math.min(boundingBox.minY, y);
    boundingBox.maxX = Math.max(boundingBox.maxX, x);
    boundingBox.maxY = Math.max(boundingBox.maxY, y);
  }
}

// 统一计算 Polygon / MultiPolygon / LineString / MultiLineString 的 bbox，
// 让上层代码可以先用廉价的矩形命中筛掉大多数不相关候选。
export function computeBoundingBox(
  geometry: Polygon | MultiPolygon | LineString | MultiLineString,
): BoundingBox {
  const boundingBox: BoundingBox = {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };

  if (geometry.type === 'Polygon') {
    for (const ring of geometry.coordinates) {
      expandBoundingBoxWithRing(ring, boundingBox);
    }
  } else if (geometry.type === 'MultiPolygon') {
    for (const polygon of geometry.coordinates) {
      for (const ring of polygon) {
        expandBoundingBoxWithRing(ring, boundingBox);
      }
    }
  } else if (geometry.type === 'LineString') {
    expandBoundingBoxWithLine(geometry.coordinates, boundingBox);
  } else {
    for (const line of geometry.coordinates) {
      expandBoundingBoxWithLine(line, boundingBox);
    }
  }

  return boundingBox;
}

// bbox 判断保留一层极小误差，避免浮点比较把边界点误判掉。
export function isPointInBoundingBox(point: [number, number], boundingBox: BoundingBox): boolean {
  const [x, y] = point;
  return (
    x >= boundingBox.minX - GEOMETRY_EPSILON &&
    x <= boundingBox.maxX + GEOMETRY_EPSILON &&
    y >= boundingBox.minY - GEOMETRY_EPSILON &&
    y <= boundingBox.maxY + GEOMETRY_EPSILON
  );
}

// 边界点在本项目里统一视为命中；
// 因此先独立判断“点是否在线段上”，后面的射线法只处理严格内部。
export function isPointOnSegment(point: [number, number], start: [number, number], end: [number, number]): boolean {
  const [px, py] = point;
  const [x1, y1] = start;
  const [x2, y2] = end;

  const cross = (px - x1) * (y2 - y1) - (py - y1) * (x2 - x1);
  if (Math.abs(cross) > GEOMETRY_EPSILON) {
    return false;
  }

  const dot = (px - x1) * (px - x2) + (py - y1) * (py - y2);
  return dot <= GEOMETRY_EPSILON;
}

// 单环的点落面判断采用射线法；
// 一旦命中边界线，上面的 isPointOnSegment 会直接短路返回 true。
export function ringContainsPoint(ring: Position[], point: [number, number]): boolean {
  let inside = false;

  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const previous = ring[(index + ring.length - 1) % ring.length];

    if (!isFinitePosition(current) || !isFinitePosition(previous)) {
      continue;
    }

    if (isPointOnSegment(point, previous, current)) {
      return true;
    }

    const [x, y] = point;
    const [xi, yi] = current;
    const [xj, yj] = previous;
    const intersects = yi > y !== yj > y && x <= ((xj - xi) * (y - yi)) / (yj - yi) + xi + GEOMETRY_EPSILON;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

// Polygon 的语义是“命中 outer ring 且不落在任何 inner ring（洞）里”。
export function polygonContainsPoint(coordinates: Polygon['coordinates'], point: [number, number]): boolean {
  const [outerRing, ...innerRings] = coordinates;
  if (!outerRing || !ringContainsPoint(outerRing, point)) {
    return false;
  }

  return !innerRings.some((ring) => ringContainsPoint(ring, point));
}

// MultiPolygon 只要命中任一子 polygon，就视为命中整个要素。
export function multiPolygonContainsPoint(coordinates: MultiPolygon['coordinates'], point: [number, number]): boolean {
  return coordinates.some((polygon) => polygonContainsPoint(polygon, point));
}

// shoelace 公式在这里不是为了测地精度，
// 而是为了稳定比较两个面“谁更小”，供规则选择更具体的候选。
export function signedRingArea(ring: Position[]): number {
  let area = 0;

  for (let index = 0; index < ring.length; index += 1) {
    const current = ring[index];
    const next = ring[(index + 1) % ring.length];

    if (!isFinitePosition(current) || !isFinitePosition(next)) {
      continue;
    }

    area += current[0] * next[1] - next[0] * current[1];
  }

  return area / 2;
}

// Polygon 面积等于外环面积减去所有洞的面积。
export function polygonArea(coordinates: Polygon['coordinates']): number {
  const [outerRing, ...innerRings] = coordinates;
  if (!outerRing) {
    return 0;
  }

  const outerArea = Math.abs(signedRingArea(outerRing));
  const innerArea = innerRings.reduce((sum, ring) => sum + Math.abs(signedRingArea(ring)), 0);
  return Math.max(0, outerArea - innerArea);
}

// MultiPolygon 的面积就是各子 polygon 面积累加。
export function multiPolygonArea(coordinates: MultiPolygon['coordinates']): number {
  return coordinates.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
}

// 上层经常只关心“这个面要素多大”，不想每次分支判断 Polygon / MultiPolygon。
export function getPolygonalFeatureArea<TProperties>(feature: Feature<Polygon | MultiPolygon, TProperties>): number {
  return feature.geometry.type === 'Polygon'
    ? polygonArea(feature.geometry.coordinates)
    : multiPolygonArea(feature.geometry.coordinates);
}

// 统一包装面要素的点落面判断，减少上层业务代码的几何分支噪音。
export function polygonalGeometryContainsPoint(
  feature: Feature<Polygon | MultiPolygon, unknown>,
  point: [number, number],
): boolean {
  return feature.geometry.type === 'Polygon'
    ? polygonContainsPoint(feature.geometry.coordinates, point)
    : multiPolygonContainsPoint(feature.geometry.coordinates, point);
}

// orientation + segmentsIntersect 这一组工具用于判断“线段是否碰到格子边框”。
// 这对道路之类线要素的网格填充很关键。
function orientation(a: [number, number], b: [number, number], c: [number, number]): number {
  const value = (b[1] - a[1]) * (c[0] - b[0]) - (b[0] - a[0]) * (c[1] - b[1]);
  if (Math.abs(value) <= GEOMETRY_EPSILON) {
    return 0;
  }
  return value > 0 ? 1 : 2;
}

function segmentsIntersect(
  p1: [number, number],
  q1: [number, number],
  p2: [number, number],
  q2: [number, number],
): boolean {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);

  if (o1 !== o2 && o3 !== o4) {
    return true;
  }

  if (o1 === 0 && isPointOnSegment(p2, p1, q1)) {
    return true;
  }
  if (o2 === 0 && isPointOnSegment(q2, p1, q1)) {
    return true;
  }
  if (o3 === 0 && isPointOnSegment(p1, p2, q2)) {
    return true;
  }
  if (o4 === 0 && isPointOnSegment(q1, p2, q2)) {
    return true;
  }

  return false;
}

// 线要素命中格子的规则不要求“格子中心点在线上”，
// 只要线段穿过格子边界，或者任一点落在格子 bbox 内，就认为这个格子被该线触达。
export function lineIntersectsBoundingBox(
  geometry: LineString | MultiLineString,
  boundingBox: BoundingBox,
): boolean {
  const bboxCorners: Array<[number, number]> = [
    [boundingBox.minX, boundingBox.minY],
    [boundingBox.maxX, boundingBox.minY],
    [boundingBox.maxX, boundingBox.maxY],
    [boundingBox.minX, boundingBox.maxY],
  ];
  const bboxEdges: Array<[[number, number], [number, number]]> = [
    [bboxCorners[0], bboxCorners[1]],
    [bboxCorners[1], bboxCorners[2]],
    [bboxCorners[2], bboxCorners[3]],
    [bboxCorners[3], bboxCorners[0]],
  ];

  const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;

  for (const line of lines) {
    for (let index = 1; index < line.length; index += 1) {
      const start = line[index - 1];
      const end = line[index];

      if (!isFinitePosition(start) || !isFinitePosition(end)) {
        continue;
      }

      if (isPointInBoundingBox(start, boundingBox) || isPointInBoundingBox(end, boundingBox)) {
        return true;
      }

      for (const [edgeStart, edgeEnd] of bboxEdges) {
        if (segmentsIntersect(start, end, edgeStart, edgeEnd)) {
          return true;
        }
      }
    }
  }

  return false;
}

// 网格是以“米”为单位设计的，而实际几何是经纬度；
// 这里提供一组足够轻量的近似换算，精度对 60m 局部网格已经够用。
export function metersToLatitudeDegrees(meters: number): number {
  return meters / 111_320;
}

// 经度对应的实际米数会随纬度变化，因此这里要乘上 cos(latitude) 做近似修正。
export function metersToLongitudeDegrees(meters: number, latitude: number): number {
  const cosLatitude = Math.cos((latitude * Math.PI) / 180);
  const safeCosLatitude = Math.max(Math.abs(cosLatitude), GEOMETRY_EPSILON);
  return meters / (111_320 * safeCosLatitude);
}
