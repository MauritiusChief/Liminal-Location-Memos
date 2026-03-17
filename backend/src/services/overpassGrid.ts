import type { SceneFeatureDetail, DbMicroGridCellRecord } from './sceneTypes.js';
import {
  AREA_PRIMARY_LABEL_KEYS,
  BUILDING_PRIMARY_LABEL_KEYS,
  LINE_PRIMARY_LABEL_KEYS,
  POI_PRIMARY_LABEL_KEYS,
  POI_STRUCTURED_TAG_KEYS,
} from './osmFeatureConfig.js';
import {
  buildBuildingBaseLabel,
  getAreaDisplayLabel,
  getPoiDisplayLabel,
  getRoadDisplayLabel,
} from './overpassLabels.js';
import { trimTagValue } from './overpassLabels.js';

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
  detailEntries: string[];
}

const GRID_EXTENT_METERS = 60 as const;
const GRID_CELL_SIZE_METERS = 5 as const;
const GRID_ROWS = 12 as const;
const GRID_COLS = 12 as const;

// grid 层现在不再做空间判定；
// 它只消费 repository 返回的命中结果，把它们组装成前端和 prompt 需要的网格结构。
export function buildNormalizedMicroGrid(input: {
  request: { lat: number; lon: number; radius: number };
  cells: DbMicroGridCellRecord[];
  featureDetails: ReadonlyMap<string, SceneFeatureDetail>;
}): NormalizedMicroGrid {
  const { request, cells: cellRecords, featureDetails } = input;

  if (request.radius < 50) {
    return {
      enabled: false,
      reason: 'radius_too_small',
      center: { lat: request.lat, lon: request.lon },
      extentMeters: GRID_EXTENT_METERS,
      cellSizeMeters: GRID_CELL_SIZE_METERS,
      rows: GRID_ROWS,
      cols: GRID_COLS,
      cells: [],
      detailEntries: [],
    };
  }

  const cells = Array.from({ length: GRID_ROWS }, (_, row) =>
    Array.from({ length: GRID_COLS }, (_, col) => {
      // SQL 理论上会返回完整 12x12；这里保留兜底，是为了避免单格缺失时直接炸掉整个调试结果。
      const record = cellRecords.find((entry) => entry.row === row && entry.col === col);

      if (!record) {
        return {
          row,
          col,
          center: [request.lon, request.lat],
          baseKind: 'empty',
          baseLabel: '.',
          poiLabels: [],
          roadLabels: [],
          label: '.',
          sourceFeatureIds: [],
        } satisfies NormalizedMicroGridCell;
      }

      return buildMicroGridCell(record, featureDetails);
    }),
  );

  return {
    enabled: true,
    center: { lat: request.lat, lon: request.lon },
    extentMeters: GRID_EXTENT_METERS,
    cellSizeMeters: GRID_CELL_SIZE_METERS,
    rows: GRID_ROWS,
    cols: GRID_COLS,
    cells,
    detailEntries: buildGridDetailEntries(cells, featureDetails),
  };
}

const BUILDING_AND_POI_TAG_KEYS = ['name', 'brand', ...POI_STRUCTURED_TAG_KEYS, ...BUILDING_PRIMARY_LABEL_KEYS] as const;
const LINE_DETAIL_TAG_KEYS = ['name', ...LINE_PRIMARY_LABEL_KEYS] as const;
const AREA_DETAIL_TAG_KEYS = ['name', ...AREA_PRIMARY_LABEL_KEYS] as const;

function buildMicroGridCell(
  record: DbMicroGridCellRecord,
  featureDetails: ReadonlyMap<string, SceneFeatureDetail>,
): NormalizedMicroGridCell {
  // 这一层只根据 feature id 回表拿标签，不再接触几何。
  const baseFeature = record.baseFeatureId ? featureDetails.get(record.baseFeatureId) || null : null;
  const poiDetails = record.poiFeatureIds.flatMap((featureId) => {
    const detail = featureDetails.get(featureId);
    return detail ? [detail] : [];
  });
  const roadDetails = record.roadFeatureIds.flatMap((featureId) => {
    const detail = featureDetails.get(featureId);
    return detail ? [detail] : [];
  });

  let baseLabel = '.';
  if (record.baseKind === 'building' && baseFeature) {
    baseLabel = buildBuildingBaseLabel(baseFeature);
  } else if (record.baseKind === 'area' && baseFeature) {
    baseLabel = getAreaDisplayLabel(baseFeature.tags);
  }

  const poiLabels = poiDetails.map((detail) => getPoiDisplayLabel(detail.tags));
  const roadLabels = roadDetails.map((detail) => getRoadDisplayLabel(detail.tags));
  const sourceFeatureIds = [
    ...(record.baseFeatureId ? [record.baseFeatureId] : []),
    ...record.poiFeatureIds,
    ...record.roadFeatureIds,
  ];

  return {
    row: record.row,
    col: record.col,
    center: record.center,
    baseKind: record.baseKind,
    baseLabel,
    poiLabels,
    roadLabels,
    label: buildCellLabel(record.baseKind, baseLabel, poiLabels, roadLabels),
    sourceFeatureIds: [...new Set(sourceFeatureIds)],
  };
}

function buildCellLabel(
  baseKind: MicroGridCellKind,
  baseLabel: string,
  poiLabels: string[],
  roadLabels: string[],
): string {
  // 文案拼接规则保持旧版本风格：
  // base 层描述建筑/区域，poi 和 road 作为叠加层附在后面。
  const segments: string[] = [];

  if (baseKind !== 'empty' || (poiLabels.length === 0 && roadLabels.length === 0)) {
    segments.push(baseLabel);
  }

  if (poiLabels.length > 0) {
    segments.push(poiLabels.join('&'));
  }

  if (roadLabels.length > 0) {
    segments.push(roadLabels.join('&'));
  }

  return segments.filter(Boolean).join(' | ');
}

function buildGridDetailEntries(
  cells: NormalizedMicroGridCell[][],
  featureDetails: ReadonlyMap<string, SceneFeatureDetail>,
): string[] {
  const featureIds = Array.from(
    new Set(
      cells.flatMap((row) =>
        row.flatMap((cell) => {
          if (cell.baseKind === 'empty' && cell.poiLabels.length === 0 && cell.roadLabels.length === 0) {
            return [];
          }

          return cell.sourceFeatureIds;
        }),
      ),
    ),
  );

  return featureIds.flatMap((featureId) => {
    const feature = featureDetails.get(featureId);
    return feature ? [buildFeatureDetailEntry(feature)] : [];
  });
}

function buildFeatureDetailEntry(feature: SceneFeatureDetail): string {
  const detailTags = collectImportantTags(feature);
  const lines = [`${getFeatureDisplayTitle(feature)} (id=${feature.featureId}):`];

  if (detailTags.length > 0) {
    lines.push(...detailTags.map((tag) => `* ${tag}`));
  } else {
    lines.push('* 无可展示细节');
  }

  return lines.join('\n');
}

function getFeatureDisplayTitle(feature: SceneFeatureDetail): string {
  const name = trimTagValue(feature.tags.name);
  const brand = trimTagValue(feature.tags.brand);

  if (name) {
    return name;
  }

  if (brand) {
    return brand;
  }

  for (const key of [...POI_PRIMARY_LABEL_KEYS, ...LINE_PRIMARY_LABEL_KEYS, ...AREA_PRIMARY_LABEL_KEYS, ...BUILDING_PRIMARY_LABEL_KEYS] as const) {
    const value = trimTagValue(feature.tags[key]);
    if (value) {
      return `${key}:${value}`;
    }
  }

  return feature.featureId;
}

function collectImportantTags(feature: SceneFeatureDetail): string[] {
  const keys =
    feature.category === 'building' || feature.category === 'poi'
      ? BUILDING_AND_POI_TAG_KEYS
      : feature.category === 'line'
        ? LINE_DETAIL_TAG_KEYS
        : AREA_DETAIL_TAG_KEYS;

  return keys.flatMap((key) => {
    const value = trimTagValue(feature.tags[key]);
    return value ? [`${key}: ${value}`] : [];
  });
}
