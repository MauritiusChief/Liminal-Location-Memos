import type { Geometry } from 'geojson';
import {
  bearingBetweenCoordinates,
  circularAngleDeltaDegrees,
  distanceBetweenCoordinates,
  extractAllCoordinates,
  getBoundingBoxCenter,
} from './overpassGeometry.js';
import {
  AREA_TAG_KEYS,
  buildBuildingBaseLabel,
  getAreaDisplayLabel,
  getFallbackBuildingLabel,
  getPoiDisplayLabel,
  getPrimaryLabel,
  getRoadDisplayLabel,
  POI_TAG_KEYS,
  ROAD_TAG_KEYS,
  trimTagValue,
} from './overpassLabels.js';
import type { NormalizedFeature } from './overpassNormalization.js';

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
const DIRECTION_CLUSTER_THRESHOLD_DEGREES: Record<2 | 3, number> = {
  2: 25,
  3: 20,
};
// polar 视图只消费 normalized features；
// 它的任务不是重建几何，而是压缩出“对叙述最有用的视角信息”。
export function buildNormalizedPolarView(
  features: NormalizedFeature[],
  request: { lat: number; lon: number },
): NormalizedPolarView {
  const origin: [number, number] = [request.lon, request.lat];
  const summaries = features.flatMap((feature) => {
    const summary = buildPolarFeatureSummary(feature, origin);
    return summary ? [summary] : [];
  });
  const clusteredSummaries = applyDirectionClusters(summaries);

  const levels = POLAR_LEVELS.map<NormalizedPolarLevel>((definition) => ({
    level: definition.level,
    distanceRangeMeters: [definition.minExclusive, definition.maxInclusive],
    features: clusteredSummaries
      .filter((summary) => summary.level === definition.level)
      .sort((left, right) => left.centerPoint.distanceMeters - right.centerPoint.distanceMeters || left.osmId - right.osmId),
  }));

  return {
    center: {
      lat: request.lat,
      lon: request.lon,
    },
    maxRadiusMeters: MAX_POLAR_RADIUS_METERS,
    levels,
  };
}

function buildPolarFeatureSummary(
  feature: NormalizedFeature,
  origin: [number, number],
): NormalizedPolarFeatureSummary | null {
  const clippedCoordinates = clipFeatureCoordinatesToRadius(feature.geometry, origin, MAX_POLAR_RADIUS_METERS);
  if (clippedCoordinates.length === 0) {
    return null;
  }

  const samples = clippedCoordinates.map((coordinate) => toPolarCoordinateSample(origin, coordinate));
  const nearestPoint = selectNearestSample(samples);
  const farthestPoint = selectFarthestSample(samples);
  const centerCoordinate = feature.geometry.type === 'Point' ? clippedCoordinates[0] || null : getBoundingBoxCenter(clippedCoordinates);
  if (!nearestPoint || !farthestPoint || !centerCoordinate) {
    return null;
  }

  const centerPoint = toPolarCoordinateSample(origin, centerCoordinate);
  const level = classifyPolarLevel(nearestPoint.distanceMeters);
  if (!level) {
    return null;
  }

  const category = classifyPolarFeature(feature);
  const filteredPresentation = applyPolarLevelFilter(feature, category, level, computeWidestSpan(feature.geometry, samples));
  if (!filteredPresentation.shouldInclude) {
    return null;
  }

  const widestSpan = computeWidestSpan(feature.geometry, samples);

  return {
    featureId: toFeatureId(feature),
    osmType: feature.properties.osmType,
    osmId: feature.properties.osmId,
    geometryType: feature.geometry.type,
    category,
    baseLabel: filteredPresentation.baseLabel,
    clusterLabel: filteredPresentation.baseLabel,
    directionCluster: buildSingletonDirectionCluster(toFeatureId(feature), centerPoint.bearingDegrees),
    displayLabel: filteredPresentation.baseLabel,
    visibleTags: filteredPresentation.visibleTags,
    level,
    nearestPoint,
    farthestPoint,
    centerPoint,
    widestSpan,
  };
}

function clipFeatureCoordinatesToRadius(
  geometry: Geometry,
  origin: [number, number],
  maxRadiusMeters: number,
): [number, number][] {
  return extractAllCoordinates(geometry).filter((coordinate) => distanceBetweenCoordinates(origin, coordinate) <= maxRadiusMeters);
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

// widest span 体现“这个要素从查询点看占据了多宽的视野角”。
// 实现上通过寻找 bearing 序列里的最大 gap，反推出最小包络角宽。
// 这里的 clockwiseEarlyPoint / clockwiseLatePoint 表示“可见扇区两侧的边界点”，
// 它们本身不是前端 SVG 路径的天然 start/end sweep 参数，真正可信的角宽以 angleWidthDegrees 为准。
function computeWidestSpan(geometry: Geometry, samples: PolarCoordinateSample[]): PolarAngularSpan {
  if (geometry.type === 'Point' || samples.length === 1) {
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

function classifyPolarFeature(feature: NormalizedFeature): PolarFeatureCategory {
  if (typeof feature.properties.tags.building === 'string') {
    return 'building';
  }

  if (POI_TAG_KEYS.some((key) => typeof feature.properties.tags[key] === 'string')) {
    return 'poi';
  }

  if (feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString') {
    return 'line';
  }

  return 'area';
}

function applyPolarLevelFilter(
  feature: NormalizedFeature,
  category: PolarFeatureCategory,
  level: 1 | 2 | 3,
  widestSpan: PolarAngularSpan,
): {
  shouldInclude: boolean;
  baseLabel: string;
  visibleTags: PolarVisibleTag[];
} {
  if (level === 1) {
    return applyLevel1Filter(feature, category);
  }

  if (level === 2) {
    return applyLevel2Filter(feature, category);
  }

  return applyLevel3Filter(feature, category, widestSpan);
}

function applyLevel1Filter(
  feature: NormalizedFeature,
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
        baseLabel: buildBuildingBaseLabel(feature as never),
        visibleTags: collectVisibleTags(feature, ['name', 'brand', ...POI_TAG_KEYS, 'building']),
      };
    case 'poi':
      return {
        shouldInclude: true,
        baseLabel: getPoiDisplayLabel(feature.properties.tags),
        visibleTags: collectVisibleTags(feature, ['name', 'brand', ...POI_TAG_KEYS]),
      };
    case 'line':
      return {
        shouldInclude: true,
        baseLabel: getRoadDisplayLabel(feature.properties.tags),
        visibleTags: collectVisibleTags(feature, ['name', ...ROAD_TAG_KEYS]),
      };
    case 'area':
      return {
        shouldInclude: true,
        baseLabel: getAreaDisplayLabel(feature.properties.tags),
        visibleTags: collectVisibleTags(feature, ['name', ...AREA_TAG_KEYS]),
      };
  }
}

function applyLevel2Filter(
  feature: NormalizedFeature,
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
        baseLabel: buildBuildingBaseLabel(feature as never),
        visibleTags: collectVisibleTags(feature, ['building', 'name', 'brand']),
      };
    case 'poi': {
      const primaryTag = getPrimaryVisibleTag(feature, POI_TAG_KEYS);
      return {
        shouldInclude: primaryTag !== null,
        baseLabel: primaryTag ? `${primaryTag.key}:${primaryTag.value}` : 'poi',
        visibleTags: primaryTag ? [primaryTag] : [],
      };
    }
    case 'line': {
      const primaryTag = getPrimaryVisibleTag(feature, ROAD_TAG_KEYS);
      return {
        shouldInclude: primaryTag !== null,
        baseLabel: primaryTag ? `${primaryTag.key}:${primaryTag.value}` : 'way',
        visibleTags: primaryTag ? [primaryTag] : [],
      };
    }
    case 'area': {
      const primaryTag = getPrimaryVisibleTag(feature, AREA_TAG_KEYS);
      return {
        shouldInclude: primaryTag !== null,
        baseLabel: primaryTag ? `${primaryTag.key}:${primaryTag.value}` : 'area',
        visibleTags: primaryTag ? [primaryTag] : [],
      };
    }
  }
}

function applyLevel3Filter(
  feature: NormalizedFeature,
  category: PolarFeatureCategory,
  widestSpan: PolarAngularSpan,
): {
  shouldInclude: boolean;
  baseLabel: string;
  visibleTags: PolarVisibleTag[];
} {
  switch (category) {
    case 'building': {
      const buildingValue = trimTagValue(feature.properties.tags.building);
      return {
        shouldInclude: true,
        baseLabel: getFallbackBuildingLabel(buildingValue || undefined),
        visibleTags: buildingValue ? [{ key: 'building', value: buildingValue }] : [],
      };
    }
    case 'poi':
      return {
        shouldInclude: false,
        baseLabel: 'poi',
        visibleTags: [],
      };
    case 'line': {
      const primaryTag = getPrimaryVisibleTag(feature, ROAD_TAG_KEYS);
      const shouldInclude = primaryTag !== null && widestSpan.angleWidthDegrees >= 5;
      return {
        shouldInclude,
        baseLabel: primaryTag ? `${primaryTag.key}:${primaryTag.value}` : 'way',
        visibleTags: shouldInclude && primaryTag ? [primaryTag] : [],
      };
    }
    case 'area': {
      const primaryTag = getPrimaryVisibleTag(feature, AREA_TAG_KEYS);
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

  for (const summary of summaries) {
    const key = `${summary.level}:${summary.baseLabel}`;
    const existingGroup = groupedByLevelAndLabel.get(key) || [];
    existingGroup.push(summary);
    groupedByLevelAndLabel.set(key, existingGroup);
  }

  const clustered = new Map<string, NormalizedPolarFeatureSummary>();

  for (const summary of summaries) {
    if (summary.level === 1) {
      clustered.set(summary.featureId, {
        ...summary,
        clusterLabel: summary.baseLabel,
        displayLabel: summary.baseLabel,
        directionCluster: buildSingletonDirectionCluster(summary.featureId, summary.centerPoint.bearingDegrees),
      });
    }
  }

  for (const entries of groupedByLevelAndLabel.values()) {
    const level = entries[0]?.level;
    if (level !== 2 && level !== 3) {
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

  for (let index = 1; index < sortedEntries.length; index += 1) {
    const previous = sortedEntries[index - 1]!;
    const current = sortedEntries[index]!;
    const currentCluster = clusters[clusters.length - 1]!;
    const gap = circularAngleDeltaDegrees(previous.centerPoint.bearingDegrees, current.centerPoint.bearingDegrees);

    if (gap <= thresholdDegrees) {
      currentCluster.push(current);
      continue;
    }

    clusters.push([current]);
  }

  if (clusters.length > 1) {
    const firstCluster = clusters[0]!;
    const lastCluster = clusters[clusters.length - 1]!;
    const wrapGap = circularAngleDeltaDegrees(
      lastCluster[lastCluster.length - 1]!.centerPoint.bearingDegrees,
      firstCluster[0]!.centerPoint.bearingDegrees,
    );

    if (wrapGap <= thresholdDegrees) {
      firstCluster.unshift(...lastCluster);
      clusters.pop();
    }
  }

  return clusters;
}

function computeCircularMeanDegrees(values: number[]): number {
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

function collectVisibleTags(
  feature: NormalizedFeature,
  keys: readonly string[],
): PolarVisibleTag[] {
  return keys.flatMap((key) => {
    const value = trimTagValue(feature.properties.tags[key]);
    return value ? [{ key, value }] : [];
  });
}

function getPrimaryVisibleTag(
  feature: NormalizedFeature,
  keys: readonly string[],
): PolarVisibleTag | null {
  const primaryLabel = getPrimaryLabel(keys, feature.properties.tags);
  if (!primaryLabel) {
    return null;
  }

  const [key, ...valueParts] = primaryLabel.split(':');
  const value = valueParts.join(':');
  return key && value ? { key, value } : null;
}

function toFeatureId(feature: NormalizedFeature): string {
  return feature.id ? String(feature.id) : `${feature.properties.osmType}/${feature.properties.osmId}`;
}
