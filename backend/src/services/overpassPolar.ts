import type { DbFeatureDetail, DbPolarFeatureRecord } from './dbSceneTypes.js';
import {
  bearingBetweenCoordinates,
  circularAngleDeltaDegrees,
  distanceBetweenCoordinates,
} from './overpassGeometry.js';
import {
  AREA_TAG_KEYS,
  buildBuildingBaseLabel,
  getFallbackBuildingLabel,
  getPrimaryLabel,
  POI_TAG_KEYS,
  ROAD_TAG_KEYS,
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

// polar 层现在的职责是“把 DB 导出的坐标样本压缩成叙述友好的极坐标摘要”。
// 它不再关心原始 GeoJSON 拓扑，只关心样本点、标签和分层/聚类规则。
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
  // 先对单个要素完成摘要，再按 level + label 做方向聚类。
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
  if (record.sampleCoordinates.length === 0) {
    return null;
  }

  const samples = record.sampleCoordinates.map((coordinate) => toPolarCoordinateSample(origin, coordinate));
  const nearestPoint = selectNearestSample(samples);
  const farthestPoint = selectFarthestSample(samples);
  // centerCoordinate 来自 SQL 的“中心候选点”；
  // 如果缺失，退回到第一个采样点，保证极端数据下仍可产出摘要。
  const centerCoordinate = record.centerCoordinate || record.sampleCoordinates[0] || null;

  if (!nearestPoint || !farthestPoint || !centerCoordinate) {
    return null;
  }

  const centerPoint = toPolarCoordinateSample(origin, centerCoordinate);
  const level = classifyPolarLevel(nearestPoint.distanceMeters);
  if (!level) {
    return null;
  }

  const widestSpan = computeWidestSpan(record.geometryType, samples);
  // level filter 决定不同距离层保留哪些类别、展示哪些标签。
  const filteredPresentation = applyPolarLevelFilter(detail, record.category, level, widestSpan);
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
    directionCluster: buildSingletonDirectionCluster(record.featureId, centerPoint.bearingDegrees),
    displayLabel: filteredPresentation.baseLabel,
    visibleTags: filteredPresentation.visibleTags,
    level,
    nearestPoint,
    farthestPoint,
    centerPoint,
    widestSpan,
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

  // 这里沿用旧逻辑：找出 bearing 序列中的最大空隙，
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

function classifyPolarLevel(distanceMeters: number): 1 | 2 | 3 | null {
  const match = POLAR_LEVELS.find(
    (definition) => distanceMeters > definition.minExclusive && distanceMeters <= definition.maxInclusive,
  );
  return match ? match.level : null;
}

function applyPolarLevelFilter(
  detail: DbFeatureDetail,
  category: PolarFeatureCategory,
  level: 1 | 2 | 3,
  widestSpan: PolarAngularSpan,
): {
  shouldInclude: boolean;
  baseLabel: string;
  visibleTags: PolarVisibleTag[];
} {
  if (level === 1) {
    return applyLevel1Filter(detail, category);
  }

  if (level === 2) {
    return applyLevel2Filter(detail, category);
  }

  return applyLevel3Filter(detail, category, widestSpan);
}

function applyLevel1Filter(
  detail: DbFeatureDetail,
  category: PolarFeatureCategory,
): {
  shouldInclude: boolean;
  baseLabel: string;
  visibleTags: PolarVisibleTag[];
} {
  switch (category) {
    case 'building':
      return {
        shouldInclude: true,
        baseLabel: buildBuildingBaseLabel(detail),
        visibleTags: collectVisibleTags(detail.tags, ['name', 'brand', ...POI_TAG_KEYS, 'building']),
      };
    case 'poi':
      return {
        shouldInclude: true,
        baseLabel: getPrimaryLabel(POI_TAG_KEYS, detail.tags) || 'poi',
        visibleTags: collectVisibleTags(detail.tags, ['name', 'brand', ...POI_TAG_KEYS]),
      };
    case 'line':
      return {
        shouldInclude: true,
        baseLabel: getPrimaryLabel(ROAD_TAG_KEYS, detail.tags) || 'way',
        visibleTags: collectVisibleTags(detail.tags, ['name', ...ROAD_TAG_KEYS]),
      };
    case 'area':
      return {
        shouldInclude: true,
        baseLabel: getPrimaryLabel(AREA_TAG_KEYS, detail.tags) || 'area',
        visibleTags: collectVisibleTags(detail.tags, ['name', ...AREA_TAG_KEYS]),
      };
  }
}

function applyLevel2Filter(
  detail: DbFeatureDetail,
  category: PolarFeatureCategory,
): {
  shouldInclude: boolean;
  baseLabel: string;
  visibleTags: PolarVisibleTag[];
} {
  switch (category) {
    case 'building':
      return {
        shouldInclude: true,
        baseLabel: buildBuildingBaseLabel(detail),
        visibleTags: collectVisibleTags(detail.tags, ['building', 'height', 'level', 'building:levels', 'name', 'brand']),
      };
    case 'poi': {
      const primaryTag = getPrimaryVisibleTag(detail.tags, POI_TAG_KEYS);
      return {
        shouldInclude: primaryTag !== null,
        baseLabel: primaryTag ? `${primaryTag.key}:${primaryTag.value}` : 'poi',
        visibleTags: primaryTag ? [primaryTag] : [],
      };
    }
    case 'line': {
      const primaryTag = getPrimaryVisibleTag(detail.tags, ROAD_TAG_KEYS);
      return {
        shouldInclude: primaryTag !== null,
        baseLabel: primaryTag ? `${primaryTag.key}:${primaryTag.value}` : 'way',
        visibleTags: primaryTag ? [primaryTag] : [],
      };
    }
    case 'area': {
      const primaryTag = getPrimaryVisibleTag(detail.tags, AREA_TAG_KEYS);
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
  category: PolarFeatureCategory,
  widestSpan: PolarAngularSpan,
): {
  shouldInclude: boolean;
  baseLabel: string;
  visibleTags: PolarVisibleTag[];
} {
  switch (category) {
    case 'building': {
      const buildingValue = trimTagValue(detail.tags.building);
      return {
        shouldInclude: true,
        baseLabel: getFallbackBuildingLabel(buildingValue || undefined),
        visibleTags: collectVisibleTags(detail.tags, ['building', 'height', 'level', 'building:levels']),
      };
    }
    case 'poi':
      return {
        shouldInclude: false,
        baseLabel: 'poi',
        visibleTags: [],
      };
    case 'line': {
      const primaryTag = getPrimaryVisibleTag(detail.tags, ROAD_TAG_KEYS);
      const shouldInclude = primaryTag !== null && widestSpan.angleWidthDegrees >= 5;
      return {
        shouldInclude,
        baseLabel: primaryTag ? `${primaryTag.key}:${primaryTag.value}` : 'way',
        visibleTags: shouldInclude && primaryTag ? [primaryTag] : [],
      };
    }
    case 'area': {
      const primaryTag = getPrimaryVisibleTag(detail.tags, AREA_TAG_KEYS);
      const shouldInclude = primaryTag !== null && widestSpan.angleWidthDegrees >= 5;
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
