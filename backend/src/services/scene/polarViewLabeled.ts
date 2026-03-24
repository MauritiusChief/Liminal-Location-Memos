import { RangedPosition } from "@/routes/apiTypes.js";
import { PolarViewFeature } from "./polarViewObject.js";
import { computeCircularMeanDegrees } from "../geometry.js";
import {
  buildBuildingBaseLabel,
  getAreaDisplayLabel,
  getAreaPrimaryLabel,
  getFallbackBuildingLabel,
  getPoiDisplayLabel,
  getPoiPrimaryLabel,
  getRoadDisplayLabel,
  getRoadPrimaryLabel
} from "./sceneUtilLabel.js";

export interface MarkedPolarViewFeature extends PolarViewFeature {
  clusterMarker: string;
  levelMarker: 1 | 2 | 3;
  baseLabel: string;
}

export interface PolarViewCluster {
  clusterMarker: string;
  memberCount: number;
  centerBearingDegrees: number;
  features: MarkedPolarViewFeature[];
}

export interface PolarViewLevel {
  level: 1 | 2 | 3;
  distanceRangeMeters: [number, number];
  clusters: PolarViewCluster[];
}

/**
 * 最正宗的 Polar View Object：
 * 同时包含 level，cluster 与 label 三重信息/结构
 */
export interface PolarView {
  center: {
    lat: number;
    lon: number;
  };
  maxRadiusMeters: number;
  levels: PolarViewLevel[];
}

//#region 主函数

const POLAR_LEVELS: Array<{ level: 1 | 2 | 3; minExclusive: number; maxInclusive: number }> = [
  { level: 1, minExclusive: 30, maxInclusive: 100 },
  { level: 2, minExclusive: 100, maxInclusive: 300 },
  { level: 3, minExclusive: 300, maxInclusive: 1000 },
];
const DIRECTION_CLUSTER_THRESHOLD_DEGREES: Record<1 | 2 | 3, number> = {
  1: 5,
  2: 5,
  3: 5,
};
const DIRECTION_CLUSTER_THRESHOLD_COUNT: Record<1 | 2 | 3, number> = {
  1: 3,
  2: 4,
  3: 5,
};

/**
 * 先打上 level 标记
 * @param polarViewFeatures
 * @returns label 与 clusterMarker 都是占位符状态的 MarkedPolarViewFeature
 */
export function applyLevelMarker(polarViewFeatures: PolarViewFeature[]): MarkedPolarViewFeature[] {
  const levelMarked: MarkedPolarViewFeature[] = []

  for (const polarViewFeature of polarViewFeatures) {
    const distanceMeters = polarViewFeature.nearestPoint.distanceMeters
    const levelMarker = typeof distanceMeters === "number" ? classifyPolarLevel(distanceMeters) : null;

    if (!levelMarker) {
      continue;
    }
    const levelMarkedPolarViewFeature = {
      ...polarViewFeature,
      levelMarker,
      clusterMarker: "PLACE_HOLDER", // 先把 clusterMarker 空着，等会状态
      baseLabel: "PLACE_HOLDER"
    }
    levelMarked.push(levelMarkedPolarViewFeature)
  }

  return levelMarked
}

/**
 * 根据已经打上的 levelMarker，决定 label 的形式
 * @param polarViewFeatures 已经打上 level marker 的地物列
 */
export function attachLabelBasedOnLevel(
  polarViewFeatures: MarkedPolarViewFeature[],
): MarkedPolarViewFeature[] {
  const labeled: MarkedPolarViewFeature[] = []

  for (const polarViewFeature of polarViewFeatures) {
    const detail = polarViewFeature.featureDetail
    if (!detail) continue
    // 这里已初步应用不同类型地物在不同 level 的呈现机制
    // 但仅限于 Prompt 中的固定规则
    let label = ""
    switch (polarViewFeature.category) {
      case "building":
        // 建筑在 level 3 时只有基础细节，level 1~2 全名称
        switch (polarViewFeature.levelMarker) {
          case 1:
          case 2:
            label = buildBuildingBaseLabel(detail)
            break
          case 3:
            label = getFallbackBuildingLabel(detail.tags)
            break
        }
        break
      case "poi":
        // POI在 level 3 时不显示，level 2 透露基础标签，level 1 全名称
        switch (polarViewFeature.levelMarker) {
          case 1:
            label = getPoiDisplayLabel(detail.tags)
            break
          case 2:
            label = getPoiPrimaryLabel(detail.tags)
            break
          case 3:
            label = "NOT_DISPLAY"
            break
        }
        break
      case "area":
      case "line":
        // 线与区域在 level 2~3 时只有基础细节，level 1 全名称
        switch (polarViewFeature.levelMarker) {
          case 1:
            label = polarViewFeature.category === "line"
              ? getRoadDisplayLabel(detail.tags)
              : getAreaDisplayLabel(detail.tags)
            break
          case 2:
          case 3:
            label = polarViewFeature.category === "line"
              ? getRoadPrimaryLabel(detail.tags)
              : getAreaPrimaryLabel(detail.tags)
            break
        }
        break
    }
    polarViewFeature.baseLabel = label
    labeled.push(polarViewFeature)
  }

  return labeled
}

/**
 * 根据 label 打上 cluster 标签的函数
 * @param polarViewFeature 已经打上 base label 的地物列
 */
export function applyClusterMarkder(
  polarViewFeatures: MarkedPolarViewFeature[],
): MarkedPolarViewFeature[] {
  const groupedByLevelAndCategory = new Map<string, MarkedPolarViewFeature[]>();

  // 先根据 base label 分类
  for (const polarViewFeature of polarViewFeatures) {
    // key是 level + base label
    const groupKey = `L${polarViewFeature.levelMarker}:${polarViewFeature.baseLabel}`;
    const entries = groupedByLevelAndCategory.get(groupKey) || [];
    entries.push(polarViewFeature);
    groupedByLevelAndCategory.set(groupKey, entries);
  }

  let markedFeatures: MarkedPolarViewFeature[] = []

  // 在各个分类下进行聚类
  for (const entries of groupedByLevelAndCategory.values()) {
    const levelMarker = entries[0].levelMarker // 可以保证 levelMarker 全都一致，所以直接 [0] 就行

    const clusteredEntries = splitEntriesIntoDirectionClusters(
      entries,
      DIRECTION_CLUSTER_THRESHOLD_DEGREES[levelMarker],
      DIRECTION_CLUSTER_THRESHOLD_COUNT[levelMarker]
    );

    markedFeatures = [...markedFeatures, ...clusteredEntries]
  }

  return markedFeatures
}

/**
 * 组装最完整版 Polar View Object
 * @param request
 * @param polarViewFeatures
 */
export function buildPolarView(
  request: RangedPosition,
  polarViewFeatures: MarkedPolarViewFeature[],
): PolarView {
  const levels = POLAR_LEVELS.map<PolarViewLevel>((definition) => {
    // 以 cluster marker 分组
    const groupedByClusterMarker = new Map<string, MarkedPolarViewFeature[]>();

    for (const polarViewFeature of polarViewFeatures) {
      if (polarViewFeature.levelMarker !== definition.level) {
        continue;
      }

      const entries = groupedByClusterMarker.get(polarViewFeature.clusterMarker) || [];
      entries.push(polarViewFeature);
      groupedByClusterMarker.set(polarViewFeature.clusterMarker, entries);
    }

    // 组装 Polar View Object 所需的 clusters
    const clusters = Array.from(groupedByClusterMarker.entries())
      .map<PolarViewCluster>(([clusterMarker, entries]) => ({
        clusterMarker,
        memberCount: entries.length,
        centerBearingDegrees: computeCircularMeanDegrees(
          entries.map((entry) => entry.centerPoint.bearingDegrees),
        ),
        features: [...entries].sort(
          (left, right) => left.centerPoint.distanceMeters - right.centerPoint.distanceMeters || left.osmId - right.osmId,
        ),
      }))
      .sort(
        (left, right) =>
          left.centerBearingDegrees - right.centerBearingDegrees ||
          left.features[0]!.centerPoint.distanceMeters - right.features[0]!.centerPoint.distanceMeters,
      );

    // 返回某一 level 组装好的结果（包含 clusters）
    return {
      level: definition.level,
      distanceRangeMeters: [definition.minExclusive, definition.maxInclusive],
      clusters,
    };
  });

  return {
    center: {
      lat: request.lat,
      lon: request.lon,
    },
    maxRadiusMeters: request.radius,
    levels,
  };
}

//#region DBSCAN 聚类

/**
 * 用简易版 DBSCAN 打上 cluster 标签
 * @param entries
 * @param degreesThreshold
 * @param clusterCntThrehold
 * @returns 打好标签的 entries
 */
function splitEntriesIntoDirectionClusters(
  entries: MarkedPolarViewFeature[],
  degreesThreshold: number,
  clusterCntThreshold: number,
): MarkedPolarViewFeature[] {
  if (entries.length === 0) {
    return entries;
  }

  if (entries.length === 1) {
    // 单点直接视为独立项，避免 clusterMarker 保留为占位符
    entries[0]!.clusterMarker = entries[0]!.featureId
    return entries;
  }

  const sortedEntries = [...entries].sort(
    (left, right) => left.centerPoint.bearingDegrees - right.centerPoint.bearingDegrees,
  );
  const featureById = new Map(entries.map((entry) => [entry.featureId, entry]));
  let clusterId = 0

  sortedEntries.forEach(currentEntry => {
    // 已访问就跳过
    if (currentEntry.clusterMarker !== "PLACE_HOLDER") return

    const neighborFeatureIds = regionQuery(entries, currentEntry.featureId, degreesThreshold)
    // 如果邻居不足，先标记噪声
    if (neighborFeatureIds.length < clusterCntThreshold) {
      currentEntry.clusterMarker = currentEntry.featureId
      return;
    }

    // 创建新簇
    const clusterMarker = `L${currentEntry.levelMarker}:${currentEntry.baseLabel}:C${clusterId}`
    currentEntry.clusterMarker = clusterMarker
    const seedSet = [...neighborFeatureIds];

    for (let j = 0; j < seedSet.length; j++) {
      const featureId = seedSet[j];
      const neighborFeature = featureById.get(featureId)
      if (!neighborFeature) continue
      // 如果之前是噪声，现在可归入当前簇
      if (neighborFeature.clusterMarker === neighborFeature.featureId) {
        neighborFeature.clusterMarker = clusterMarker
      }

      // 如果尚未访问，加入当前簇
      if (neighborFeature.clusterMarker === "PLACE_HOLDER") {
        neighborFeature.clusterMarker = clusterMarker

        const neighborFeatureIds = regionQuery(entries, neighborFeature.featureId, degreesThreshold)

        // 若它也是核心点，则继续扩展
        if (neighborFeatureIds.length >= clusterCntThreshold) {
          for (const n of neighborFeatureIds) {
            if (!seedSet.includes(n)) {
              seedSet.push(n);
            }
          }
        }
      }
    }

    clusterId++;

  })

  return entries;
}

/**
 * 找到 featureId 所指向的 feature 的邻居内所有点的 featureId
 * @param entries
 * @param featureId
 * @param degreesThreshold
 * @returns
 */
function regionQuery(
  entries: MarkedPolarViewFeature[],
  featureId: string,
  degreesThreshold: number,
): string[] {
  const feature =  entries.find( e => e.featureId === featureId)
  if (!feature) return []
  return entries.filter(e => {
    return (
      Math.abs(e.centerPoint.bearingDegrees - feature.centerPoint.bearingDegrees) < degreesThreshold ||
      Math.abs(e.centerPoint.bearingDegrees - 360 - feature.centerPoint.bearingDegrees) < degreesThreshold ||
      Math.abs(e.centerPoint.bearingDegrees + 360 - feature.centerPoint.bearingDegrees) < degreesThreshold
    )
  }).map(e => e.featureId)
}

//#region 帮助函数

function classifyPolarLevel(distanceMeters: number): 1 | 2 | 3 | null {
  const matchedLevel = POLAR_LEVELS.find(
    (definition) => distanceMeters > definition.minExclusive && distanceMeters <= definition.maxInclusive,
  );
  return matchedLevel ? matchedLevel.level : null;
}
