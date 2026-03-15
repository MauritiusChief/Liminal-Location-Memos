import type { DbFeatureDetail, DbPolarFeatureRecord } from './dbSceneTypes.js';
import {
  AREA_PRIMARY_LABEL_KEYS,
  BUILDING_PRIMARY_LABEL_KEYS,
  BUILDING_STRUCTURED_TAG_KEYS,
  LINE_PRIMARY_LABEL_KEYS,
  POI_PRIMARY_LABEL_KEYS,
  POI_STRUCTURED_TAG_KEYS,
} from './osmFeatureConfig.js';
import {
  bearingBetweenCoordinates,
  circularAngleDeltaDegrees,
  distanceBetweenCoordinates,
} from './overpassGeometry.js';
import {
  buildBuildingBaseLabel,
  getFallbackBuildingLikeLabel,
  getPrimaryLabel,
  trimTagValue,
} from './overpassLabels.js';

export type PolarFeatureCategory = 'building' | 'poi' | 'line' | 'area';

export interface PolarVisibleTag {
  key: string;
  value: string;
}

export interface PolarCoordinateSample {
  coordinate: [number, number];
  distanceMeters: number;
  bearingDegrees: number;
}

export interface PolarAngularSpan {
  clockwiseEarlyPoint: PolarCoordinateSample;
  clockwiseLatePoint: PolarCoordinateSample;
  angleWidthDegrees: number;
}

export interface PolarDirectionCluster {
  clusterId: string;
  centerBearingDegrees: number;
  memberCount: number;
}

export interface NormalizedPolarFeatureSummary {
  featureId: string;
  osmType: string;
  osmId: number;
  geometryType: string;
  category: PolarFeatureCategory;
  baseLabel: string;
  clusterLabel: string;
  directionCluster: PolarDirectionCluster;
  displayLabel: string;
  visibleTags: PolarVisibleTag[];
  level: 1 | 2 | 3;
  nearestPoint: PolarCoordinateSample;
  farthestPoint: PolarCoordinateSample;
  centerPoint: PolarCoordinateSample;
  widestSpan: PolarAngularSpan;
  linePoints?: PolarCoordinateSample[];
  linePath?: PolarCoordinateSample[];
  orientationDegrees?: number;
  lineLengthMeters?: number;
}

export interface NormalizedPolarLevel {
  level: 1 | 2 | 3;
  distanceRangeMeters: [number, number];
  features: NormalizedPolarFeatureSummary[];
}

export interface NormalizedPolarView {
  center: {
    lat: number;
    lon: number;
  };
  maxRadiusMeters: 1000;
  levels: NormalizedPolarLevel[];
}

interface PolarFeatureMetrics {
  category: PolarFeatureCategory;
  nearestPoint: PolarCoordinateSample;
  farthestPoint: PolarCoordinateSample;
  centerPoint: PolarCoordinateSample;
  widestSpan: PolarAngularSpan;
  linePoints?: PolarCoordinateSample[];
  linePath?: PolarCoordinateSample[];
  orientationDegrees?: number;
  lineLengthMeters?: number;
}

const MAX_POLAR_RADIUS_METERS = 1000 as const;
const POLAR_LEVELS: Array<{ level: 1 | 2 | 3; minExclusive: number; maxInclusive: number }> = [
  { level: 1, minExclusive: 30, maxInclusive: 100 },
  { level: 2, minExclusive: 100, maxInclusive: 300 },
  { level: 3, minExclusive: 300, maxInclusive: 1000 },
];
const DIRECTION_CLUSTER_THRESHOLD_DEGREES: Record<1 | 2 | 3, number> = {
  1: 20,
  2: 30,
  3: 45,
};

// polar 层的职责是“把 DB 导出的空间样本压缩成叙述友好的极坐标摘要”。
// 这里不再回看原始 GeoJSON，只消费已经投影好的点、路径和标签。
export function buildNormalizedPolarView(input: {
  records: DbPolarFeatureRecord[];
  featureDetails: Map<string, DbFeatureDetail>;
  request: { lat: number; lon: number };
}): NormalizedPolarView {
  const origin: [number, number] = [input.request.lon, input.request.lat];
  const summaries = input.records.flatMap((record) => {
    const detail = input.featureDetails.get(record.featureId);
    const summary = detail ? buildPolarFeatureSummary(record, detail, origin) : null;
    return summary ? [summary] : [];
  });
  // 先完成单要素摘要，再按 level + label 做方向聚类。
  const clusteredSummaries = applyDirectionClusters(summaries);

  const levels = POLAR_LEVELS.map<NormalizedPolarLevel>((definition) => ({
    level: definition.level,
    distanceRangeMeters: [definition.minExclusive, definition.maxInclusive],
    features: clusteredSummaries
      .filter((summary) => summary.level === definition.level)
      .sort(
        (left, right) =>
          left.centerPoint.distanceMeters - right.centerPoint.distanceMeters || left.osmId - right.osmId,
      ),
  }));

  return {
    center: {
      lat: input.request.lat,
      lon: input.request.lon,
    },
    maxRadiusMeters: MAX_POLAR_RADIUS_METERS,
    levels,
  };
}

function buildPolarFeatureSummary(
  record: DbPolarFeatureRecord,
  detail: DbFeatureDetail,
  origin: [number, number],
): NormalizedPolarFeatureSummary | null {
  const metrics = buildPolarFeatureMetrics(record, origin);
  if (!metrics) {
    return null;
  }

  // line 的层级判断改为看 centerPoint，
  // 因为它现在明确承担“线整体相对位置”的职责。
  const levelDistanceMeters =
    record.category === 'line' ? metrics.centerPoint.distanceMeters : metrics.nearestPoint.distanceMeters;
  const level = classifyPolarLevel(levelDistanceMeters);
  if (!level) {
    return null;
  }

  const filteredPresentation = applyPolarLevelFilter(detail, level, metrics);
  if (!filteredPresentation.shouldInclude) {
    return null;
  }

  return {
    featureId: record.featureId,
    osmType: record.osmType,
    osmId: record.osmId,
    geometryType: record.geometryType,
    category: record.category,
    baseLabel: filteredPresentation.baseLabel,
    clusterLabel: filteredPresentation.baseLabel,
    directionCluster: buildSingletonDirectionCluster(record.featureId, metrics.centerPoint.bearingDegrees),
    displayLabel: filteredPresentation.baseLabel,
    visibleTags: filteredPresentation.visibleTags,
    level,
    nearestPoint: metrics.nearestPoint,
    farthestPoint: metrics.farthestPoint,
    centerPoint: metrics.centerPoint,
    widestSpan: metrics.widestSpan,
    linePoints: metrics.linePoints,
    linePath: metrics.linePath,
    orientationDegrees: metrics.orientationDegrees,
    lineLengthMeters: metrics.lineLengthMeters,
  };
}

function buildPolarFeatureMetrics(
  record: DbPolarFeatureRecord,
  origin: [number, number],
): PolarFeatureMetrics | null {
  if (record.category === 'line') {
    return buildLineFeatureMetrics(record, origin);
  }

  if (record.sampleCoordinates.length === 0) {
    return null;
  }

  const samples = record.sampleCoordinates.map((coordinate) => toPolarCoordinateSample(origin, coordinate));
  const nearestPoint = selectNearestSample(samples);
  const farthestPoint = selectFarthestSample(samples);
  const centerCoordinate = record.centerCoordinate || record.sampleCoordinates[0] || null;

  if (!nearestPoint || !farthestPoint || !centerCoordinate) {
    return null;
  }

  return {
    category: record.category,
    nearestPoint,
    farthestPoint,
    centerPoint: toPolarCoordinateSample(origin, centerCoordinate),
    widestSpan: computeWidestSpan(record.geometryType, samples),
  };
}

function buildLineFeatureMetrics(
  record: DbPolarFeatureRecord,
  origin: [number, number],
): PolarFeatureMetrics | null {
  const linePathCoordinates = dedupeConsecutiveCoordinates(record.linePathCoordinates || record.sampleCoordinates);
  const lineVertexCoordinates = dedupeConsecutiveCoordinates(record.lineVertexCoordinates || linePathCoordinates);
  const centerCoordinate = record.centerCoordinate || linePathCoordinates[0] || null;

  if (linePathCoordinates.length < 2 || lineVertexCoordinates.length < 2 || !centerCoordinate) {
    return null;
  }

  const linePath = linePathCoordinates.map((coordinate) => toPolarCoordinateSample(origin, coordinate));
  const nearestPoint = selectNearestSample(linePath);
  const farthestPoint = selectFarthestSample(linePath);
  if (!nearestPoint || !farthestPoint) {
    return null;
  }

  // linePoints 是“供回归和 debug 展示的 4 个代表顶点”，
  // centerPoint 则单独沿用 SQL 的 centerCoordinate，两者职责完全分离。
  const representativeLineCoordinates = selectRepresentativeLineCoordinates(lineVertexCoordinates, 4);
  const linePoints = representativeLineCoordinates.map((coordinate) => toPolarCoordinateSample(origin, coordinate));
  const orientationDegrees = computeLineOrientationDegrees(representativeLineCoordinates);
  if (linePoints.length < 4 || orientationDegrees === null) {
    return null;
  }

  const startPoint = linePoints[0]!;
  const endPoint = linePoints[linePoints.length - 1]!;

  return {
    category: 'line',
    nearestPoint,
    farthestPoint,
    centerPoint: toPolarCoordinateSample(origin, centerCoordinate),
    // line 的 widestSpan 不再尝试描述“整条线的包络扇区”，
    // 而只反映起点与终点形成的方位开口。
    widestSpan: computeLineEndpointSpan(startPoint, endPoint),
    linePoints,
    linePath,
    orientationDegrees,
    lineLengthMeters: computePathLengthMeters(linePathCoordinates),
  };
}

function toPolarCoordinateSample(origin: [number, number], coordinate: [number, number]): PolarCoordinateSample {
  return {
    coordinate,
    distanceMeters: distanceBetweenCoordinates(origin, coordinate),
    bearingDegrees: bearingBetweenCoordinates(origin, coordinate),
  };
}

function selectNearestSample(samples: PolarCoordinateSample[]): PolarCoordinateSample | null {
  return samples.reduce<PolarCoordinateSample | null>((selected, sample) => {
    if (!selected || sample.distanceMeters < selected.distanceMeters) {
      return sample;
    }
    return selected;
  }, null);
}

function selectFarthestSample(samples: PolarCoordinateSample[]): PolarCoordinateSample | null {
  return samples.reduce<PolarCoordinateSample | null>((selected, sample) => {
    if (!selected || sample.distanceMeters > selected.distanceMeters) {
      return sample;
    }
    return selected;
  }, null);
}

function computeWidestSpan(geometryType: string, samples: PolarCoordinateSample[]): PolarAngularSpan {
  if (geometryType.toLowerCase().includes('point') || samples.length === 1) {
    const point = samples[0]!;
    return {
      clockwiseEarlyPoint: point,
      clockwiseLatePoint: point,
      angleWidthDegrees: 0,
    };
  }

  const sortedSamples = [...samples].sort((left, right) => left.bearingDegrees - right.bearingDegrees);
  let largestGap = -1;
  let gapStartIndex = 0;

  // 旧逻辑：在 bearing 序列中找到最大空隙，
  // 再用 360 - gap 得到最小包络视野角。
  for (let index = 0; index < sortedSamples.length; index += 1) {
    const current = sortedSamples[index]!;
    const next = sortedSamples[(index + 1) % sortedSamples.length]!;
    const gap = circularAngleDeltaDegrees(current.bearingDegrees, next.bearingDegrees);

    if (gap > largestGap) {
      largestGap = gap;
      gapStartIndex = index;
    }
  }

  const clockwiseLatePoint = sortedSamples[gapStartIndex]!;
  const clockwiseEarlyPoint = sortedSamples[(gapStartIndex + 1) % sortedSamples.length]!;

  return {
    clockwiseEarlyPoint,
    clockwiseLatePoint,
    angleWidthDegrees: 360 - largestGap,
  };
}

function computeLineEndpointSpan(
  startPoint: PolarCoordinateSample,
  endPoint: PolarCoordinateSample,
): PolarAngularSpan {
  const deltaForward = circularAngleDeltaDegrees(startPoint.bearingDegrees, endPoint.bearingDegrees);
  if (deltaForward <= 180) {
    return {
      clockwiseEarlyPoint: startPoint,
      clockwiseLatePoint: endPoint,
      angleWidthDegrees: deltaForward,
    };
  }

  return {
    clockwiseEarlyPoint: endPoint,
    clockwiseLatePoint: startPoint,
    angleWidthDegrees: 360 - deltaForward,
  };
}

function classifyPolarLevel(distanceMeters: number): 1 | 2 | 3 | null {
  const match = POLAR_LEVELS.find(
    (definition) => distanceMeters > definition.minExclusive && distanceMeters <= definition.maxInclusive,
  );
  return match ? match.level : null;
}

function applyPolarLevelFilter(
  detail: DbFeatureDetail,
  level: 1 | 2 | 3,
  metrics: PolarFeatureMetrics,
): {
  shouldInclude: boolean;
  baseLabel: string;
  visibleTags: PolarVisibleTag[];
} {
  if (level === 1) {
    return applyLevel1Filter(detail, metrics);
  }

  if (level === 2) {
    return applyLevel2Filter(detail, metrics);
  }

  return applyLevel3Filter(detail, metrics);
}

function applyLevel1Filter(
  detail: DbFeatureDetail,
  metrics: PolarFeatureMetrics,
): {
  shouldInclude: boolean;
  baseLabel: string;
  visibleTags: PolarVisibleTag[];
} {
  switch (metrics.category) {
    case 'building':
      return {
        shouldInclude: true,
        baseLabel: buildBuildingBaseLabel(detail),
        visibleTags: collectVisibleTags(detail.tags, ['name', 'brand', ...POI_STRUCTURED_TAG_KEYS, ...BUILDING_PRIMARY_LABEL_KEYS]),
      };
    case 'poi':
      return {
        shouldInclude: true,
        baseLabel: getPrimaryLabel(POI_PRIMARY_LABEL_KEYS, detail.tags) || 'poi',
        visibleTags: collectVisibleTags(detail.tags, ['name', 'brand', ...POI_STRUCTURED_TAG_KEYS]),
      };
    case 'line':
      return {
        shouldInclude: metrics.orientationDegrees !== undefined,
        baseLabel: getPrimaryLabel(LINE_PRIMARY_LABEL_KEYS, detail.tags) || 'way',
        visibleTags: collectVisibleTags(detail.tags, ['name', ...LINE_PRIMARY_LABEL_KEYS]),
      };
    case 'area':
      return {
        shouldInclude: true,
        baseLabel: getPrimaryLabel(AREA_PRIMARY_LABEL_KEYS, detail.tags) || 'area',
        visibleTags: collectVisibleTags(detail.tags, ['name', ...AREA_PRIMARY_LABEL_KEYS]),
      };
  }
}

function applyLevel2Filter(
  detail: DbFeatureDetail,
  metrics: PolarFeatureMetrics,
): {
  shouldInclude: boolean;
  baseLabel: string;
  visibleTags: PolarVisibleTag[];
} {
  switch (metrics.category) {
    case 'building':
      return {
        shouldInclude: true,
        baseLabel: buildBuildingBaseLabel(detail),
        visibleTags: collectVisibleTags(detail.tags, [...BUILDING_STRUCTURED_TAG_KEYS, 'name', 'brand']),
      };
    case 'poi': {
      const primaryTag = getPrimaryVisibleTag(detail.tags, POI_PRIMARY_LABEL_KEYS);
      return {
        shouldInclude: primaryTag !== null,
        baseLabel: primaryTag ? `${primaryTag.key}:${primaryTag.value}` : 'poi',
        visibleTags: primaryTag ? [primaryTag] : [],
      };
    }
    case 'line': {
      const primaryTag = getPrimaryVisibleTag(detail.tags, LINE_PRIMARY_LABEL_KEYS);
      return {
        shouldInclude: primaryTag !== null && metrics.orientationDegrees !== undefined,
        baseLabel: primaryTag ? `${primaryTag.key}:${primaryTag.value}` : 'way',
        visibleTags: primaryTag ? [primaryTag] : [],
      };
    }
    case 'area': {
      const primaryTag = getPrimaryVisibleTag(detail.tags, AREA_PRIMARY_LABEL_KEYS);
      return {
        shouldInclude: primaryTag !== null,
        baseLabel: primaryTag ? `${primaryTag.key}:${primaryTag.value}` : 'area',
        visibleTags: primaryTag ? [primaryTag] : [],
      };
    }
  }
}

function applyLevel3Filter(
  detail: DbFeatureDetail,
  metrics: PolarFeatureMetrics,
): {
  shouldInclude: boolean;
  baseLabel: string;
  visibleTags: PolarVisibleTag[];
} {
  switch (metrics.category) {
    case 'building': {
      return {
        shouldInclude: true,
        baseLabel: getFallbackBuildingLikeLabel(detail.tags),
        visibleTags: collectVisibleTags(detail.tags, BUILDING_STRUCTURED_TAG_KEYS),
      };
    }
    case 'poi':
      return {
        shouldInclude: true,
        baseLabel: getPrimaryLabel(POI_PRIMARY_LABEL_KEYS, detail.tags) || 'poi',
        visibleTags: collectVisibleTags(detail.tags, ['name', 'brand', ...POI_STRUCTURED_TAG_KEYS]),
      };
    case 'line': {
      const primaryTag = getPrimaryVisibleTag(detail.tags, LINE_PRIMARY_LABEL_KEYS);
      const shouldInclude =
        primaryTag !== null &&
        metrics.orientationDegrees !== undefined &&
        (metrics.lineLengthMeters || 0) > 0;
      return {
        shouldInclude,
        baseLabel: primaryTag ? `${primaryTag.key}:${primaryTag.value}` : 'way',
        visibleTags: shouldInclude && primaryTag ? [primaryTag] : [],
      };
    }
    case 'area': {
      const primaryTag = getPrimaryVisibleTag(detail.tags, AREA_PRIMARY_LABEL_KEYS);
      const shouldInclude = primaryTag !== null && metrics.widestSpan.angleWidthDegrees >= 5;
      return {
        shouldInclude,
        baseLabel: primaryTag ? `${primaryTag.key}:${primaryTag.value}` : 'area',
        visibleTags: shouldInclude && primaryTag ? [primaryTag] : [],
      };
    }
  }
}

function applyDirectionClusters(summaries: NormalizedPolarFeatureSummary[]): NormalizedPolarFeatureSummary[] {
  const groupedByLevelAndLabel = new Map<string, NormalizedPolarFeatureSummary[]>();

  // 不同 level 或不同标签的对象不应该互相聚类，否则会把叙述语义搅混。
  for (const summary of summaries) {
    const key = `${summary.level}:${summary.baseLabel}`;
    const existingGroup = groupedByLevelAndLabel.get(key) || [];
    existingGroup.push(summary);
    groupedByLevelAndLabel.set(key, existingGroup);
  }

  const clustered = new Map<string, NormalizedPolarFeatureSummary>();

  for (const entries of groupedByLevelAndLabel.values()) {
    const level = entries[0]?.level;
    if (level !== 1 && level !== 2 && level !== 3) {
      continue;
    }

    const clusters = splitEntriesIntoDirectionClusters(entries, DIRECTION_CLUSTER_THRESHOLD_DEGREES[level]);
    clusters.forEach((clusterEntries, clusterIndex) => {
      const centerBearingDegrees = computeCircularMeanDegrees(
        clusterEntries.map((entry) => entry.centerPoint.bearingDegrees),
      );
      const clusterId = `${entries[0]!.baseLabel}#L${level}C${clusterIndex + 1}`;
      const clusterLabel = `${entries[0]!.baseLabel}[${Math.round(centerBearingDegrees)}°群]`;

      clusterEntries.forEach((entry) => {
        clustered.set(entry.featureId, {
          ...entry,
          clusterLabel,
          displayLabel: clusterLabel,
          directionCluster: {
            clusterId,
            centerBearingDegrees,
            memberCount: clusterEntries.length,
          },
        });
      });
    });
  }

  return summaries.map((summary) => clustered.get(summary.featureId) || summary);
}

function splitEntriesIntoDirectionClusters(
  entries: NormalizedPolarFeatureSummary[],
  thresholdDegrees: number,
): NormalizedPolarFeatureSummary[][] {
  if (entries.length <= 1) {
    return [entries];
  }

  const sortedEntries = [...entries].sort(
    (left, right) => left.centerPoint.bearingDegrees - right.centerPoint.bearingDegrees,
  );
  const clusters: NormalizedPolarFeatureSummary[][] = [[sortedEntries[0]!]];

  // 是否并入当前群，不看“和最后一个点的角差”，
  // 而看“加入后整群的最小圆周包络角是否仍在阈值内”。
  for (let index = 1; index < sortedEntries.length; index += 1) {
    const current = sortedEntries[index]!;
    const currentCluster = clusters[clusters.length - 1]!;

    if (canAppendToDirectionCluster(currentCluster, current, thresholdDegrees)) {
      currentCluster.push(current);
      continue;
    }

    clusters.push([current]);
  }

  if (clusters.length > 1) {
    const firstCluster = clusters[0]!;
    const lastCluster = clusters[clusters.length - 1]!;

    // 这里处理跨 0° 的收口，例如 350° 与 8° 应该能合并成同一群。
    if (
      computeMinimalCircularSpanDegrees([
        ...lastCluster.map((entry) => entry.centerPoint.bearingDegrees),
        ...firstCluster.map((entry) => entry.centerPoint.bearingDegrees),
      ]) <= thresholdDegrees
    ) {
      firstCluster.unshift(...lastCluster);
      clusters.pop();
    }
  }

  return clusters;
}

function computeMinimalCircularSpanDegrees(values: number[]): number {
  if (values.length <= 1) {
    return 0;
  }

  const sortedValues = [...values].sort((left, right) => left - right);
  let largestGap = 0;

  for (let index = 0; index < sortedValues.length; index += 1) {
    const current = sortedValues[index]!;
    const next = sortedValues[(index + 1) % sortedValues.length]!;
    const gap = circularAngleDeltaDegrees(current, next);
    if (gap > largestGap) {
      largestGap = gap;
    }
  }

  return 360 - largestGap;
}

function canAppendToDirectionCluster(
  clusterEntries: NormalizedPolarFeatureSummary[],
  candidate: NormalizedPolarFeatureSummary,
  thresholdDegrees: number,
): boolean {
  return (
    computeMinimalCircularSpanDegrees([
      ...clusterEntries.map((entry) => entry.centerPoint.bearingDegrees),
      candidate.centerPoint.bearingDegrees,
    ]) <= thresholdDegrees
  );
}

function computeCircularMeanDegrees(values: number[]): number {
  // 圆周均值能正确处理 359° / 1° 这种跨 0° 的方向集合。
  const { sinSum, cosSum } = values.reduce(
    (accumulator, value) => {
      const radians = (value * Math.PI) / 180;
      return {
        sinSum: accumulator.sinSum + Math.sin(radians),
        cosSum: accumulator.cosSum + Math.cos(radians),
      };
    },
    { sinSum: 0, cosSum: 0 },
  );
  const radians = Math.atan2(sinSum, cosSum);
  return normalizeDegrees((radians * 180) / Math.PI);
}

function buildSingletonDirectionCluster(featureId: string, centerBearingDegrees: number): PolarDirectionCluster {
  return {
    clusterId: `${featureId}#solo`,
    centerBearingDegrees,
    memberCount: 1,
  };
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

function collectVisibleTags(tags: Record<string, string>, keys: readonly string[]): PolarVisibleTag[] {
  return keys.flatMap((key) => {
    const value = trimTagValue(tags[key]);
    return value ? [{ key, value }] : [];
  });
}

function getPrimaryVisibleTag(tags: Record<string, string>, keys: readonly string[]): PolarVisibleTag | null {
  // 这里故意保留 key:value 结构，便于 prompt 和前端都能看出标签语义来源。
  const primaryLabel = getPrimaryLabel(keys, tags);
  if (!primaryLabel) {
    return null;
  }

  const [key, ...valueParts] = primaryLabel.split(':');
  const value = valueParts.join(':');
  return key && value ? { key, value } : null;
}

function dedupeConsecutiveCoordinates(coordinates: [number, number][] | undefined): [number, number][] {
  const result: [number, number][] = [];

  for (const coordinate of coordinates || []) {
    const previous = result[result.length - 1];
    if (previous && previous[0] === coordinate[0] && previous[1] === coordinate[1]) {
      continue;
    }
    result.push(coordinate);
  }

  return result;
}

function selectRepresentativeLineCoordinates(
  coordinates: [number, number][],
  targetCount: number,
): [number, number][] {
  if (coordinates.length === 0) {
    return [];
  }

  if (coordinates.length === 1) {
    return Array.from({ length: targetCount }, () => coordinates[0]!);
  }

  const cumulativeDistances = buildCumulativeDistances(coordinates);
  const totalLengthMeters = cumulativeDistances[cumulativeDistances.length - 1] || 0;
  const selectedIndices: number[] = [];

  // 这里优先“贴近原始顶点”而不是直接插值，
  // 目标是让理想状态下的 4 个 linePoints 都直接来自线的原始顶点。
  for (let slot = 0; slot < targetCount; slot += 1) {
    const fraction = targetCount === 1 ? 0 : slot / (targetCount - 1);
    const targetDistance = totalLengthMeters * fraction;
    let bestIndex = 0;
    let bestDistanceGap = Number.POSITIVE_INFINITY;

    for (let index = 0; index < cumulativeDistances.length; index += 1) {
      if (slot > 0 && index <= selectedIndices[slot - 1]!) {
        continue;
      }
      if (slot < targetCount - 1 && cumulativeDistances.length - index < targetCount - slot) {
        continue;
      }

      const gap = Math.abs(cumulativeDistances[index]! - targetDistance);
      if (gap < bestDistanceGap) {
        bestDistanceGap = gap;
        bestIndex = index;
      }
    }

    selectedIndices.push(bestIndex);
  }

  const selectedCoordinates = selectedIndices.map((index) => coordinates[index]!);
  if (new Set(selectedCoordinates.map((coordinate) => coordinate.join(','))).size === selectedCoordinates.length) {
    return selectedCoordinates;
  }

  // 如果顶点过少或重复导致无法稳定拿到 4 个不同顶点，
  // 再退回到“按路径等距插值补点”。
  return buildInterpolatedPathSamples(coordinates, targetCount);
}

function buildCumulativeDistances(coordinates: [number, number][]): number[] {
  const cumulativeDistances: number[] = [0];

  for (let index = 1; index < coordinates.length; index += 1) {
    cumulativeDistances.push(
      cumulativeDistances[index - 1]! + distanceBetweenCoordinates(coordinates[index - 1]!, coordinates[index]!),
    );
  }

  return cumulativeDistances;
}

function buildInterpolatedPathSamples(
  coordinates: [number, number][],
  targetCount: number,
): [number, number][] {
  if (coordinates.length === 0) {
    return [];
  }

  if (coordinates.length === 1) {
    return Array.from({ length: targetCount }, () => coordinates[0]!);
  }

  const cumulativeDistances = buildCumulativeDistances(coordinates);
  const totalLengthMeters = cumulativeDistances[cumulativeDistances.length - 1] || 0;

  if (totalLengthMeters <= 0) {
    return Array.from({ length: targetCount }, (_, index) => coordinates[Math.min(index, coordinates.length - 1)]!);
  }

  return Array.from({ length: targetCount }, (_, slot) => {
    const fraction = targetCount === 1 ? 0 : slot / (targetCount - 1);
    const targetDistance = totalLengthMeters * fraction;
    return interpolateCoordinateAlongPath(coordinates, cumulativeDistances, targetDistance);
  });
}

function interpolateCoordinateAlongPath(
  coordinates: [number, number][],
  cumulativeDistances: number[],
  targetDistance: number,
): [number, number] {
  for (let index = 1; index < cumulativeDistances.length; index += 1) {
    const segmentStartDistance = cumulativeDistances[index - 1]!;
    const segmentEndDistance = cumulativeDistances[index]!;

    if (targetDistance > segmentEndDistance) {
      continue;
    }

    const startCoordinate = coordinates[index - 1]!;
    const endCoordinate = coordinates[index]!;
    const segmentLength = segmentEndDistance - segmentStartDistance;
    if (segmentLength <= 0) {
      return endCoordinate;
    }

    const ratio = (targetDistance - segmentStartDistance) / segmentLength;
    return [
      startCoordinate[0] + (endCoordinate[0] - startCoordinate[0]) * ratio,
      startCoordinate[1] + (endCoordinate[1] - startCoordinate[1]) * ratio,
    ];
  }

  return coordinates[coordinates.length - 1]!;
}

function computeLineOrientationDegrees(coordinates: [number, number][]): number | null {
  if (coordinates.length < 2) {
    return null;
  }

  const projected = coordinates.map(projectCoordinateToMeters);
  const meanX = projected.reduce((sum, point) => sum + point.x, 0) / projected.length;
  const meanY = projected.reduce((sum, point) => sum + point.y, 0) / projected.length;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;

  for (const point of projected) {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  if (sxx === 0 && syy === 0) {
    return null;
  }

  // 这里用 PCA/总最小二乘的主轴方向，而不是普通 y=f(x) 回归。
  // 原因是线可能接近竖直，若只做斜率回归会在接近无穷斜率时退化。
  const angleRadians = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dx = Math.cos(angleRadians);
  const dy = Math.sin(angleRadians);
  return normalizeDegrees((Math.atan2(dx, dy) * 180) / Math.PI);
}

function projectCoordinateToMeters(coordinate: [number, number]): { x: number; y: number } {
  const [lon, lat] = coordinate;
  const latRadians = (lat * Math.PI) / 180;
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon = 111_320 * Math.cos(latRadians);

  return {
    x: lon * metersPerDegreeLon,
    y: lat * metersPerDegreeLat,
  };
}

function computePathLengthMeters(coordinates: [number, number][]): number {
  let lengthMeters = 0;

  for (let index = 1; index < coordinates.length; index += 1) {
    lengthMeters += distanceBetweenCoordinates(coordinates[index - 1]!, coordinates[index]!);
  }

  return lengthMeters;
}
