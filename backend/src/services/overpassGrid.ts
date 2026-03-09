import type { Feature, LineString, MultiLineString, MultiPolygon, Polygon } from 'geojson';
import {
  computeBoundingBox,
  extractPointCoordinate,
  getPolygonalFeatureArea,
  isPointInBoundingBox,
  isPolygonalGeometry,
  isLinearGeometryType,
  lineIntersectsBoundingBox,
  metersToLatitudeDegrees,
  metersToLongitudeDegrees,
  polygonalGeometryContainsPoint,
  type BoundingBox,
} from './overpassGeometry.js';
import type { ContainedPoi, NormalizedFeature, NormalizedFeatureProperties } from './overpassNormalization.js';

export type MicroGridCellKind = 'building' | 'poi' | 'road' | 'area' | 'empty';

export interface NormalizedMicroGridCell {
  row: number;
  col: number;
  center: [number, number];
  label: string;
  kind: MicroGridCellKind;
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
const GRID_EXTENT_METERS = 60 as const;
const GRID_CELL_SIZE_METERS = 5 as const;
const GRID_ROWS = 12 as const;
const GRID_COLS = 12 as const;
const GRID_HALF_EXTENT_METERS = GRID_EXTENT_METERS / 2;
const POI_TAG_KEYS = ['shop', 'amenity', 'office', 'tourism', 'leisure', 'craft', 'healthcare'] as const;
const AREA_TAG_KEYS = ['landuse', 'natural', 'leisure', 'amenity'] as const;
const ROAD_TAG_KEYS = ['highway', 'railway', 'waterway'] as const;

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
// 先建筑，再 POI，再道路，再其他区域，最后空白。
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
  if (buildingMatch) {
    return {
      row: input.row,
      col: input.col,
      center: input.center,
      ...buildBuildingCellPayload(buildingMatch.feature),
    };
  }

  const poiMatch = selectPoiForCell(input.poiCandidates, input.cellBoundingBox);
  if (poiMatch) {
    return {
      row: input.row,
      col: input.col,
      center: input.center,
      ...buildPoiCellPayload(poiMatch),
    };
  }

  const roadMatch = selectRoadForCell(input.roadCandidates, input.cellBoundingBox);
  if (roadMatch) {
    return {
      row: input.row,
      col: input.col,
      center: input.center,
      ...buildRoadCellPayload(roadMatch.feature),
    };
  }

  const areaMatch = selectSmallestContainingPolygon(input.areaCandidates, input.center);
  if (areaMatch) {
    return {
      row: input.row,
      col: input.col,
      center: input.center,
      ...buildAreaCellPayload(areaMatch.feature),
    };
  }

  return {
    row: input.row,
    col: input.col,
    center: input.center,
    label: '.',
    kind: 'empty',
    sourceFeatureIds: [],
  };
}

// 建筑格是这套表示法的最高优先级，因为最终目标是让 LLM 读懂近距离建筑关系。
function isBuildingFeature(
  feature: NormalizedFeature,
): feature is Feature<Polygon | MultiPolygon, NormalizedFeatureProperties> {
  return isPolygonalGeometry(feature.geometry) && typeof feature.properties.tags.building === 'string';
}

// 独立 POI 只在没有建筑命中的格子里展示。
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

// “其他面”是兜底层，主要为了在没有建筑/道路/POI 时仍能给格子一点环境语义。
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
// 多个点同时落入时，优先有 name/brand 的，再按 osmId 稳定排序。
function selectPoiForCell(features: NormalizedFeature[], cellBoundingBox: BoundingBox): NormalizedFeature | null {
  const matches = features.filter((feature) => {
    const coordinate = extractPointCoordinate(feature.geometry);
    return coordinate ? isPointInBoundingBox(coordinate, cellBoundingBox) : false;
  });

  if (matches.length === 0) {
    return null;
  }

  return [...matches].sort(comparePoiFeatures)[0] || null;
}

// 道路不要求穿过格子中心；
// 只要线段与格子 bbox 有接触，就认为这个格子能反映出道路存在。
function selectRoadForCell(candidates: LineCandidate[], cellBoundingBox: BoundingBox): LineCandidate | null {
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

  if (matches.length === 0) {
    return null;
  }

  return [...matches].sort((left, right) => compareNamedFeatures(left.feature, right.feature))[0] || null;
}

// 建筑格的 label 生成逻辑优先体现“可被人和 LLM 读懂”的语义：
// 建筑名 > 建筑内 POI 名/品牌 > 建筑内 POI 类型 > building 值。
function buildBuildingCellPayload(
  feature: Feature<Polygon | MultiPolygon, NormalizedFeatureProperties>,
): Pick<NormalizedMicroGridCell, 'label' | 'kind' | 'sourceFeatureIds'> {
  const sourceFeatureIds = [toFeatureId(feature)];
  const buildingName = trimTagValue(feature.properties.tags.name);

  if (buildingName) {
    return {
      label: buildingName,
      kind: 'building',
      sourceFeatureIds,
    };
  }

  const containedPoi = feature.properties.containedPois?.[0];
  const containedPoiName = containedPoi ? trimTagValue(containedPoi.tags.name) || trimTagValue(containedPoi.tags.brand) : null;
  if (containedPoiName) {
    return {
      label: containedPoiName,
      kind: 'building',
      sourceFeatureIds: containedPoi ? [...sourceFeatureIds, containedPoi.sourceFeatureId] : sourceFeatureIds,
    };
  }

  const containedPoiCategory = containedPoi ? getPrimaryPoiLabel(containedPoi.tags) : null;
  if (containedPoiCategory) {
    return {
      label: containedPoiCategory,
      kind: 'building',
      sourceFeatureIds: containedPoi ? [...sourceFeatureIds, containedPoi.sourceFeatureId] : sourceFeatureIds,
    };
  }

  const buildingValue = trimTagValue(feature.properties.tags.building);
  return {
    label: buildingValue && buildingValue !== 'yes' ? buildingValue : 'building',
    kind: 'building',
    sourceFeatureIds,
  };
}

// 独立 POI 格优先显示 name / brand，其次退回主分类值。
function buildPoiCellPayload(feature: NormalizedFeature): Pick<NormalizedMicroGridCell, 'label' | 'kind' | 'sourceFeatureIds'> {
  return {
    label: getPoiDisplayLabel(feature.properties.tags),
    kind: 'poi',
    sourceFeatureIds: [toFeatureId(feature)],
  };
}

// 道路格优先给出路名，否则退回 highway / railway / waterway 的类型值。
function buildRoadCellPayload(
  feature: Feature<LineString | MultiLineString, NormalizedFeatureProperties>,
): Pick<NormalizedMicroGridCell, 'label' | 'kind' | 'sourceFeatureIds'> {
  return {
    label: getRoadDisplayLabel(feature.properties.tags),
    kind: 'road',
    sourceFeatureIds: [toFeatureId(feature)],
  };
}

// 其他面格只是环境提示，因此标签生成保持简单直接。
function buildAreaCellPayload(
  feature: Feature<Polygon | MultiPolygon, NormalizedFeatureProperties>,
): Pick<NormalizedMicroGridCell, 'label' | 'kind' | 'sourceFeatureIds'> {
  return {
    label: getAreaDisplayLabel(feature.properties.tags),
    kind: 'area',
    sourceFeatureIds: [toFeatureId(feature)],
  };
}

// 这个排序器专门服务“一个格子里有多个 POI 点”的情况。
function comparePoiFeatures(left: NormalizedFeature, right: NormalizedFeature): number {
  const leftPriority = getPoiSortPriority(left.properties.tags);
  const rightPriority = getPoiSortPriority(right.properties.tags);
  if (leftPriority !== rightPriority) {
    return leftPriority - rightPriority;
  }

  return left.properties.osmId - right.properties.osmId;
}

// 道路等线要素冲突时，优先保留可读名字更多的那个。
function compareNamedFeatures(left: NormalizedFeature, right: NormalizedFeature): number {
  const leftName = getPreferredName(left.properties.tags);
  const rightName = getPreferredName(right.properties.tags);

  if (leftName && !rightName) {
    return -1;
  }
  if (!leftName && rightName) {
    return 1;
  }
  if (leftName && rightName && leftName !== rightName) {
    return leftName.localeCompare(rightName);
  }

  return left.properties.osmId - right.properties.osmId;
}

// POI 是否有 name/brand 决定它在格子里的展示优先级。
function getPoiSortPriority(tags: Record<string, string>): number {
  if (trimTagValue(tags.name) || trimTagValue(tags.brand)) {
    return 0;
  }
  return 1;
}

// 这几个 display helper 都是在把“原始 tags”压成适合单元格展示的短文本。
function getPoiDisplayLabel(tags: Record<string, string>): string {
  return trimTagValue(tags.name) || trimTagValue(tags.brand) || getPrimaryPoiLabel(tags) || 'poi';
}

function getPrimaryPoiLabel(tags: Record<string, string>): string | null {
  for (const key of POI_TAG_KEYS) {
    const value = trimTagValue(tags[key]);
    if (value) {
      return value;
    }
  }

  return null;
}

function getRoadDisplayLabel(tags: Record<string, string>): string {
  return (
    trimTagValue(tags.name) ||
    trimTagValue(tags.highway) ||
    trimTagValue(tags.railway) ||
    trimTagValue(tags.waterway) ||
    'road'
  );
}

function getAreaDisplayLabel(tags: Record<string, string>): string {
  return (
    trimTagValue(tags.name) ||
    trimTagValue(tags.landuse) ||
    trimTagValue(tags.natural) ||
    trimTagValue(tags.leisure) ||
    trimTagValue(tags.amenity) ||
    'area'
  );
}

function getPreferredName(tags: Record<string, string>): string | null {
  return trimTagValue(tags.name) || trimTagValue(tags.brand);
}

// 这里顺手把空字符串也视为“没有值”，避免 label 里出现视觉上为空的噪音。
function trimTagValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// 调试和前端联动都统一用 feature id 字符串，而不是散落地拼 osmType/osmId。
function toFeatureId(feature: { id?: string | number; properties: NormalizedFeatureProperties }): string {
  return feature.id ? String(feature.id) : `${feature.properties.osmType}/${feature.properties.osmId}`;
}
