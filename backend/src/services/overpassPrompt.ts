import type { NormalizedPolarFeatureSummary, NormalizedPolarView } from './overpassPolar.js';
import { LabeledMicroGrid } from './scene/microGridLabeled.js';

export type PromptSummaryMode = 'detailed' | 'concise';

/**
 * representativeLimit: 每个 feature cluster 最多展示 feature 数量的上限；
 * representativeMinAngleDegrees: feature cluster 中的一个被展示的 feature 应当满足的视野角的底线；
 */
const POLAR_LEVEL_CLUSTER_PROMPT_CONFIG: Record<
  1 | 2 | 3,
  {
    representativeLimit: number;
    representativeMinAngleDegrees: number;
  }
> = {
  1: {
    representativeLimit: 4,
    representativeMinAngleDegrees: 0,
  },
  2: {
    representativeLimit: 3,
    representativeMinAngleDegrees: 3,
  },
  3: {
    representativeLimit: 2,
    representativeMinAngleDegrees: 5,
  },
};

const CONCISE_DENSE_MEMBER_COUNT_BY_CATEGORY_AND_LEVEL: Record<
  NormalizedPolarFeatureSummary['category'],
  Record<1 | 2 | 3, number>
> = {
  building: { 1: 4, 2: 8, 3: 12 },
  poi: { 1: 5, 2: 50, 3: 200 },
  area: { 1: 6, 2: 12, 3: 24 },
  line: { 1: 12, 2: 30, 3: 60 },
};

/**
 * 只消费“已经投影好的场景结构”：request + microGrid + polarView。
 * 它不再回看 feature detail、完整 GeoJSON，也不负责任何空间计算。
 * @param input
 * @returns 符合要求的环境摘要提示词
 */
export function buildNormalizationPrompt(input: {
  request: { lat: number; lon: number; radius: number };
  summaryMode?: PromptSummaryMode;
  microGrid?: LabeledMicroGrid;
  polarView?: NormalizedPolarView;
}): string {
  const sections = [
    buildPromptIntro(input.request),
    buildGridSection(input.microGrid),
    buildPolarSection(input.polarView, input.summaryMode || 'detailed'),
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

function buildGridSection(microGrid: LabeledMicroGrid | undefined): string {
  if (!microGrid) {
    return '## 等级0（30米内微网格）：半径不足，未生成微网格。';
  }

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

function buildPolarSection(
  polarView: NormalizedPolarView | undefined,
  summaryMode: PromptSummaryMode,
): string {
  if (!polarView) {
    return '## 极坐标摘要：无';
  }

  const buildingAndPoiBlocks = polarView.levels.map((level) =>
    buildPolarLevelBlock(level.level, level.features, ['building', 'poi'], summaryMode),
  );
  const lineBlocks = polarView.levels.map((level) =>
    buildPolarLevelBlock(level.level, level.features, ['line'], summaryMode),
  );
  const areaBlocks = polarView.levels.map((level) =>
    buildPolarLevelBlock(level.level, level.features, ['area'], summaryMode),
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
  summaryMode: PromptSummaryMode,
): string {
  if (summaryMode === 'concise') {
    return buildConcisePolarLevelBlock(level, summaries, includedCategories);
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

      return entries
        .filter((entry) => isSignificantConciseFeature(entry))
        .map((entry) => ({
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
  const config = POLAR_LEVEL_CLUSTER_PROMPT_CONFIG[level];
  // 先对所有元素排序
  const sortedEntries = [...entries].sort(
    (left, right) =>
      left.widestSpan.angleWidthDegrees - right.widestSpan.angleWidthDegrees ||
      left.centerPoint.distanceMeters - right.centerPoint.distanceMeters ||
      left.osmId - right.osmId,
  );
  // 按照 POLAR_LEVEL_CLUSTER_PROMPT_CONFIG 过滤出有代表性的元素
  const representativeEntries = sortedEntries
    .filter((entry) => entry.widestSpan.angleWidthDegrees >= config.representativeMinAngleDegrees)
    .slice(0, config.representativeLimit);
  const fallbackEntry = representativeEntries.length === 0 ? (sortedEntries[0] ?? null) : null;
  // 实际应展示的元素
  const resolvedRepresentativeEntries = fallbackEntry ? [fallbackEntry] : representativeEntries;
  const omittedCount = Math.max(0, entries.length - resolvedRepresentativeEntries.length);
  const directionCluster = entries[0]!.directionCluster;
  const shouldShowOmissionSummary = omittedCount > 0;
  const hint = shouldShowOmissionSummary
    ? `，共${entries.length}个要素，展示${resolvedRepresentativeEntries.length}个代表要素，其余${omittedCount}个仅保留数量`
    : '';
  const lines = [`* 群中心方位${formatAngle(directionCluster.centerBearingDegrees)}${hint}`];

  for (const anchor of resolvedRepresentativeEntries) {
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

function isDenseConciseGroup(level: 1 | 2 | 3, entries: NormalizedPolarFeatureSummary[]): boolean {
  const first = entries[0];
  if (!first) {
    return false;
  }

  return first.directionCluster.memberCount >= CONCISE_DENSE_MEMBER_COUNT_BY_CATEGORY_AND_LEVEL[first.category][level];
}

function isSignificantConciseFeature(summary: NormalizedPolarFeatureSummary): boolean {
  return summary.promptSignals.isSignificantForConcise;
}

function formatPolarSample(sample: { distanceMeters: number; bearingDegrees: number }): string {
  return `距离${Math.round(sample.distanceMeters)}m / 方位${Math.round(sample.bearingDegrees)}°`;
}

function formatAngle(angleDegrees: number): string {
  return `${Math.round(angleDegrees)}°`;
}
