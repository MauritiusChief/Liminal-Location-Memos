import { AREA_PRIMARY_LABEL_KEYS, BUILDING_PRIMARY_LABEL_KEYS, LINE_PRIMARY_LABEL_KEYS, POI_PRIMARY_LABEL_KEYS } from "@/services/osmNormalization/osmFeatureConfig.js";
import { MicroGrid, MicroGridCell } from "./microGridObject.js";
import { SceneFeatureDetail } from "./sceneUtilFeatureDetail.js";
import { buildBuildingBaseLabel, getAreaDisplayLabel, getPoiDisplayLabel, getRoadDisplayLabel, trimTagValue } from "./sceneUtilLabel.js";

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

export function buildMicroGridPrompt(microGrid: LabeledMicroGrid ): string {
  const gridLines = microGrid.cells.map((row) => row.map((cell) => cell.label || '.').join('\t'));
  const featureEntries = microGrid.detailEntries.join('\n\n');

  return [
    '## 等级0（30米内微网格）',
    '',
    '### 网格正文：',
    ...gridLines,
    '',
    '### 网格补充细节：',
    featureEntries || '无',
  ].join('\n');
}

//#region 出口带标签结构

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
  const featureDetailIndex = new Map<string, SceneFeatureDetail | null>()
  cells.forEach( row  => row.forEach(
    cell => {
      cell.poiFeatureDetails.forEach( d => featureDetailIndex.set(d.featureId, d))
      cell.roadFeatureDetails.forEach( d => featureDetailIndex.set(d.featureId, d))
      if (!cell.baseFeatureDetail) return
      featureDetailIndex.set(cell.baseFeatureDetail.featureId, cell.baseFeatureDetail)
    }
  ))

  return [...featureDetailIndex.values()].filter(d => d !== null).map(detail => buildFeatureDetailEntry(detail))
}


function buildFeatureDetailEntry(feature: SceneFeatureDetail): string {
  const detailTags = Object.keys(feature.tags).map( key => {
    const value = trimTagValue(feature.tags[key]);
    return `${key}: ${value}`}
  );
  const lines = [`${getFeatureDisplayTitle(feature)} (id=${feature.featureId}):`];

  if (detailTags.length > 0) {
    lines.push(...detailTags.map((tag) => `* ${tag}`));
  }

  return lines.join('\n');
}

//#region 辅助填标签函数

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
