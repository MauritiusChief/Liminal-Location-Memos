import { AREA_PRIMARY_LABEL_KEYS, BUILDING_PRIMARY_LABEL_KEYS, LINE_PRIMARY_LABEL_KEYS, POI_PRIMARY_LABEL_KEYS, POI_STRUCTURED_TAG_KEYS } from "@/services/osmNormalization/osmFeatureConfig.js";
import { MicroGrid, MicroGridCell } from "./microGridObject.js";
import { SceneFeatureDetail } from "./sceneObject.js";
import { buildBuildingBaseLabel, getAreaDisplayLabel, getPoiDisplayLabel, getRoadDisplayLabel, trimTagValue } from "./scenePrompt.js";

export interface LabeledMicroGridCell {
  row: number;
  col: number;
  center: [number, number];
  baseKind: 'building' | 'area' | 'empty';
  baseLabel: string;
  poiLabels: string[];
  roadLabels: string[];
  label: string;
  sourceFeatureIds: string[];
}

export interface LabeledMicroGrid {
  center: {
    lat: number;
    lon: number;
  };
  extentMeters: 60;
  cellSizeMeters: 5;
  rows: 12;
  cols: 12;
  cells: LabeledMicroGridCell[][];
  detailEntries: string[];
}

//#region 主函数

//#region 预填充标签

export function buildLabeledMicroGrid(microGrid: MicroGrid): LabeledMicroGrid {
  const cells = microGrid.cells

  const labeledCells = cells.map( row  => row.map(
    cell => buildLabeledMicroGridCell(cell)
  ))

  return {
    ...microGrid,
    cells: labeledCells,
    detailEntries: buildGridDetailEntries(cells),
  };
}

function buildLabeledMicroGridCell(cell: MicroGridCell): LabeledMicroGridCell {

  let baseLabel = '.';
  if (cell.baseKind === 'building' && cell.baseFeatureDetail) {
    baseLabel = buildBuildingBaseLabel(cell.baseFeatureDetail);
  } else if (cell.baseKind === 'area' && cell.baseFeatureDetail) {
    baseLabel = getAreaDisplayLabel(cell.baseFeatureDetail.tags);
  }

  const poiLabels = cell.poiFeatureDetails.map((detail) => getPoiDisplayLabel(detail.tags));
  const roadLabels = cell.roadFeatureDetails.map((detail) => getRoadDisplayLabel(detail.tags));
  const sourceFeatureIds = [
    ...(cell.baseFeatureDetail ? [cell.baseFeatureDetail.featureId] : []),
    ...cell.poiFeatureDetails.map( detial => detial.featureId),
    ...cell.roadFeatureDetails.map( detial => detial.featureId),
  ];

  return {
    row: cell.row,
    col: cell.col,
    center: cell.center,
    baseKind: cell.baseKind,
    baseLabel,
    poiLabels,
    roadLabels,
    label: buildCellLabel(cell.baseKind, baseLabel, poiLabels, roadLabels),
    sourceFeatureIds: [...new Set(sourceFeatureIds)],
  };
}

function buildCellLabel(
  baseKind: 'building' | 'area' | 'empty',
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

function buildGridDetailEntries(cells: MicroGridCell[][]): string[] {
  const flatFeatureDetails: (SceneFeatureDetail|null)[] = []
  cells.forEach( row  => row.forEach(
    cell => {
      cell.poiFeatureDetails.forEach( d => flatFeatureDetails.push(d))
      cell.roadFeatureDetails.forEach( d => flatFeatureDetails.push(d))
      flatFeatureDetails.push(cell.baseFeatureDetail)
    }
  ))

  return flatFeatureDetails.filter(d => d !== null).map(detail => buildFeatureDetailEntry(detail))
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

//#region 辅助填标签函数

const BUILDING_AND_POI_TAG_KEYS = ['name', 'brand', ...POI_STRUCTURED_TAG_KEYS, ...BUILDING_PRIMARY_LABEL_KEYS] as const;
const LINE_DETAIL_TAG_KEYS = ['name', ...LINE_PRIMARY_LABEL_KEYS] as const;
const AREA_DETAIL_TAG_KEYS = ['name', ...AREA_PRIMARY_LABEL_KEYS] as const;

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