import osmtogeojson from 'osmtogeojson';
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Point, Polygon, Position } from 'geojson';

export interface NormalizedOverpassRequest {
  lat: number;
  lon: number;
  radius: number;
  includeRaw?: boolean;
}

export interface RelationReference {
  role: string;
  rel: number;
  reltags: Record<string, string>;
}

export interface ContainedPoi {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  relations: RelationReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
  coordinate: [number, number];
  sourceFeatureId: string;
}

export interface NormalizedFeatureProperties {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  relations: RelationReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
  containedPois?: ContainedPoi[];
}

export type NormalizedFeature = Feature<Geometry, NormalizedFeatureProperties>;
export type NormalizedFeatureCollection = FeatureCollection<Geometry, NormalizedFeatureProperties>;

export interface NormalizationDiagnostics {
  rawElementCounts: Record<string, number>;
  totalRawElements: number;
  totalConvertedFeatures: number;
  totalNormalizedFeatures: number;
  featureCountsByGeometryType: Record<string, number>;
  taintedFeatures: number;
  skippedFeaturesWithoutGeometry: number;
  filteredRelationOutlineFeatures: number;
  filteredRelationMemberLineFeatures: number;
}

export interface OverpassJsonResponse {
  version?: number;
  generator?: string;
  osm3s?: {
    timestamp_osm_base?: string;
    copyright?: string;
  };
  elements: Array<{ type?: string }>;
}

type RawFeatureProperties = {
  type?: unknown;
  id?: unknown;
  tags?: unknown;
  relations?: unknown;
  meta?: unknown;
  tainted?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// 这里把 tags 规整成纯字符串字典，避免调用方后续还要反复判断属性值类型。
function toStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const entries: Array<[string, string]> = [];

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      entries.push([key, entry]);
    }
  }

  return Object.fromEntries(entries);
}

// meta 里只保留最常见的字符串和数字，便于前端直接展示和人工调试。
function toMetaRecord(value: unknown): Record<string, string | number> {
  if (!isRecord(value)) {
    return {};
  }

  const entries: Array<[string, string | number]> = [];

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' || typeof entry === 'string') {
      entries.push([key, entry]);
    }
  }

  return Object.fromEntries(entries);
}

// osmtogeojson 会把当前要素所属的 relation 信息挂到 properties.relations 上。
// 后面判断一条线是不是 multipolygon/boundary 的轮廓线，或者是不是 route 汇总线的成员片段，依赖的都是这里的结果。
function toRelationReferences(value: unknown): RelationReference[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.role !== 'string' || typeof entry.rel !== 'number') {
      return [];
    }

    return [
      {
        role: entry.role,
        rel: entry.rel,
        reltags: toStringRecord(entry.reltags),
      },
    ];
  });
}

function countRawElements(elements: Array<{ type?: string }>): Record<string, number> {
  return elements.reduce<Record<string, number>>((counts, element) => {
    const type = element.type || 'unknown';
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, {});
}

function countFeaturesByGeometryType(features: NormalizedFeature[]): Record<string, number> {
  return features.reduce<Record<string, number>>((counts, feature) => {
    const geometryType = feature.geometry.type;
    counts[geometryType] = (counts[geometryType] || 0) + 1;
    return counts;
  }, {});
}

// 这一步只负责把 osmtogeojson 的输出转成项目内部稳定结构。
// 只要 geometry 存在，就先保留下来；是否过滤某类几何，放到后面的业务规则处理。
function normalizeFeature(feature: Feature): NormalizedFeature | null {
  if (!feature.geometry) {
    return null;
  }

  const properties = (feature.properties || {}) as RawFeatureProperties;
  const osmType = typeof properties.type === 'string' ? properties.type : 'unknown';
  const osmId = typeof properties.id === 'number' ? properties.id : Number.NaN;

  return {
    type: 'Feature',
    id: feature.id ? String(feature.id) : `${osmType}/${osmId}`,
    geometry: feature.geometry,
    properties: {
      osmType,
      osmId,
      tags: toStringRecord(properties.tags),
      relations: toRelationReferences(properties.relations),
      meta: toMetaRecord(properties.meta),
      tainted: Boolean(properties.tainted),
    },
  };
}

const GEOMETRY_EPSILON = 1e-10;

type BoundingBox = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type BuildingAreaCandidate = {
  feature: Feature<Polygon | MultiPolygon, NormalizedFeatureProperties>;
  featureIndex: number;
  area: number;
  boundingBox: BoundingBox;
};

// contained POI 目前只处理真正的 Point 几何；
// 后面如果要扩展到 entrance way / indoor area，再单独加新的分支。
function isPointFeature(feature: NormalizedFeature): feature is Feature<Point, NormalizedFeatureProperties> {
  return feature.geometry.type === 'Point';
}

// 首版只把带 building=* 的 Polygon / MultiPolygon 视为“可挂载内部功能点”的容器。
// 这样可以避免把普通 landuse / natural 大面错误地当成商户承载面。
function isBuildingAreaFeature(
  feature: NormalizedFeature,
): feature is Feature<Polygon | MultiPolygon, NormalizedFeatureProperties> {
  const geometryType = feature.geometry.type;
  if (geometryType !== 'Polygon' && geometryType !== 'MultiPolygon') {
    return false;
  }

  return typeof feature.properties.tags.building === 'string' && feature.properties.tags.building.length > 0;
}

// 这里显式把 Point 坐标规整成 [lon, lat]，
// 便于后续统一做 bbox 预筛、点落面判断和前端展示。
function extractPointCoordinate(feature: NormalizedFeature): [number, number] | null {
  if (!isPointFeature(feature)) {
    return null;
  }

  const coordinates = feature.geometry.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return null;
  }

  const [lon, lat] = coordinates;
  if (typeof lon !== 'number' || typeof lat !== 'number') {
    return null;
  }

  return [lon, lat];
}

// “候选内部 POI” 的判断故意收得比较窄：
// 只有 node，并且带明确功能分类键，才进入后续归并流程。
// name / brand / cuisine 这类补充信息会保留在 tags 里，但不会单独触发归并。
function isContainedPoiCandidate(feature: NormalizedFeature): boolean {
  if (feature.properties.osmType !== 'node') {
    return false;
  }

  if (!extractPointCoordinate(feature)) {
    return false;
  }

  const CONTAINED_POI_TAG_KEYS = new Set(['shop', 'amenity', 'office', 'tourism', 'leisure', 'craft', 'healthcare']);

  return Object.keys(feature.properties.tags).some((key) => CONTAINED_POI_TAG_KEYS.has(key));
}

// GeoJSON 的 Position 理论上可以带第三维；
// 这里归一化逻辑只关心经纬度，因此只验证前两位是有限数字。
function isFinitePosition(position: Position): position is [number, number] {
  return (
    Array.isArray(position) &&
    position.length >= 2 &&
    typeof position[0] === 'number' &&
    Number.isFinite(position[0]) &&
    typeof position[1] === 'number' &&
    Number.isFinite(position[1])
  );
}

// bbox 只作为“快速排除不可能命中”的预筛条件；
// 真正的是否在面内，仍然要走后面的逐环判断。
function expandBoundingBoxWithRing(ring: Position[], boundingBox: BoundingBox): BoundingBox {
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

  return boundingBox;
}

// 给每个建筑面预先算一个 bbox，避免每个点都直接做完整点落面计算。
function computeBoundingBox(geometry: Polygon | MultiPolygon): BoundingBox {
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
  } else {
    for (const polygon of geometry.coordinates) {
      for (const ring of polygon) {
        expandBoundingBoxWithRing(ring, boundingBox);
      }
    }
  }

  return boundingBox;
}

// bbox 判断允许一个极小误差，避免浮点比较把边界点误判到面外。
function isPointInBoundingBox(point: [number, number], boundingBox: BoundingBox): boolean {
  const [x, y] = point;
  return (
    x >= boundingBox.minX - GEOMETRY_EPSILON &&
    x <= boundingBox.maxX + GEOMETRY_EPSILON &&
    y >= boundingBox.minY - GEOMETRY_EPSILON &&
    y <= boundingBox.maxY + GEOMETRY_EPSILON
  );
}

// 先单独判断“点是否落在线段上”，这样边界点可以直接视为命中。
// 后面的射线法只负责处理严格位于内部的情况。
function isPointOnSegment(point: [number, number], start: [number, number], end: [number, number]): boolean {
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

// 单环的点落面判断使用常见的射线法；
// 如果点恰好落在边界线上，上面的 isPointOnSegment 会提前返回 true。
function ringContainsPoint(ring: Position[], point: [number, number]): boolean {
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

// Polygon 先要求命中 outer ring，再要求不落在任何 inner ring（洞）里。
function polygonContainsPoint(coordinates: Polygon['coordinates'], point: [number, number]): boolean {
  const [outerRing, ...innerRings] = coordinates;
  if (!outerRing || !ringContainsPoint(outerRing, point)) {
    return false;
  }

  return !innerRings.some((ring) => ringContainsPoint(ring, point));
}

// MultiPolygon 只要命中任意一个子 polygon，就认为点在该要素内部。
function multiPolygonContainsPoint(coordinates: MultiPolygon['coordinates'], point: [number, number]): boolean {
  return coordinates.some((polygon) => polygonContainsPoint(polygon, point));
}

// 这里用平面 shoelace 公式算一个“相对面积”。
// 它不追求测地精度，只要能稳定比较两个建筑面的大小即可。
function signedRingArea(ring: Position[]): number {
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

// Polygon 面积 = outer ring 面积减去所有 inner ring 面积。
function polygonArea(coordinates: Polygon['coordinates']): number {
  const [outerRing, ...innerRings] = coordinates;
  if (!outerRing) {
    return 0;
  }

  const outerArea = Math.abs(signedRingArea(outerRing));
  const innerArea = innerRings.reduce((sum, ring) => sum + Math.abs(signedRingArea(ring)), 0);
  return Math.max(0, outerArea - innerArea);
}

// MultiPolygon 的总面积就是各子 polygon 面积之和。
function multiPolygonArea(coordinates: MultiPolygon['coordinates']): number {
  return coordinates.reduce((sum, polygon) => sum + polygonArea(polygon), 0);
}

// 选“最小命中建筑面”时，统一从这里取面积，避免调用方关心具体几何类型。
function getFeatureArea(feature: Feature<Polygon | MultiPolygon, NormalizedFeatureProperties>): number {
  return feature.geometry.type === 'Polygon'
    ? polygonArea(feature.geometry.coordinates)
    : multiPolygonArea(feature.geometry.coordinates);
}

// 统一包装 Polygon / MultiPolygon 的点落面判断，减少 attach 阶段的分支噪音。
function containsPoint(
  feature: Feature<Polygon | MultiPolygon, NormalizedFeatureProperties>,
  point: [number, number],
): boolean {
  return feature.geometry.type === 'Polygon'
    ? polygonContainsPoint(feature.geometry.coordinates, point)
    : multiPolygonContainsPoint(feature.geometry.coordinates, point);
}

// 这里刻意复用规范化后的 properties 字段，而不是回头再读原始 osmtogeojson 输出。
// 这样 containedPois 和普通 feature 的字段语义完全一致，前端消费也更简单。
function toContainedPoi(feature: NormalizedFeature): ContainedPoi | null {
  const coordinate = extractPointCoordinate(feature);
  if (!coordinate) {
    return null;
  }

  return {
    osmType: feature.properties.osmType,
    osmId: feature.properties.osmId,
    tags: feature.properties.tags,
    relations: feature.properties.relations,
    meta: feature.properties.meta,
    tainted: feature.properties.tainted,
    coordinate,
    sourceFeatureId: feature.id ? String(feature.id) : `${feature.properties.osmType}/${feature.properties.osmId}`,
  };
}

// 这一阶段只做“给建筑面附加 containedPois”，不删除任何原始 Point feature。
// 也就是说，Point 仍然保留独立表达，Polygon 只是额外携带一个聚合视图。
function attachContainedPois(features: NormalizedFeature[]): NormalizedFeature[] {
  const buildingAreas: BuildingAreaCandidate[] = features.flatMap((feature, featureIndex) => {
    if (!isBuildingAreaFeature(feature)) {
      return [];
    }

    return [
      {
        feature,
        featureIndex,
        area: getFeatureArea(feature),
        boundingBox: computeBoundingBox(feature.geometry),
      },
    ];
  });

  if (buildingAreas.length === 0) {
    return features;
  }

  const containedPoisByFeatureIndex = new Map<number, ContainedPoi[]>();

  for (const feature of features) {
    if (!isContainedPoiCandidate(feature)) {
      continue;
    }

    const coordinate = extractPointCoordinate(feature);
    const containedPoi = toContainedPoi(feature);
    if (!coordinate || !containedPoi) {
      continue;
    }

    let selectedBuilding: BuildingAreaCandidate | null = null;

    for (const building of buildingAreas) {
      // 先做 bbox 预筛，尽量把昂贵的点落面计算留给少数候选建筑。
      if (!isPointInBoundingBox(coordinate, building.boundingBox)) {
        continue;
      }

      if (!containsPoint(building.feature, coordinate)) {
        continue;
      }

      // 如果一个 POI 同时落进多个建筑面，优先挂到面积更小的那个；
      // 这样大型外层建筑或复杂叠加面，不会吞掉更具体的店铺建筑。
      if (!selectedBuilding || building.area < selectedBuilding.area) {
        selectedBuilding = building;
      }
    }

    if (!selectedBuilding) {
      continue;
    }

    const existingPois = containedPoisByFeatureIndex.get(selectedBuilding.featureIndex) || [];
    existingPois.push(containedPoi);
    containedPoisByFeatureIndex.set(selectedBuilding.featureIndex, existingPois);
  }

  if (containedPoisByFeatureIndex.size === 0) {
    return features;
  }

  return features.map((feature, featureIndex) => {
    const containedPois = containedPoisByFeatureIndex.get(featureIndex);
    if (!containedPois) {
      return feature;
    }

    return {
      ...feature,
      properties: {
        ...feature.properties,
        // 这里按 osmId 升序稳定输出，方便前端展示和人工比对结果。
        containedPois: [...containedPois].sort((left, right) => left.osmId - right.osmId),
      },
    };
  });
}

function isLinearGeometry(feature: NormalizedFeature): boolean {
  return feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString';
}

function isRelationOutlineCoveredByPolygon(feature: NormalizedFeature): boolean {
  if (!isLinearGeometry(feature)) {
    return false;
  }

  return feature.properties.relations.some((relation) => {
    const relationType = relation.reltags.type;
    const isAreaRelation = relationType === 'multipolygon' || relationType === 'boundary';
    const isOutlineRole = relation.role === 'outer' || relation.role === 'inner';
    return isAreaRelation && isOutlineRole;
  });
}

// “无标签片段”暂时简单粗暴地理解成 tags 完全为空。
function hasMeaningfulLinearTags(tags: Record<string, string>): boolean {
  if (Object.keys(tags).length === 0) {
    return false;
  }
  return true

  // const meaningfulKeys = new Set([
  //   'highway', 'railway', 'waterway', 'aerialway', 'barrier', 'power', 'name', 'ref', 'surface', 'smoothness', 'tracktype', 'width', 'lanes', 'bicycle', 'foot', 'horse', 'motor_vehicle', 'access', 'oneway', 'lit', 'segregated', 'crossing', 'crossing:markings', 'cycleway', 'footway', 'sidewalk', 'service', 'bridge', 'tunnel', 'maxspeed',
  // ]);

  // return Object.keys(tags).some((key) => meaningfulKeys.has(key));
}

function buildRelationLineIndex(features: NormalizedFeature[]): Set<number> {
  const relationIds = new Set<number>();

  for (const feature of features) {
    if (!isLinearGeometry(feature)) {
      continue;
    }

    if (feature.properties.osmType !== 'relation') {
      continue;
    }

    const relationType = feature.properties.tags.type;
    if (relationType === 'route' || relationType === 'waterway') {
      relationIds.add(feature.properties.osmId);
    }
  }

  return relationIds;
}

function isMemberLineCoveredByRelationLine(feature: NormalizedFeature, relationLineIds: Set<number>): boolean {
  if (!isLinearGeometry(feature)) {
    return false;
  }

  if (feature.properties.osmType !== 'way') {
    return false;
  }

  if (hasMeaningfulLinearTags(feature.properties.tags)) {
    return false;
  }

  return feature.properties.relations.some((relation) => {
    if (!relationLineIds.has(relation.rel)) {
      return false;
    }

    const relationType = relation.reltags.type;
    return relationType === 'route' || relationType === 'waterway';
  });
}

// 这里不再用 `(if:count_tags()>0)` 过滤查询范围。
// 原因是 relation 的几何常常依赖大量“自身没有标签、但作为成员骨架存在”的 way。
// 如果在 Overpass 阶段先把这些成员丢掉，osmtogeojson 很可能无法正确拼出 route 的长线，或者 multipolygon 的面。
// 因此正式 normalize 查询继续采用“先全量取回，再后处理过滤重复表达”的策略。
export function buildNormalizedOverpassQuery(request: NormalizedOverpassRequest): string {
  return [
    '[out:json][timeout:25];',
    `nwr(around:${request.radius},${request.lat},${request.lon});`,
    'out body geom;',
    '>;',
    'out skel geom;',
  ].join('\n');
}

// normalization 的完整流程：
// 1. 先把 Overpass JSON 交给 osmtogeojson 转成标准 GeoJSON。
// 2. 再把每个 Feature 的 properties 规整成统一结构。
// 3. 先过滤“已被面语义覆盖”的 outer/inner 轮廓线。
// 4. 再过滤“已被 relation 汇总线覆盖”的无标签成员线段。
//
// 这里使用 flatProperties: false，是为了保留 tags / meta / relations 的分层信息。
// 如果改成拍平结构，后面判断一条线是不是某个 relation 的成员会更难理解。
export function normalizeOverpassData(
  raw: OverpassJsonResponse,
): { geojson: NormalizedFeatureCollection; diagnostics: NormalizationDiagnostics } {
  const converted = osmtogeojson(raw, { flatProperties: false }) as FeatureCollection;
  const normalizedCandidates = converted.features.map((feature) => normalizeFeature(feature));
  const normalizedFeatures = normalizedCandidates.filter((feature): feature is NormalizedFeature => feature !== null);
  const skippedFeaturesWithoutGeometry = normalizedCandidates.length - normalizedFeatures.length;

  // 第一步过滤：删掉已经被 Polygon / MultiPolygon 逻辑表达过的外环或内环线。
  const filteredRelationOutlineFeatures = normalizedFeatures.filter((feature) =>
    isRelationOutlineCoveredByPolygon(feature),
  ).length;
  const withoutPolygonOutlines = normalizedFeatures.filter((feature) => !isRelationOutlineCoveredByPolygon(feature));

  // 第二步过滤：如果某个 route / waterway relation 自己已经生成了汇总线，
  // 那么只作为其组成片段、且自身没有有意义标签的 member way 就可以删掉，避免重复表达。
  const relationLineIds = buildRelationLineIndex(withoutPolygonOutlines);
  const filteredRelationMemberLineFeatures = withoutPolygonOutlines.filter((feature) =>
    isMemberLineCoveredByRelationLine(feature, relationLineIds),
  ).length;
  const withoutRelationMemberLines = withoutPolygonOutlines.filter(
    (feature) => !isMemberLineCoveredByRelationLine(feature, relationLineIds),
  );
  const features = attachContainedPois(withoutRelationMemberLines);

  const taintedFeatures = features.filter((feature) => feature.properties.tainted).length;

  return {
    geojson: {
      type: 'FeatureCollection',
      features,
    },
    diagnostics: {
      rawElementCounts: countRawElements(raw.elements || []),
      totalRawElements: raw.elements?.length || 0,
      totalConvertedFeatures: converted.features.length,
      totalNormalizedFeatures: features.length,
      featureCountsByGeometryType: countFeaturesByGeometryType(features),
      taintedFeatures,
      skippedFeaturesWithoutGeometry,
      filteredRelationOutlineFeatures,
      filteredRelationMemberLineFeatures,
    },
  };
}
