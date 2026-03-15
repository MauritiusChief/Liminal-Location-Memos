import type { DbFeatureDetail, GameSceneFeatureDetail } from './dbSceneTypes.js';
import type { NormalizedMicroGrid } from './overpassGrid.js';
import type { NormalizedPolarFeatureSummary, NormalizedPolarView } from './overpassPolar.js';
import {
  AREA_PRIMARY_LABEL_KEYS,
  BUILDING_PRIMARY_LABEL_KEYS,
  LINE_PRIMARY_LABEL_KEYS,
  POI_PRIMARY_LABEL_KEYS,
  POI_STRUCTURED_TAG_KEYS,
} from './osmFeatureConfig.js';
import { trimTagValue } from './overpassLabels.js';

export type PromptSummaryMode = 'detailed' | 'concise';

export interface PromptPreview {
  detailedUserPrompt1000: string;
  conciseUserPrompt1000: string;
  conciseUserPrompt200: string;
}

const BUILDING_AND_POI_TAG_KEYS = ['name', 'brand', ...POI_STRUCTURED_TAG_KEYS, ...BUILDING_PRIMARY_LABEL_KEYS] as const;
const LINE_DETAIL_TAG_KEYS = ['name', ...LINE_PRIMARY_LABEL_KEYS] as const;
const AREA_DETAIL_TAG_KEYS = ['name', ...AREA_PRIMARY_LABEL_KEYS] as const;
const POLAR_LEVEL_PROMPT_CONFIG: Record<
  1 | 2 | 3,
  {
    representativeLimit: number;
    representativeMinAngleDegrees: number;
    omissionSummaryMinGroupSize: number;
  }
> = {
  1: {
    representativeLimit: 3,
    representativeMinAngleDegrees: 0,
    omissionSummaryMinGroupSize: 3,
  },
  2: {
    representativeLimit: 3,
    representativeMinAngleDegrees: 3,
    omissionSummaryMinGroupSize: 3,
  },
  3: {
    representativeLimit: 4,
    representativeMinAngleDegrees: 5,
    omissionSummaryMinGroupSize: 0,
  },
};
// 建筑的视角阈值
const CONCISE_BUILDING_MIN_ANGLE_BY_LEVEL: Record<1 | 2 | 3, number> = { 1: 15, 2: 15, 3: 15 };
// 区域的视角阈值
const CONCISE_AREA_MIN_ANGLE_BY_LEVEL: Record<1 | 2 | 3, number> = { 1: 20, 2: 20, 3: 20 };
// 线类的视角阈值
const CONCISE_LINE_MIN_ANGLE_BY_LEVEL: Record<1 | 2 | 3, number> = { 1: 25, 2: 25, 3: 25 };

// 密集团簇的数量阈值，按类别与等级分层。
const CONCISE_DENSE_MEMBER_COUNT_BY_CATEGORY_AND_LEVEL: Record<
  NormalizedPolarFeatureSummary['category'],
  Record<1 | 2 | 3, number>
> = {
  building: { 1: 4, 2: 8, 3: 12 },
  poi: { 1: 5, 2: 50, 3: 200 },
  area: { 1: 6, 2: 12, 3: 24 },
  line: { 1: 12, 2: 30, 3: 60 },
};
const CONCISE_SIGNIFICANT_POI_TAGS = new Set(['man_made:antenna', 'man_made:tower']);
const SIGNIFICANT_BUILDING_MIN_HEIGHT_METERS = 35;
const SIGNIFICANT_BUILDING_MIN_LEVELS = 10;

// prompt 层只消费“已经投影好的场景结构”：
// request + microGrid + polarView + 少量 feature detail。
// 它不再回看完整 GeoJSON，也不负责任何空间计算。
export function buildNormalizationPrompt(input: {
  request: { lat: number; lon: number; radius: number };
  summaryMode?: PromptSummaryMode;
  microGrid?: NormalizedMicroGrid;
  polarView?: NormalizedPolarView;
  featureDetails: ReadonlyMap<string, DbFeatureDetail | GameSceneFeatureDetail>;
}): string {
  const sections = [
    buildPromptIntro(input.request),
    buildGridSection(input.microGrid, input.featureDetails),
    buildPolarSection(input.polarView, input.featureDetails, input.summaryMode || 'detailed'),
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
  featureDetails: ReadonlyMap<string, DbFeatureDetail | GameSceneFeatureDetail>,
): string {
  if (!microGrid || !microGrid.enabled) {
    return '## 等级0（30米内微网格）：半径不足，未生成微网格。';
  }

  const gridLines = microGrid.cells.map((row) => row.map((cell) => cell.label || '.').join('\t'));
  const featureEntries = Array.from(
    new Set(
      microGrid.cells.flatMap((row) =>
        row.flatMap((cell) => {
          // 空格子不额外展开细节，避免 prompt 被大量无意义条目淹没。
          if (cell.baseKind === 'empty' && cell.poiLabels.length === 0 && cell.roadLabels.length === 0) {
            return [];
          }

          return cell.sourceFeatureIds;
        }),
      ),
    ),
  )
    .flatMap((featureId) => {
      const feature = featureDetails.get(featureId);
      if (!feature) {
        return [];
      }

      return [buildFeatureDetailEntry(feature)];
    })
    .join('\n\n');

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

function buildPolarSection(
  polarView: NormalizedPolarView | undefined,
  featureDetails: ReadonlyMap<string, DbFeatureDetail | GameSceneFeatureDetail>,
  summaryMode: PromptSummaryMode,
): string {
  if (!polarView) {
    return '## 极坐标摘要：无';
  }

  const buildingAndPoiBlocks = polarView.levels.map((level) =>
    buildPolarLevelBlock(level.level, level.features, ['building', 'poi'], featureDetails, summaryMode),
  );
  const lineBlocks = polarView.levels.map((level) =>
    buildPolarLevelBlock(level.level, level.features, ['line'], featureDetails, summaryMode),
  );
  const areaBlocks = polarView.levels.map((level) =>
    buildPolarLevelBlock(level.level, level.features, ['area'], featureDetails, summaryMode),
  );

  return [
    '## 等级1到等级3（30米到1公里极坐标摘要）',
    '',
    '### 显著部分：建筑与POI',
    ...buildingAndPoiBlocks,
    '',
    '### 补充部分：线类',
    ...lineBlocks,
    '',
    '### 补充部分：区域',
    ...areaBlocks,
  ].join('\n');
}

function buildPolarLevelBlock(
  level: 1 | 2 | 3,
  summaries: NormalizedPolarFeatureSummary[],
  includedCategories: NormalizedPolarFeatureSummary['category'][],
  featureDetails: ReadonlyMap<string, DbFeatureDetail | GameSceneFeatureDetail>,
  summaryMode: PromptSummaryMode,
): string {
  if (summaryMode === 'concise') {
    return buildConcisePolarLevelBlock(level, summaries, includedCategories, featureDetails);
  }

  const groupedEntries = new Map<string, NormalizedPolarFeatureSummary[]>();
  const levelDesc = { 1: '100m~30m', 2: '300m~100m', 3: '1km~300m' };

  for (const summary of summaries) {
    if (!includedCategories.includes(summary.category)) {
      continue;
    }

    const existingGroup = groupedEntries.get(summary.directionCluster.clusterId) || [];
    existingGroup.push(summary);
    groupedEntries.set(summary.directionCluster.clusterId, existingGroup);
  }

  if (groupedEntries.size === 0) {
    return `#### 等级${level}(${levelDesc[level]})：\n信息不足，未生成极坐标摘要\n`;
  }

  const groupLines = Array.from(groupedEntries.values()).map((entries) => {
    const groupBlock = buildPolarGroupBlock(level, entries);
    return [groupBlock.title + ':', '', ...groupBlock.lines, ''].join('\n');
  });

  return [`#### 等级${level}(${levelDesc[level]})：`, ...groupLines].join('\n');
}

function buildPolarGroupBlock(
  level: 1 | 2 | 3,
  entries: NormalizedPolarFeatureSummary[],
): {
  title: string;
  lines: string[];
} {
  if (entries.length === 1) {
    return {
      title: entries[0]!.baseLabel,
      lines: buildPolarFeatureLines(entries[0]!),
    };
  }

  return {
    title: entries[0]!.clusterLabel,
    lines: buildPolarClusterSummaryLines(level, entries, 'detailed'),
  };
}

function buildConcisePolarLevelBlock(
  level: 1 | 2 | 3,
  summaries: NormalizedPolarFeatureSummary[],
  includedCategories: NormalizedPolarFeatureSummary['category'][],
  featureDetails: ReadonlyMap<string, DbFeatureDetail | GameSceneFeatureDetail>,
): string {
  const groupedEntries = new Map<string, NormalizedPolarFeatureSummary[]>();
  const levelDesc = { 1: '100m~30m', 2: '300m~100m', 3: '1km~300m' };

  for (const summary of summaries) {
    if (!includedCategories.includes(summary.category)) {
      continue;
    }

    const existingGroup = groupedEntries.get(summary.directionCluster.clusterId) || [];
    existingGroup.push(summary);
    groupedEntries.set(summary.directionCluster.clusterId, existingGroup);
  }

  const selectedBlocks = Array.from(groupedEntries.values())
    .flatMap((entries) => {
      const detailEntries = entries
        .map((entry) => ({ entry, detail: featureDetails.get(entry.featureId) }))
        .filter((candidate): candidate is { entry: NormalizedPolarFeatureSummary; detail: DbFeatureDetail } => Boolean(candidate.detail));
      if (detailEntries.length === 0) {
        return [];
      }

      if (isDenseConciseGroup(level, entries)) {
        return [{
          sortDistanceMeters: Math.min(...entries.map((entry) => entry.centerPoint.distanceMeters)),
          text: [
            `${entries[0]!.clusterLabel}:`,
            '',
            ...buildPolarClusterSummaryLines(level, entries, 'concise'),
            '',
          ].join('\n'),
        }];
      }

      return detailEntries
        .filter(({ entry, detail }) => isSignificantConciseFeature(level, entry, detail))
        .map(({ entry }) => ({
          sortDistanceMeters: entry.centerPoint.distanceMeters,
          text: [
            `${entry.baseLabel}:`,
            '',
            ...buildPolarFeatureLines(entry),
            '',
          ].join('\n'),
        }));
    })
    .sort((left, right) => left.sortDistanceMeters - right.sortDistanceMeters);

  if (selectedBlocks.length === 0) {
    return `#### 等级${level}(${levelDesc[level]})：\n信息不足，未生成极坐标摘要\n`;
  }

  return [`#### 等级${level}(${levelDesc[level]})：`, ...selectedBlocks.map((block) => block.text)].join('\n');
}

function buildPolarClusterSummaryLines(
  level: 1 | 2 | 3,
  entries: NormalizedPolarFeatureSummary[],
  summaryMode: PromptSummaryMode,
): string[] {
  const config = POLAR_LEVEL_PROMPT_CONFIG[level];
  const sortedEntries = [...entries].sort(
    (left, right) =>
      getPromptRepresentativeScore(right, summaryMode) - getPromptRepresentativeScore(left, summaryMode) ||
      left.centerPoint.distanceMeters - right.centerPoint.distanceMeters ||
      left.osmId - right.osmId,
  );
  const representativeEntries = sortedEntries
    .filter((entry) =>
      summaryMode === 'detailed' && entry.category === 'line'
        ? (entry.lineLengthMeters || 0) > 0
        : entry.widestSpan.angleWidthDegrees >= config.representativeMinAngleDegrees,
    )
    .slice(0, config.representativeLimit);
  const anchors = representativeEntries.length > 0 ? representativeEntries : sortedEntries.slice(0, 1);
  // 同一群里不把全部要素都展开，避免中远距离 prompt 过长失控。
  const omittedCount = Math.max(0, entries.length - anchors.length);
  const directionCluster = entries[0]!.directionCluster;
  const shouldShowOmissionSummary = summaryMode === 'concise'
    ? omittedCount > 0
    : omittedCount > 0 && entries.length > config.omissionSummaryMinGroupSize;
  const hint = shouldShowOmissionSummary
    ? `，共${entries.length}个要素，展示${anchors.length}个代表要素，其余${omittedCount}个仅保留数量`
    : '';
  const lines = [`* 群中心方位${formatAngle(directionCluster.centerBearingDegrees)}${hint}`];

  for (const anchor of anchors) {
    lines.push(...buildPolarFeatureLines(anchor));
  }

  return lines;
}

function buildPolarFeatureLines(summary: NormalizedPolarFeatureSummary): string[] {
  const detailTags = summary.visibleTags.map((tag) => `${tag.key}: ${tag.value}`);
  const baseLines = [
    `* (id=${summary.featureId})`,
  ];

  if (summary.category === 'line' && summary.linePoints && summary.linePoints.length > 0) {
    const pointText = summary.linePoints
      .map((point, index) => `点${index + 1}${formatPolarSample(point)}`)
      .join('，');
    return [
      ...baseLines,
      `  * 中心点${formatPolarSample(summary.centerPoint)}`,
      `  * 线顶点抽样：${pointText}`,
      `  * 主走向${formatAngle(summary.orientationDegrees || 0)}`,
      `  * 起终点开角：边界点1${formatPolarSample(summary.widestSpan.clockwiseEarlyPoint)}，边界点2${formatPolarSample(summary.widestSpan.clockwiseLatePoint)}，角宽${formatAngle(summary.widestSpan.angleWidthDegrees)}`,
      ...detailTags.map((tag) => `  * ${tag}`),
    ];
  }

  return [
    ...baseLines,
    `  * 最近点${formatPolarSample(summary.nearestPoint)}，最远点${formatPolarSample(summary.farthestPoint)}，中心点${formatPolarSample(summary.centerPoint)}`,
    `  * 边界点1${formatPolarSample(summary.widestSpan.clockwiseEarlyPoint)}，边界点2${formatPolarSample(summary.widestSpan.clockwiseLatePoint)}，视野角宽${formatAngle(summary.widestSpan.angleWidthDegrees)}`,
    ...detailTags.map((tag) => `  * ${tag}`),
  ];
}

function buildFeatureDetailEntry(feature: DbFeatureDetail | GameSceneFeatureDetail): string {
  const detailTags = collectImportantTags(feature);
  const lines = [`${getFeatureDisplayTitle(feature)} (id=${feature.featureId}):`];

  if (detailTags.length > 0) {
    lines.push(...detailTags.map((tag) => `* ${tag}`));
  } else {
    lines.push('* 无可展示细节');
  }

  return lines.join('\n');
}

function getFeatureDisplayTitle(feature: DbFeatureDetail | GameSceneFeatureDetail): string {
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

function collectImportantTags(feature: DbFeatureDetail | GameSceneFeatureDetail): string[] {
  // grid 细节区域的目标是“给人工检查和 prompt 补上下文”，
  // 因此只挑各类别最关键的少数标签。
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

function getPromptRepresentativeScore(summary: NormalizedPolarFeatureSummary, summaryMode: PromptSummaryMode): number {
  if (summaryMode === 'concise') {
    return summary.widestSpan.angleWidthDegrees;
  }

  if (summary.category === 'line') {
    return summary.lineLengthMeters || 0;
  }

  return summary.widestSpan.angleWidthDegrees;
}

function isDenseConciseGroup(level: 1 | 2 | 3, entries: NormalizedPolarFeatureSummary[]): boolean {
  const first = entries[0];
  if (!first) {
    return false;
  }

  return first.directionCluster.memberCount >= CONCISE_DENSE_MEMBER_COUNT_BY_CATEGORY_AND_LEVEL[first.category][level];
}

function isSignificantConciseFeature(
  level: 1 | 2 | 3,
  summary: NormalizedPolarFeatureSummary,
  detail: DbFeatureDetail | GameSceneFeatureDetail,
): boolean {
  switch (summary.category) {
    case 'building':
      return summary.widestSpan.angleWidthDegrees >= CONCISE_BUILDING_MIN_ANGLE_BY_LEVEL[level] || isTallBuilding(detail.tags);
    case 'poi':
      return isSignificantPoi(detail.tags);
    case 'line':
      return summary.widestSpan.angleWidthDegrees >= CONCISE_LINE_MIN_ANGLE_BY_LEVEL[level];
    case 'area':
      return summary.widestSpan.angleWidthDegrees >= CONCISE_AREA_MIN_ANGLE_BY_LEVEL[level];
  }
}

function isSignificantPoi(tags: Record<string, string>): boolean {
  for (const key of POI_PRIMARY_LABEL_KEYS) {
    const value = trimTagValue(tags[key]);
    if (value && CONCISE_SIGNIFICANT_POI_TAGS.has(`${key}:${value}`)) {
      return true;
    }
  }

  return false;
}

function isTallBuilding(tags: Record<string, string>): boolean {
  const heightMeters = parseHeightMeters(tags.height);
  if (heightMeters !== null && heightMeters >= SIGNIFICANT_BUILDING_MIN_HEIGHT_METERS) {
    return true;
  }

  const levelValues = [parseIntegerTag(tags['building:levels']), parseIntegerTag(tags.level)];
  return levelValues.some((value) => value !== null && value >= SIGNIFICANT_BUILDING_MIN_LEVELS);
}

function parseHeightMeters(value: string | undefined): number | null {
  const trimmed = trimTagValue(value);
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.toLowerCase().replace(/,/g, '');
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  if (normalized.includes('ft') || normalized.includes('feet')) {
    return parsed * 0.3048;
  }

  return parsed;
}

function parseIntegerTag(value: string | undefined): number | null {
  const trimmed = trimTagValue(value);
  if (!trimmed) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatPolarSample(sample: { distanceMeters: number; bearingDegrees: number }): string {
  return `距离${Math.round(sample.distanceMeters)}m / 方位${Math.round(sample.bearingDegrees)}°`;
}

function formatAngle(angleDegrees: number): string {
  return `${Math.round(angleDegrees)}°`;
}
