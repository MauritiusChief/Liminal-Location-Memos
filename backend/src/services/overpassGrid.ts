import type { Feature, LineString, MultiLineString, MultiPolygon, Polygon } from 'geojson';
import {
  computeBoundingBox,
  extractPointCoordinate,
  getPolygonalFeatureArea,
  isLinearGeometryType,
  isPointInBoundingBox,
  isPolygonalGeometry,
  lineIntersectsBoundingBox,
  metersToLatitudeDegrees,
  metersToLongitudeDegrees,
  polygonalGeometryContainsPoint,
  type BoundingBox,
} from './overpassGeometry.js';
import type { NormalizedFeature, NormalizedFeatureProperties } from './overpassNormalization.js';
import {
  AREA_TAG_KEYS as SHARED_AREA_TAG_KEYS,
  buildBuildingBaseLabel,
  getAreaDisplayLabel,
  getPoiDisplayLabel,
  getRoadDisplayLabel,
  POI_TAG_KEYS as SHARED_POI_TAG_KEYS,
  ROAD_TAG_KEYS as SHARED_ROAD_TAG_KEYS,
} from './overpassLabels.js';

export type MicroGridCellKind = 'building' | 'area' | 'empty';

export interface NormalizedMicroGridCell {
  row: number;
  col: number;
  center: [number, number];
  baseKind: MicroGridCellKind;
  baseLabel: string;
  poiLabels: string[];
  roadLabels: string[];
  label: string;
  sourceFeatureIds: string[];
}

export interface NormalizedMicroGrid {
  enabled: boolean;
  reason?: 'radius_too_small';
  center: {
    lat: number;
    lon: number;
  };
  extentMeters: 60;
  cellSizeMeters: 5;
  rows: 12;
  cols: 12;
  cells: NormalizedMicroGridCell[][];
}

// 这一层只做一件事：把已经 normalize 好的 features 压成一个固定尺寸的微网格。
// 它不再关心 Overpass 原始 JSON，也不重复做 normalize 阶段的业务规整。
// 如果某个要素虽然在 normalize 里保留下来了，但和这 60m × 60m 的小范围格子没有相交，
// 它会在这里被自然忽略；也就是说，grid 不会主动“删数据”，只是只消费近场相关部分。
const GRID_EXTENT_METERS = 60 as const;
const GRID_CELL_SIZE_METERS = 5 as const;
const GRID_ROWS = 12 as const;
const GRID_COLS = 12 as const;
const GRID_HALF_EXTENT_METERS = GRID_EXTENT_METERS / 2;
const POI_TAG_KEYS = SHARED_POI_TAG_KEYS;
const AREA_TAG_KEYS = SHARED_AREA_TAG_KEYS;
const ROAD_TAG_KEYS = SHARED_ROAD_TAG_KEYS;

type PolygonCandidate = {
  feature: Feature<Polygon | MultiPolygon, NormalizedFeatureProperties>;
  area: number;
  boundingBox: BoundingBox;
};

type LineCandidate = {
  feature: Feature<LineString | MultiLineString, NormalizedFeatureProperties>;
  boundingBox: BoundingBox;
};

// 这里的入口返回值始终是统一形状：
// 半径不足时返回 disabled 网格，半径足够时返回完整 12x12 cells。
export function buildNormalizedMicroGrid(
  features: NormalizedFeature[],
  request: { lat: number; lon: number; radius: number },
): NormalizedMicroGrid {
  if (request.radius <= 50) {
    return {
      enabled: false,
      reason: 'radius_too_small',
      center: {
        lat: request.lat,
        lon: request.lon,
      },
      extentMeters: GRID_EXTENT_METERS,
      cellSizeMeters: GRID_CELL_SIZE_METERS,
      rows: GRID_ROWS,
      cols: GRID_COLS,
      cells: [],
    };
  }

  // 先把不同优先级的候选要素分组并预计算 bbox / area，
  // 后面真正填 144 个格子时就不需要重复扫描全部几何细节。
  const buildingCandidates = features.flatMap<PolygonCandidate>((feature) => {
    if (!isBuildingFeature(feature)) {
      return [];
    }

    return [
      {
        feature,
        area: getPolygonalFeatureArea(feature),
        boundingBox: computeBoundingBox(feature.geometry),
      },
    ];
  });

  const areaCandidates = features.flatMap<PolygonCandidate>((feature) => {
    if (!isOtherAreaFeature(feature)) {
      return [];
    }

    return [
      {
        feature,
        area: getPolygonalFeatureArea(feature),
        boundingBox: computeBoundingBox(feature.geometry),
      },
    ];
  });

  const poiCandidates = features.filter((feature) => isPoiPointFeature(feature));
  const roadCandidates = features.flatMap<LineCandidate>((feature) => {
    if (!isRoadFeature(feature)) {
      return [];
    }

    return [
      {
        feature,
        boundingBox: computeBoundingBox(feature.geometry),
      },
    ];
  });

  // 网格坐标系固定以“查询点为中心，西北角为 row0/col0”展开。
  // 这里先把每格对应的经纬度步长算好，后面逐格生成中心点和边界框。
  const latPerCell = metersToLatitudeDegrees(GRID_CELL_SIZE_METERS);
  const lonPerCell = metersToLongitudeDegrees(GRID_CELL_SIZE_METERS, request.lat);
  const northEdge = request.lat + metersToLatitudeDegrees(GRID_HALF_EXTENT_METERS);
  const westEdge = request.lon - metersToLongitudeDegrees(GRID_HALF_EXTENT_METERS, request.lat);

  const cells = Array.from({ length: GRID_ROWS }, (_, row) =>
    Array.from({ length: GRID_COLS }, (_, col) => {
      const top = northEdge - row * latPerCell;
      const bottom = top - latPerCell;
      const left = westEdge + col * lonPerCell;
      const right = left + lonPerCell;
      const center: [number, number] = [(left + right) / 2, (top + bottom) / 2];
      const cellBoundingBox: BoundingBox = {
        minX: left,
        minY: bottom,
        maxX: right,
        maxY: top,
      };

      return buildMicroGridCell({
        row,
        col,
        center,
        cellBoundingBox,
        buildingCandidates,
        poiCandidates,
        roadCandidates,
        areaCandidates,
      });
    }),
  );

  return {
    enabled: true,
    center: {
      lat: request.lat,
      lon: request.lon,
    },
    extentMeters: GRID_EXTENT_METERS,
    cellSizeMeters: GRID_CELL_SIZE_METERS,
    rows: GRID_ROWS,
    cols: GRID_COLS,
    cells,
  };
}

// 单个格子的决策顺序是整个微网格可读性的核心：
// 面层只负责 building -> area -> empty，而 POI / ROAD 会作为叠加层始终保留。
function buildMicroGridCell(input: {
  row: number;
  col: number;
  center: [number, number];
  cellBoundingBox: BoundingBox;
  buildingCandidates: PolygonCandidate[];
  poiCandidates: NormalizedFeature[];
  roadCandidates: LineCandidate[];
  areaCandidates: PolygonCandidate[];
}): NormalizedMicroGridCell {
  const buildingMatch = selectSmallestContainingPolygon(input.buildingCandidates, input.center);
  const areaMatch = selectSmallestContainingPolygon(input.areaCandidates, input.center);
  const poiMatches = selectPoisForCell(input.poiCandidates, input.cellBoundingBox);
  const roadMatches = selectRoadsForCell(input.roadCandidates, input.cellBoundingBox);

  let baseKind: MicroGridCellKind = 'empty';
  let baseLabel = '.';
  let sourceFeatureIds: string[] = [];

  if (buildingMatch) {
    baseKind = 'building';
    baseLabel = buildBuildingBaseLabel(buildingMatch.feature);
    sourceFeatureIds.push(toFeatureId(buildingMatch.feature));
  } else if (areaMatch) {
    baseKind = 'area';
    baseLabel = getAreaDisplayLabel(areaMatch.feature.properties.tags);
    sourceFeatureIds.push(toFeatureId(areaMatch.feature));
  }

  const poiLabels = poiMatches.map((feature) => getPoiDisplayLabel(feature.properties.tags));
  const roadLabels = roadMatches.map((candidate) => getRoadDisplayLabel(candidate.feature.properties.tags));

  sourceFeatureIds.push(...poiMatches.map((feature) => toFeatureId(feature)));
  sourceFeatureIds.push(...roadMatches.map((candidate) => toFeatureId(candidate.feature)));

  return {
    row: input.row,
    col: input.col,
    center: input.center,
    baseKind,
    baseLabel,
    poiLabels,
    roadLabels,
    label: buildCellLabel(baseKind, baseLabel, poiLabels, roadLabels),
    sourceFeatureIds: [...new Set(sourceFeatureIds)],
  };
}

// 建筑格是这套表示法的最高优先级，因为最终目标是让 LLM 读懂近距离建筑关系。
function isBuildingFeature(
  feature: NormalizedFeature,
): feature is Feature<Polygon | MultiPolygon, NormalizedFeatureProperties> {
  return isPolygonalGeometry(feature.geometry) && typeof feature.properties.tags.building === 'string';
}

// 独立 POI 无论如何都会显示，只不过会与其他元素重叠显示。
// 这里沿用和 containedPois 相同的一组功能分类键。
function isPoiPointFeature(feature: NormalizedFeature): boolean {
  const coordinate = extractPointCoordinate(feature.geometry);
  if (!coordinate) {
    return false;
  }

  return POI_TAG_KEYS.some((key) => typeof feature.properties.tags[key] === 'string');
}

// 道路格只承接明确带道路/线性交通语义标签的线要素。
function isRoadFeature(
  feature: NormalizedFeature,
): feature is Feature<LineString | MultiLineString, NormalizedFeatureProperties> {
  return (
    isLinearGeometryType(feature.geometry) &&
    ROAD_TAG_KEYS.some((key) => typeof feature.properties.tags[key] === 'string')
  );
}

// “其他面”是兜底层，主要为了在没有建筑时仍能给格子一点环境语义。
function isOtherAreaFeature(
  feature: NormalizedFeature,
): feature is Feature<Polygon | MultiPolygon, NormalizedFeatureProperties> {
  return (
    isPolygonalGeometry(feature.geometry) &&
    !isBuildingFeature(feature) &&
    AREA_TAG_KEYS.some((key) => typeof feature.properties.tags[key] === 'string')
  );
}

// 多个面同时命中格子中心点时，统一选最小面；
// 规则和 containedPois 挂载时保持一致，尽量偏向更具体的空间对象。
function selectSmallestContainingPolygon(candidates: PolygonCandidate[], point: [number, number]): PolygonCandidate | null {
  let selected: PolygonCandidate | null = null;

  for (const candidate of candidates) {
    if (!isPointInBoundingBox(point, candidate.boundingBox)) {
      continue;
    }

    if (!polygonalGeometryContainsPoint(candidate.feature, point)) {
      continue;
    }

    if (!selected || candidate.area < selected.area) {
      selected = candidate;
    }
  }

  return selected;
}

// POI 的命中规则是“点落在格子边界内”；
// 多个点同时落入时全部保留，只做稳定排序，不在这里截断。
function selectPoisForCell(features: NormalizedFeature[], cellBoundingBox: BoundingBox): NormalizedFeature[] {
  const matches = features.filter((feature) => {
    const coordinate = extractPointCoordinate(feature.geometry);
    return coordinate ? isPointInBoundingBox(coordinate, cellBoundingBox) : false;
  });
  return matches
}

// 道路不要求穿过格子中心；
// 只要线段与格子 bbox 有接触，就认为这个格子能反映出道路存在。
function selectRoadsForCell(candidates: LineCandidate[], cellBoundingBox: BoundingBox): LineCandidate[] {
  const matches = candidates.filter((candidate) => {
    if (
      candidate.boundingBox.maxX < cellBoundingBox.minX ||
      candidate.boundingBox.minX > cellBoundingBox.maxX ||
      candidate.boundingBox.maxY < cellBoundingBox.minY ||
      candidate.boundingBox.minY > cellBoundingBox.maxY
    ) {
      return false;
    }

    return lineIntersectsBoundingBox(candidate.feature.geometry, cellBoundingBox);
  });
  return matches
}

// 最终整格 label 仍保留为单字符串，方便前端直接渲染；
// 但内部先分出 base / poi / road，再用稳定格式拼接起来。
function buildCellLabel(
  baseKind: MicroGridCellKind,
  baseLabel: string,
  poiLabels: string[],
  roadLabels: string[],
): string {
  const segments: string[] = [];

  if (baseKind !== 'empty' || (poiLabels.length === 0 && roadLabels.length === 0)) {
    segments.push(baseLabel);
  }

  if (poiLabels.length > 0) {
    segments.push(`${poiLabels.join('&')}`);
  }

  if (roadLabels.length > 0) {
    segments.push(`${roadLabels.join('&')}`);
  }

  return segments.filter(Boolean).join(' | ');
}

// 调试和前端联动都统一用 feature id 字符串，而不是散落地拼 osmType/osmId。
function toFeatureId(feature: { id?: string | number; properties: NormalizedFeatureProperties }): string {
  return feature.id ? String(feature.id) : `${feature.properties.osmType}/${feature.properties.osmId}`;
}
