import type { NormalizedFeature, NormalizedFeatureCollection } from './overpassNormalization.js';
import type { NormalizedMicroGrid } from './overpassGrid.js';
import type { NormalizedPolarFeatureSummary, NormalizedPolarView } from './overpassPolar.js';
import { AREA_TAG_KEYS, POI_TAG_KEYS, ROAD_TAG_KEYS, trimTagValue } from './overpassLabels.js';

export interface PromptPreview {
  userPrompt: string;
}

const BUILDING_AND_POI_TAG_KEYS = ['name', 'brand', ...POI_TAG_KEYS, 'building'] as const;
const LINE_DETAIL_TAG_KEYS = ['name', ...ROAD_TAG_KEYS] as const;
const AREA_DETAIL_TAG_KEYS = ['name', ...AREA_TAG_KEYS] as const;

// 这个文件把 grid / polar 结果压成 LLM 更容易直接阅读的中文文本。
// 它不重新做几何计算，只负责组织层级、排序和文本格式。
export function buildNormalizationPrompt(input: {
  request: { lat: number; lon: number; radius: number };
  geojson: NormalizedFeatureCollection;
  microGrid?: NormalizedMicroGrid;
  polarView?: NormalizedPolarView;
}): string {
  const featureById = new Map(input.geojson.features.map((feature) => [toFeatureId(feature), feature]));

  const sections = [
    buildPromptIntro(input.request),
    buildGridSection(input.microGrid, featureById),
    buildPolarSection(input.polarView, featureById),
  ];

  return sections.join('\n\n');
}

export function buildDefaultDebugSystemPrompt(): string {
  return [
    '你是一个擅长根据结构化空间描述理解查询点周边环境的助手。',
    '你会把用户提供的网格化与极坐标空间信息转化为自然、准确、谨慎的中文描述。',
    '优先关注建筑、POI、道路与区域的相对方位、距离、层级和可见范围。',
    '如果信息不足，不要编造；可以明确指出不确定之处。',
  ].join('\n');
}

function buildPromptIntro(request: { lat: number; lon: number; radius: number }): string {
  return [
    '请根据以下空间结构信息理解查询点周边环境。',
    `查询点：纬度 ${request.lat}，经度 ${request.lon}，原始查询半径 ${request.radius} 米。`,
    '表示法分为等级0到等级3：等级0描述30米内微网格；等级1到等级3描述30米到1公里范围内的极坐标摘要。',
  ].join('\n');
}

function buildGridSection(
  microGrid: NormalizedMicroGrid | undefined,
  featureById: Map<string, NormalizedFeature>,
): string {
  if (!microGrid || !microGrid.enabled) {
    return '等级0（30米内微网格）：半径不足，未生成微网格。';
  }

  const gridLines = microGrid.cells.map((row) => row.map((cell) => cell.label || '.').join('\t'));
  const featureEntries = Array.from(
    new Set(
      microGrid.cells.flatMap((row) =>
        row.flatMap((cell) => {
          if (cell.baseKind === 'empty' && cell.poiLabels.length === 0 && cell.roadLabels.length === 0) {
            return [];
          }

          return cell.sourceFeatureIds;
        }),
      ),
    ),
  )
    .flatMap((featureId) => {
      const feature = featureById.get(featureId);
      if (!feature) {
        return [];
      }

      return [buildFeatureDetailEntry(feature)];
    })
    .join('\n\n');

  return [
    '等级0（30米内微网格）',
    '网格正文：',
    ...gridLines,
    '',
    '网格补充细节：',
    featureEntries || '无',
  ].join('\n');
}

function buildPolarSection(
  polarView: NormalizedPolarView | undefined,
  featureById: Map<string, NormalizedFeature>,
): string {
  if (!polarView) {
    return '等级1到等级3（30米到1公里极坐标摘要）：无';
  }

  const buildingAndPoiBlocks = polarView.levels.map((level) =>
    buildPolarLevelBlock(level.level, level.features, featureById, true),
  );
  const lineAndAreaBlocks = polarView.levels.map((level) =>
    buildPolarLevelBlock(level.level, level.features, featureById, false),
  );

  return [
    '等级1到等级3（30米到1公里极坐标摘要）',
    '第一块：建筑与POI',
    ...buildingAndPoiBlocks,
    '',
    '第二块：线类与区域',
    ...lineAndAreaBlocks,
  ].join('\n');
}

function buildPolarLevelBlock(
  level: 1 | 2 | 3,
  summaries: NormalizedPolarFeatureSummary[],
  featureById: Map<string, NormalizedFeature>,
  includeBuildingAndPoi: boolean,
): string {
  const groupedEntries = new Map<string, Array<{ summary: NormalizedPolarFeatureSummary; feature: NormalizedFeature }>>();

  for (const summary of summaries) {
    const feature = featureById.get(summary.featureId);
    if (!feature) {
      continue;
    }

    if (includeBuildingAndPoi ? !isBuildingOrPoiFeature(feature) : isBuildingOrPoiFeature(feature)) {
      continue;
    }

    if (includeBuildingAndPoi && isPoiWithoutReadableDetail(feature)) {
      continue;
    }

    const existingGroup = groupedEntries.get(summary.displayLabel) || [];
    existingGroup.push({ summary, feature });
    groupedEntries.set(summary.displayLabel, existingGroup);
  }

  if (groupedEntries.size === 0) {
    return `等级${level}：无`;
  }

  const groupLines = Array.from(groupedEntries.entries()).map(([label, entries]) => {
    const itemLines = entries.flatMap(({ summary, feature }) => buildPolarFeatureLines(summary, feature));
    return [label + ':', ...itemLines].join('\n');
  });

  return [`等级${level}：`, ...groupLines].join('\n');
}

function buildPolarFeatureLines(summary: NormalizedPolarFeatureSummary, feature: NormalizedFeature): string[] {
  const detailTags = collectImportantTags(feature);

  return [
    `* (id=${summary.featureId})`,
    `  * 最近点${formatPolarSample(summary.nearestPoint)}，最远点${formatPolarSample(summary.farthestPoint)}，中心点${formatPolarSample(summary.centerPoint)}`,
    `  * 边界点1${formatPolarSample(summary.widestSpan.clockwiseEarlyPoint)}，边界点2${formatPolarSample(summary.widestSpan.clockwiseLatePoint)}，视野角宽${formatAngle(summary.widestSpan.angleWidthDegrees)}`,
    ...detailTags.map((tag) => `  * ${tag}`),
  ];
}

function buildFeatureDetailEntry(feature: NormalizedFeature): string {
  const detailTags = collectImportantTags(feature);
  const lines = [`${getFeatureDisplayTitle(feature)} (id=${toFeatureId(feature)}):`];

  if (detailTags.length > 0) {
    lines.push(...detailTags.map((tag) => `* ${tag}`));
  } else {
    lines.push('* 无可展示细节');
  }

  return lines.join('\n');
}

function getFeatureDisplayTitle(feature: NormalizedFeature): string {
  const name = trimTagValue(feature.properties.tags.name);
  const brand = trimTagValue(feature.properties.tags.brand);

  if (name) {
    return name;
  }

  if (brand) {
    return brand;
  }

  for (const key of [...POI_TAG_KEYS, ...ROAD_TAG_KEYS, ...AREA_TAG_KEYS, 'building'] as const) {
    const value = trimTagValue(feature.properties.tags[key]);
    if (value) {
      return `${key}:${value}`;
    }
  }

  return toFeatureId(feature);
}

function collectImportantTags(feature: NormalizedFeature): string[] {
  const keys = isBuildingOrPoiFeature(feature)
    ? BUILDING_AND_POI_TAG_KEYS
    : isLineFeature(feature)
      ? LINE_DETAIL_TAG_KEYS
      : AREA_DETAIL_TAG_KEYS;

  return keys.flatMap((key) => {
    const value = trimTagValue(feature.properties.tags[key]);
    return value ? [`${key}: ${value}`] : [];
  });
}

function isBuildingOrPoiFeature(feature: NormalizedFeature): boolean {
  if (typeof feature.properties.tags.building === 'string') {
    return true;
  }

  return POI_TAG_KEYS.some((key) => typeof feature.properties.tags[key] === 'string');
}

function isPoiWithoutReadableDetail(feature: NormalizedFeature): boolean {
  const hasPoiTag = POI_TAG_KEYS.some((key) => typeof feature.properties.tags[key] === 'string');
  if (!hasPoiTag) {
    return false;
  }

  return !trimTagValue(feature.properties.tags.name) && !trimTagValue(feature.properties.tags.brand);
}

function isLineFeature(feature: NormalizedFeature): boolean {
  return feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString';
}

function formatPolarSample(sample: { distanceMeters: number; bearingDegrees: number }): string {
  return `距离${Math.round(sample.distanceMeters)}m / 方位${Math.round(sample.bearingDegrees)}°`;
}

function formatAngle(angleDegrees: number): string {
  return `${Math.round(angleDegrees)}°`;
}

function toFeatureId(feature: NormalizedFeature): string {
  return feature.id ? String(feature.id) : `${feature.properties.osmType}/${feature.properties.osmId}`;
}
