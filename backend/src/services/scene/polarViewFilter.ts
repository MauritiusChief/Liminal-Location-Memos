import { normalizeBearingDegrees } from "../geometry.js";
import { PolarView } from "./polarViewLabeled.js";
import { isSignificantBuilding, isSignificantPoi } from "./polarViewOcclusion.js";

interface AngularSpan {
  clockwiseEarlyDegree: number;
  clockwiseLateDegree: number;
  angleWidthDegrees: number;
}

/**
 * 按名称命名的过滤参数
 * TODO：未来可能还会添加只能看某一段局限视界里的内容
 */
interface PolarViewFilter {
  id: string,
  visibleSpan?: AngularSpan, // TODO 可视的范围
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
      includeCountThreshold: 5,
      randomHideRate: 0.2,
      excludeCountThreshold: 0,
    },
    2: {
      includeCountThreshold: 10,
      randomHideRate: 0.4,
      excludeCountThreshold: 5,
    },
    3: {
      includeCountThreshold: 15,
      randomHideRate: 0.6,
      excludeCountThreshold: 10,
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
interface TransferState {
  keptFeatureIds: Set<string>;
  keptClusterMarkers: Set<string>;
}

//#region 主函数

/**
 * 通过直接移除的方式应用过滤
 * @param id 过滤方案的id
 * @param polarView
 * @returns 已经移除了内容的 Polar View
 */
export function applyVisualFilter(id: string = "naked_eye", polarView: PolarView): PolarView {
  const selectedFilter = POLAR_VIEW_FILTERS[id] || nakedEyeFilter;
  const levelByMarker = new Map(polarView.levels.map((level) => [level.level, level]));
  // console.log('level2VisibleIntervals',level2VisibleIntervals);
  let transferState: TransferState = {
    keptFeatureIds: new Set<string>(),
    keptClusterMarkers: new Set<string>(),
  };

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
    transferState = applyLevelTransfers(
      level1.clusters,
      filteredPolarView.levels.find((entry) => entry.level === 1)?.clusters || [],
      transferState,
      selectedFilter,
    );
  }

  if (level2) {
    transferState = applyLevelTransfers(
      level2.clusters,
      filteredPolarView.levels.find((entry) => entry.level === 2)?.clusters || [],
      transferState,
      selectedFilter,
    );
  }

  if (level3) {
    transferState = applyLevelTransfers(
      level3.clusters,
      filteredPolarView.levels.find((entry) => entry.level === 3)?.clusters || [],
      transferState,
      selectedFilter,
    );
  }

  return filteredPolarView
}

/**
 * 对单个 level 执行完整的转移过滤流程。
 * @param sourceClusters 该 level 原始 clusters
 * @param targetClusters 该 level 输出 clusters
 * @param transferState 进入本轮前已经保留的 feature/cluster 状态
 * @param filter 当前使用的 filter 配置
 * @param visibleIntervalsByLayer 按层排列的可见区间列表；空数组代表不做遮挡判定
 * @returns 更新后的保留状态
 */
function applyLevelTransfers(
  sourceClusters: PolarViewCluster[],
  targetClusters: PolarViewCluster[],
  transferState: TransferState,
  filter: PolarViewFilter,
): TransferState {

  // 2. 先转移因高度而显著的所有地物。
  let nextState = transferMatchingFeatures(sourceClusters, transferState, targetClusters, (f) =>
    isSignificantBuilding(f.featureDetail.tags) || isSignificantPoi(f.featureDetail.tags),
  );

  // 3. 再转移因视角宽度而显著的地物/地物簇。对于地物簇而言，其中任一地物达到了显著宽度则被转移。
  nextState = transferMatchingFeatures(sourceClusters, nextState, targetClusters, (feature, cluster) =>
    cluster.features.length === 1 && isFeatureIncludedByDegree(feature, filter)
  );
  nextState = transferMatchingClusters(sourceClusters, nextState, targetClusters, (cluster) =>
    cluster.features.length > 1 &&
    cluster.features.some((feature) => isFeatureIncludedByDegree(feature, filter))
  );

  // 4. 再转移因数量多而显著的地物簇。
  nextState = transferMatchingClusters(sourceClusters, nextState, targetClusters, (cluster) =>
    cluster.features.length > 1 && isClusterIncludedByCount(cluster, filter)
  );

  // 5. 再按概率转移单个地物，单个地物看其视角宽度，达不到下限则放弃，否则概率转移。
  nextState = transferMatchingFeatures(sourceClusters, nextState, targetClusters, (feature, cluster) =>
    cluster.features.length === 1 && shouldKeepSingleFeatureByChance(feature, filter)
  );

  // 6. 最后按概率转移地物簇，不看其中最宽地物的宽度，只看这个簇的数量，达不到下限则放弃，否则概率转移。
  return transferMatchingClusters(sourceClusters, nextState, targetClusters, (cluster) =>
    cluster.features.length > 1 && shouldKeepClusterByChance(cluster, filter)
  );
}

//#region 转移函数

/**
 * 按 feature 粒度转移匹配项，并返回更新后的保留状态。
 * @param sourceClusters 候选来源 clusters
 * @param transferState 当前已保留状态
 * @param targetClusters 输出 clusters
 * @param predicate 判断某个 feature 是否应该被转移
 * @returns 更新后的保留状态
 */
function transferMatchingFeatures(
  sourceClusters: PolarViewCluster[],
  transferState: TransferState,
  targetClusters: PolarViewCluster[],
  predicate: (feature: MarkedPolarViewFeature, cluster: PolarViewCluster) => boolean,
): TransferState {
  const nextState: TransferState = {
    keptFeatureIds: new Set(transferState.keptFeatureIds),
    keptClusterMarkers: new Set(transferState.keptClusterMarkers),
  };

  for (const cluster of sourceClusters) {
    if (nextState.keptClusterMarkers.has(cluster.clusterMarker)) {
      continue;
    }

    for (const feature of cluster.features) {
      if (nextState.keptFeatureIds.has(feature.featureId) || !predicate(feature, cluster)) {
        continue;
      }

      targetClusters.push(buildFilteredCluster(cluster, [feature]));
      nextState.keptFeatureIds.add(feature.featureId);
    }
  }

  return nextState;
}

/**
 * 按 cluster 粒度转移匹配项，并返回更新后的保留状态。
 * @param sourceClusters 候选来源 clusters
 * @param transferState 当前已保留状态
 * @param targetClusters 输出 clusters
 * @param predicate 判断某个 cluster 是否应该被转移
 * @returns 更新后的保留状态
 */
function transferMatchingClusters(
  sourceClusters: PolarViewCluster[],
  transferState: TransferState,
  targetClusters: PolarViewCluster[],
  predicate: (cluster: PolarViewCluster) => boolean,
): TransferState {
  const nextState: TransferState = {
    keptFeatureIds: new Set(transferState.keptFeatureIds),
    keptClusterMarkers: new Set(transferState.keptClusterMarkers),
  };

  for (const cluster of sourceClusters) {
    if (nextState.keptClusterMarkers.has(cluster.clusterMarker) || !predicate(cluster)) {
      continue;
    }

    targetClusters.push(buildFilteredCluster(cluster, cluster.features));
    nextState.keptClusterMarkers.add(cluster.clusterMarker);
    cluster.features.forEach((feature) => nextState.keptFeatureIds.add(feature.featureId));
  }

  return nextState;
}

/**
 * 基于原 cluster 构造转移后的 cluster 副本。
 * @param cluster 原始 cluster
 * @param features 需要保留的 features
 * @returns 只包含保留 features 的新 cluster
 */
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

/**
 * 判断单个非 POI 地物是否因视角宽度达到必定显著阈值。
 * @param feature 待判断地物
 * @param filter 当前过滤配置
 * @returns 是否应按角宽直接保留
 */
function isFeatureIncludedByDegree(feature: MarkedPolarViewFeature, filter: PolarViewFilter): boolean {
  if (feature.category === "poi") {
    return false;
  }

  const levelFilter = getLevelFilter(feature, filter);
  return feature.widestSpan.angleWidthDegrees >= levelFilter.includeDegreeThreshold;
}

/**
 * 判断 cluster 是否因数量达到必定显著阈值。
 * @param cluster 待判断 cluster
 * @param filter 当前过滤配置
 * @returns 是否应按数量直接保留
 */
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

/**
 * 判断单个地物是否应按概率保留。
 * @param feature 待判断地物
 * @param filter 当前过滤配置
 * @returns 是否通过概率筛选
 */
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

/**
 * 判断 cluster 是否应按概率保留。
 * @param cluster 待判断 cluster
 * @param filter 当前过滤配置
 * @returns 是否通过概率筛选
 */
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

/**
 * 将两种 span 结构统一转换为本文件使用的 AngularSpan。
 * @param span 输入 span
 * @returns 标准化后的 AngularSpan
 */
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

/**
 * 根据地物类别和 level 选取对应的 degree 过滤配置。
 * @param feature 待判断地物
 * @param filter 当前过滤配置
 * @returns 对应 level 的过滤参数
 */
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

/**
 * 解析 OSM height 标签并转换为米。
 * @param value 原始 height 标签值
 * @returns 米数；无法解析时返回 null
 */
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

/**
 * 解析整数字段标签。
 * @param value 原始标签值
 * @returns 解析后的整数；无法解析时返回 null
 */
function parseIntegerTag(value: string | undefined): number | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}
