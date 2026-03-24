import { normalizeBearingDegrees } from "../geometry.js";
import { PolarView } from "./polarViewLabeled.js";

interface AngularSpan {
  clockwiseEarlyDegree: number;
  clockwiseLateDegree: number;
  angleWidthDegrees: number;
}

interface DegreeInterval {
  startDegree: number;
  endDegree: number;
}

/**
 * 按名称命名的过滤参数
 * TODO：未来可能还会添加只能看某一段局限视界里的内容
 */
interface PolarViewFilter {
  id: string,
  visibleSpan?: AngularSpan, // TODO 可视的范围
  seeThroughSpans?: AngularSpan[], // TODO 可以无视遮挡看到所有物体的范围
  buildingFilters: Record<1 | 2 | 3, PolarViewLevelFilter>,
  poiFilters: Record<1 | 2 | 3, PolarViewPoiLevelFilter>,
  lineFilters: Record<1 | 2 | 3, PolarViewLevelFilter>,
  areaFilters: Record<1 | 2 | 3, PolarViewLevelFilter>,
}

/**
 * 每个 level 的具体过滤参数
 */
interface PolarViewLevelFilter {
  includeDegreeThreshold: number, // 单个地物必定显著的视角，大于代表必定出现
  includeCountThreshold: number, // cluster 必定显著的数量，大于代表必定出现
  randomHideRate: number, // 不显著又不隐蔽的物体，则只有概率出现
  excludeDegreeThreshold: number, // 单个地物必定隐蔽的视角，小于代表必定消失
  excludeCountThreshold: number, // cluster 必定隐蔽的数量，小于代表必定消失
}
interface PolarViewPoiLevelFilter {
  includeCountThreshold: number,
  randomHideRate: number,
  excludeCountThreshold: number,
}

// 因高度而显眼的地物，可以无视 seeThroughSpans 强行出现
// 同时必定显著，不会被过滤掉
const SIGNIFICANT_POI_TAGS = new Set(['man_made:antenna', 'man_made:tower']);
const SIGNIFICANT_BUILDING_MIN_HEIGHT_METERS = 35;
const SIGNIFICANT_BUILDING_MIN_LEVELS = 10;

const nakedEyeFilter: PolarViewFilter = {
  id: "naked_eye",
  visibleSpan: {clockwiseEarlyDegree: 0, clockwiseLateDegree: 360, angleWidthDegrees: 360},
  buildingFilters: {
    1: {
      includeDegreeThreshold: 10, includeCountThreshold: 10,
      randomHideRate: 0.2,
      excludeDegreeThreshold: 5, excludeCountThreshold: 0,
    },
    2: {
      includeDegreeThreshold: 15, includeCountThreshold: 15,
      randomHideRate: 0.4,
      excludeDegreeThreshold: 10, excludeCountThreshold: 5,
    },
    3: {
      includeDegreeThreshold: 20, includeCountThreshold: 20,
      randomHideRate: 0.6,
      excludeDegreeThreshold: 15, excludeCountThreshold: 10,
    }
  },
  poiFilters: {
    1: {
      includeCountThreshold: 10,
      randomHideRate: 0.2,
      excludeCountThreshold: 0,
    },
    2: {
      includeCountThreshold: 50,
      randomHideRate: 0.4,
      excludeCountThreshold: 20,
    },
    3: {
      includeCountThreshold: 75,
      randomHideRate: 0.6,
      excludeCountThreshold: 50,
    }
  },
  lineFilters: {
    1: {
      includeDegreeThreshold: 15, includeCountThreshold: 10,
      randomHideRate: 0.4,
      excludeDegreeThreshold: 5, excludeCountThreshold: 0,
    },
    2: {
      includeDegreeThreshold: 30, includeCountThreshold: 15,
      randomHideRate: 0.6,
      excludeDegreeThreshold: 10, excludeCountThreshold: 5,
    },
    3: {
      includeDegreeThreshold: 45, includeCountThreshold: 20,
      randomHideRate: 0.8,
      excludeDegreeThreshold: 25, excludeCountThreshold: 10,
    }
  },
  areaFilters: {
    1: {
      includeDegreeThreshold: 15, includeCountThreshold: 10,
      randomHideRate: 0.5,
      excludeDegreeThreshold: 5, excludeCountThreshold: 0,
    },
    2: {
      includeDegreeThreshold: 30, includeCountThreshold: 15,
      randomHideRate: 0.7,
      excludeDegreeThreshold: 15, excludeCountThreshold: 5,
    },
    3: {
      includeDegreeThreshold: 45, includeCountThreshold: 20,
      randomHideRate: 0.9,
      excludeDegreeThreshold: 30, excludeCountThreshold: 10,
    }
  }
}

const POLAR_VIEW_FILTERS: Record<string, PolarViewFilter> = {
  [nakedEyeFilter.id]: nakedEyeFilter,
};

type PolarViewCluster = PolarView["levels"][number]["clusters"][number];
type MarkedPolarViewFeature = PolarViewCluster["features"][number];

//#region 主函数

/**
 * 通过直接移除的方式应用过滤
 * @param id 过滤方案的id
 * @param polarView
 * @returns 已经移除了内容的 Polar View
 */
export function applyVisualFilter(id: string = "naked_eye", polarView: PolarView): PolarView {
  const selectedFilter = POLAR_VIEW_FILTERS[id] || nakedEyeFilter;
  const keptFeatureIds = new Set<string>();
  const keptClusterMarkers = new Set<string>();
  const levelByMarker = new Map(polarView.levels.map((level) => [level.level, level]));
  const level1VisibleIntervals = buildVisibleIntervals(levelByMarker.get(1)?.clusters || []);
  const level2VisibleIntervals = buildVisibleIntervals(levelByMarker.get(2)?.clusters || []);

  // 1. 先构造一个完全空的 Polar View，进行转移式移除。
  const filteredPolarView: PolarView = {
    center: { ...polarView.center },
    maxRadiusMeters: polarView.maxRadiusMeters,
    levels: polarView.levels.map((level) => ({
      level: level.level,
      distanceRangeMeters: [...level.distanceRangeMeters] as [number, number],
      clusters: [],
    })),
  };

  const level1 = levelByMarker.get(1);
  const level2 = levelByMarker.get(2);
  const level3 = levelByMarker.get(3);

  if (level1) {
    applyLevelTransfers(
      level1.clusters,
      filteredPolarView.levels.find((entry) => entry.level === 1)?.clusters || [],
      keptFeatureIds,
      keptClusterMarkers,
      selectedFilter,
      () => true,
    );
  }

  if (level2) {
    applyLevelTransfers(
      level2.clusters,
      filteredPolarView.levels.find((entry) => entry.level === 2)?.clusters || [],
      keptFeatureIds,
      keptClusterMarkers,
      selectedFilter,
      (feature) => isFeatureVisibleInIntervals(feature, level1VisibleIntervals),
    );
  }

  if (level3) {
    applyLevelTransfers(
      level3.clusters,
      filteredPolarView.levels.find((entry) => entry.level === 3)?.clusters || [],
      keptFeatureIds,
      keptClusterMarkers,
      selectedFilter,
      (feature) =>
        isFeatureVisibleInIntervals(feature, level1VisibleIntervals) &&
        isFeatureVisibleInIntervals(feature, level2VisibleIntervals),
    );
  }

  return filteredPolarView
}

function applyLevelTransfers(
  sourceClusters: PolarViewCluster[],
  targetClusters: PolarViewCluster[],
  keptFeatureIds: Set<string>,
  keptClusterMarkers: Set<string>,
  filter: PolarViewFilter,
  isVisible: (feature: MarkedPolarViewFeature) => boolean,
): void {
  // 2. 先转移因高度而显著的所有地物。
  transferMatchingFeatures(sourceClusters, keptFeatureIds, keptClusterMarkers, targetClusters, (feature) =>
    isSignificantFeature(feature),
  );

  // 3. 再转移因视角宽度而显著的地物/地物簇。对于地物簇而言，其中任一地物达到了显著宽度则被转移。
  transferMatchingFeatures(sourceClusters, keptFeatureIds, keptClusterMarkers, targetClusters, (feature, cluster) =>
    cluster.features.length === 1 && isVisible(feature) && isFeatureIncludedByDegree(feature, filter)
  );
  transferMatchingClusters(sourceClusters, keptFeatureIds, keptClusterMarkers, targetClusters, (cluster) =>
    cluster.features.length > 1 &&
    cluster.features.some((feature) => isVisible(feature) && isFeatureIncludedByDegree(feature, filter))
  );

  // 4. 再转移因数量多而显著的地物簇。
  transferMatchingClusters(sourceClusters, keptFeatureIds, keptClusterMarkers, targetClusters, (cluster) =>
    cluster.features.length > 1 &&
    cluster.features.some((feature) => isVisible(feature)) &&
    isClusterIncludedByCount(cluster, filter)
  );

  // 5. 再按概率转移单个地物，单个地物看其视角宽度，达不到下限则放弃，否则概率转移。
  transferMatchingFeatures(sourceClusters, keptFeatureIds, keptClusterMarkers, targetClusters, (feature, cluster) =>
    cluster.features.length === 1 && isVisible(feature) && shouldKeepSingleFeatureByChance(feature, filter)
  );

  // 6. 最后按概率转移地物簇，不看其中最宽地物的宽度，只看这个簇的数量，达不到下限则放弃，否则概率转移。
  transferMatchingClusters(sourceClusters, keptFeatureIds, keptClusterMarkers, targetClusters, (cluster) =>
    cluster.features.length > 1 &&
    cluster.features.some((feature) => isVisible(feature)) &&
    shouldKeepClusterByChance(cluster, filter)
  );
}

//#region 转移函数

function transferMatchingFeatures(
  sourceClusters: PolarViewCluster[],
  keptFeatureIds: Set<string>,
  keptClusterMarkers: Set<string>,
  targetClusters: PolarViewCluster[],
  predicate: (feature: MarkedPolarViewFeature, cluster: PolarViewCluster) => boolean,
): void {
  for (const cluster of sourceClusters) {
    if (keptClusterMarkers.has(cluster.clusterMarker)) {
      continue;
    }

    for (const feature of cluster.features) {
      if (keptFeatureIds.has(feature.featureId) || !predicate(feature, cluster)) {
        continue;
      }

      targetClusters.push(buildFilteredCluster(cluster, [feature]));
      keptFeatureIds.add(feature.featureId);
    }
  }
}

function transferMatchingClusters(
  sourceClusters: PolarViewCluster[],
  keptFeatureIds: Set<string>,
  keptClusterMarkers: Set<string>,
  targetClusters: PolarViewCluster[],
  predicate: (cluster: PolarViewCluster) => boolean,
): void {
  for (const cluster of sourceClusters) {
    if (keptClusterMarkers.has(cluster.clusterMarker) || !predicate(cluster)) {
      continue;
    }

    targetClusters.push(buildFilteredCluster(cluster, cluster.features));
    keptClusterMarkers.add(cluster.clusterMarker);
    cluster.features.forEach((feature) => keptFeatureIds.add(feature.featureId));
  }
}

function buildFilteredCluster(
  cluster: PolarViewCluster,
  features: MarkedPolarViewFeature[],
): PolarViewCluster {
  return {
    ...cluster,
    memberCount: features.length,
    features: [...features],
  };
}

//#region 判断函数

function isSignificantFeature(feature: MarkedPolarViewFeature): boolean {
  if (feature.category === "building") {
    return isSignificantBuilding(feature.featureDetail.tags);
  }

  if (feature.category === "poi") {
    return isSignificantPoi(feature.featureDetail.tags);
  }

  return false;
}

function isSignificantBuilding(tags: Record<string, string>): boolean {
  const heightMeters = parseHeightMeters(tags.height);
  if (heightMeters !== null && heightMeters >= SIGNIFICANT_BUILDING_MIN_HEIGHT_METERS) {
    return true;
  }

  const levelValues = [parseIntegerTag(tags["building:levels"]), parseIntegerTag(tags.level)];
  return levelValues.some((value) => value !== null && value >= SIGNIFICANT_BUILDING_MIN_LEVELS);
}

function isSignificantPoi(tags: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(tags)) {
    if (SIGNIFICANT_POI_TAGS.has(`${key}:${value}`)) {
      return true;
    }
  }

  return false;
}

function isFeatureIncludedByDegree(feature: MarkedPolarViewFeature, filter: PolarViewFilter): boolean {
  if (feature.category === "poi") {
    return false;
  }

  const levelFilter = getLevelFilter(feature, filter);
  return feature.widestSpan.angleWidthDegrees >= levelFilter.includeDegreeThreshold;
}

function isClusterIncludedByCount(cluster: PolarViewCluster, filter: PolarViewFilter): boolean {
  const firstFeature = cluster.features[0];
  if (!firstFeature) {
    return false;
  }

  if (firstFeature.category === "poi") {
    const levelFilter = filter.poiFilters[firstFeature.levelMarker];
    return cluster.memberCount >= levelFilter.includeCountThreshold;
  }

  const levelFilter = getLevelFilter(firstFeature, filter);
  return cluster.memberCount >= levelFilter.includeCountThreshold;
}

function shouldKeepSingleFeatureByChance(feature: MarkedPolarViewFeature, filter: PolarViewFilter): boolean {
  if (feature.category === "poi") {
    return false;
  }

  const levelFilter = getLevelFilter(feature, filter);
  if (feature.widestSpan.angleWidthDegrees < levelFilter.excludeDegreeThreshold) {
    return false;
  }

  return Math.random() >= levelFilter.randomHideRate;
}

function shouldKeepClusterByChance(cluster: PolarViewCluster, filter: PolarViewFilter): boolean {
  const firstFeature = cluster.features[0];
  if (!firstFeature) {
    return false;
  }

  if (firstFeature.category === "poi") {
    const levelFilter = filter.poiFilters[firstFeature.levelMarker];
    if (cluster.memberCount <= levelFilter.excludeCountThreshold) {
      return false;
    }
    return Math.random() >= levelFilter.randomHideRate;
  }

  const levelFilter = getLevelFilter(firstFeature, filter);
  if (cluster.memberCount <= levelFilter.excludeCountThreshold) {
    return false;
  }

  return Math.random() >= levelFilter.randomHideRate;
}

//#region 帮助函数

function isFeatureVisibleInIntervals(
  feature: MarkedPolarViewFeature,
  visibleIntervals: DegreeInterval[],
): boolean {
  if (visibleIntervals.length === 0) {
    return false;
  }

  const featureIntervals = expandAngularSpan(feature.widestSpan);
  return featureIntervals.some((featureInterval) =>
    visibleIntervals.some((visibleInterval) => intervalsOverlap(featureInterval, visibleInterval))
  );
}

function buildVisibleIntervals(clusters: PolarViewCluster[]): DegreeInterval[] {
  const occlusionIntervals = mergeIntervals(
    clusters.flatMap((cluster) => cluster.features.flatMap((feature) => expandAngularSpan(feature.widestSpan))),
  );

  if (occlusionIntervals.length === 0) {
    return [{ startDegree: 0, endDegree: 360 }];
  }

  const visibleIntervals: DegreeInterval[] = [];
  let currentDegree = 0;

  for (const interval of occlusionIntervals) {
    if (interval.startDegree > currentDegree) {
      visibleIntervals.push({ startDegree: currentDegree, endDegree: interval.startDegree });
    }
    currentDegree = Math.max(currentDegree, interval.endDegree);
  }

  if (currentDegree < 360) {
    visibleIntervals.push({ startDegree: currentDegree, endDegree: 360 });
  }

  return visibleIntervals;
}

function expandAngularSpan(
  span: AngularSpan | MarkedPolarViewFeature["widestSpan"],
): DegreeInterval[] {
  const normalizedSpan = toAngularSpan(span);
  if (normalizedSpan.angleWidthDegrees <= 0) {
    return [];
  }

  if (normalizedSpan.angleWidthDegrees >= 360) {
    return [{ startDegree: 0, endDegree: 360 }];
  }

  const startDegree = normalizeBearingDegrees(normalizedSpan.clockwiseEarlyDegree);
  const endDegree = startDegree + normalizedSpan.angleWidthDegrees;
  if (endDegree <= 360) {
    return [{ startDegree, endDegree }];
  }

  return [
    { startDegree, endDegree: 360 },
    { startDegree: 0, endDegree: endDegree - 360 },
  ];
}

function mergeIntervals(intervals: DegreeInterval[]): DegreeInterval[] {
  if (intervals.length === 0) {
    return [];
  }

  const sortedIntervals = [...intervals].sort(
    (left, right) => left.startDegree - right.startDegree || left.endDegree - right.endDegree,
  );
  const mergedIntervals: DegreeInterval[] = [{ ...sortedIntervals[0]! }];

  for (let index = 1; index < sortedIntervals.length; index += 1) {
    const interval = sortedIntervals[index]!;
    const previousInterval = mergedIntervals[mergedIntervals.length - 1]!;
    if (interval.startDegree <= previousInterval.endDegree) {
      previousInterval.endDegree = Math.max(previousInterval.endDegree, interval.endDegree);
      continue;
    }
    mergedIntervals.push({ ...interval });
  }

  return mergedIntervals;
}

function intervalsOverlap(left: DegreeInterval, right: DegreeInterval): boolean {
  return left.startDegree < right.endDegree && right.startDegree < left.endDegree;
}

function toAngularSpan(
  span: AngularSpan | MarkedPolarViewFeature["widestSpan"],
): AngularSpan {
  if ("clockwiseEarlyDegree" in span) {
    return span;
  }

  return {
    clockwiseEarlyDegree: span.clockwiseEarlyPoint.bearingDegrees,
    clockwiseLateDegree: span.clockwiseLatePoint.bearingDegrees,
    angleWidthDegrees: span.angleWidthDegrees,
  };
}

function getLevelFilter(
  feature: MarkedPolarViewFeature,
  filter: PolarViewFilter,
): PolarViewLevelFilter {
  switch (feature.category) {
    case "building":
      return filter.buildingFilters[feature.levelMarker];
    case "line":
      return filter.lineFilters[feature.levelMarker];
    case "area":
      return filter.areaFilters[feature.levelMarker];
    case "poi":
      throw new Error("POI does not use degree-based filters");
  }
}

function parseHeightMeters(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.toLowerCase().replace(/,/g, "");
  const parsed = Number.parseFloat(normalized);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  if (normalized.includes("ft") || normalized.includes("feet")) {
    return parsed * 0.3048;
  }

  return parsed;
}

function parseIntegerTag(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
