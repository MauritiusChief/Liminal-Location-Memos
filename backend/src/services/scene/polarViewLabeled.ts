import { RangedPosition } from "@/routes/apiTypes.js";
import { PolarViewFeature } from "./polarViewObject.js";
import { computeCircularMeanDegrees } from "../geometry.js";

export interface MarkedPolarViewFeature extends PolarViewFeature {
  clusterMarker: string;
  levelMarker: 1 | 2 | 3;
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
 * 最正宗的 Polar View Object
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
  2: 10,
  3: 15,
};
const DIRECTION_CLUSTER_THRESHOLD_COUNT: Record<1 | 2 | 3, number> = {
  1: 3,
  2: 4,
  3: 5,
};

/**
 * 同时打上 level 标签与 cluster 标签的函数
 * @param polarViewFeature
 */
export function applyPolarViewFeatureMarkder(
  polarViewFeatures: PolarViewFeature[],
): MarkedPolarViewFeature[] {
  const groupedByLevelAndCategory = new Map<string, MarkedPolarViewFeature[]>();

  // 打 level 标签
  for (const polarViewFeature of polarViewFeatures) {
    const distanceMeters = polarViewFeature.nearestPoint.distanceMeters
    const levelMarker = typeof distanceMeters === "number" ? classifyPolarLevel(distanceMeters) : null;

    if (!levelMarker) {
      continue;
    }
    const levelMarkedPolarViewFeature = {
      ...polarViewFeature,
      levelMarker, clusterMarker: "PLACE_HOLDER" // 先把 clusterMarker 空着，等会状态
    }

    // key是 level + 种类，因为不同 level、不同种类的地物是肯定不可能聚类到一起的
    const groupKey = `L${levelMarker}:${polarViewFeature.category}`;
    const entries = groupedByLevelAndCategory.get(groupKey) || [];
    entries.push(levelMarkedPolarViewFeature);
    groupedByLevelAndCategory.set(groupKey, entries);
  }

  let markedFeatures: MarkedPolarViewFeature[] = []

  // 从打好 level 标签的 map 当中
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
  clusterCntThrehold: number,
): MarkedPolarViewFeature[] {
  if (entries.length <= 1) {
    return entries;
  }

  const sortedEntries = [...entries].sort(
    (left, right) => left.centerPoint.bearingDegrees - right.centerPoint.bearingDegrees,
  );
  let clusterId = 0
  const clusteredPolarViewFeatures: MarkedPolarViewFeature[] = [];

  sortedEntries.forEach( currentEntry => {
    // 已访问就跳过
    if (currentEntry.clusterMarker !== "PLACE_HOLDER") return

    const neighborFeatureIds = regionQuery(entries, currentEntry.featureId, degreesThreshold)
    // 如果邻居不足，先标记噪声
    if (neighborFeatureIds.length < clusterCntThrehold) {
      currentEntry.clusterMarker = currentEntry.featureId
      clusteredPolarViewFeatures.push(currentEntry)
      return;
    }

    // 创建新簇
    currentEntry.clusterMarker = `L${currentEntry.levelMarker}:${currentEntry.category}:C${clusterId}`
    const seedSet = [...neighborFeatureIds];

    for (let j = 0; j < seedSet.length; j++) {
      const featureId = seedSet[j];
      const neighborFeature = clusteredPolarViewFeatures.find( f => f.featureId === featureId)
      if (!neighborFeature) return
      // 如果之前是噪声，现在可归入当前簇
      if(neighborFeature.clusterMarker === neighborFeature?.featureId) {
        neighborFeature.clusterMarker = `L${currentEntry.levelMarker}:${currentEntry.category}:C${clusterId}`
      }

      // 如果尚未访问，加入当前簇
      if (neighborFeature.clusterMarker === "PLACE_HOLDER") {
        neighborFeature.clusterMarker = `L${currentEntry.levelMarker}:${currentEntry.category}:C${clusterId}`

        const neighborFeatureIds = regionQuery(entries, neighborFeature.featureId, degreesThreshold)

        // 若它也是核心点，则继续扩展
        if (neighborFeatureIds.length >= clusterCntThrehold) {
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

  return clusteredPolarViewFeatures;
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
