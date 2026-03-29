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
import { isSignificantPoi, LeveledPolarView } from "./polarViewOcclusion.js";

const UNVISITED_CLUSTER_MARKER = "PLACE_HOLDER";

export interface MarkedPolarViewFeature extends PolarViewFeature {
  baseLabel: string;
  levelMarker: 1 | 2 | 3;
  clusterMarker: string;
}

export interface MarkedPolarView {
  center: {
    lat: number;
    lon: number;
  };
  maxRadiusMeters: number;
  levels: MarkedPolarViewLevel[];
}

/**
 * 已经把 level 3a 与 3b 合并为 level 3
 */
interface MarkedPolarViewLevel {
  level: 1 | 2 | 3;
  distanceRangeMeters: [number, number];
  features: MarkedPolarViewFeature[]
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

const DIRECTION_CLUSTER_THRESHOLD_DEGREES: Record<1 | 2 | 3, number> = {
  1: 5,
  2: 5,
  3: 5,
};
const DIRECTION_CLUSTER_THRESHOLD_COUNT: Record<1 | 2 | 3, number> = {
  1: 4,
  2: 3,
  3: 2,
};

/**
 * 根据分好 level 打好 label，然后打上聚类 marker
 * @param leveledPolarView 已分好级的 Polar View
 * @return 已经 label 好且 level 3 合并好的聚类标记好的 Polar View
 */
export function applyClusterMarkder(
  leveledPolarView: LeveledPolarView,
): MarkedPolarView {
  const level1Features = leveledPolarView.levels[0].features
  const level2Features = leveledPolarView.levels[1].features
  const level3aFeatures = leveledPolarView.levels[2].features
  const level3bFeatures = leveledPolarView.levels[3].features
  const level3Features = [...level3aFeatures, ...level3bFeatures]

  const labeledLevel1 = attachLabelBasedOnLevel(1, level1Features)
  const labeledLevel2 = attachLabelBasedOnLevel(2, level2Features)
  const labeledLevel3 = attachLabelBasedOnLevel(3, level3Features)

  const clusteredLevel1 = applyClusterMarkderOnLevel(1, labeledLevel1)
  const clusteredLevel2 = applyClusterMarkderOnLevel(2, labeledLevel2)
  const clusteredLevel3 = applyClusterMarkderOnLevel(3, labeledLevel3)

  return {
    ...leveledPolarView,
    levels: [
      { ...leveledPolarView.levels[0], features: clusteredLevel1 },
      { ...leveledPolarView.levels[1], features: clusteredLevel2 },
      {
        ...leveledPolarView.levels[2],
        distanceRangeMeters: [
          leveledPolarView.levels[2].distanceRangeMeters[0], // level 3a 内侧
          leveledPolarView.levels[3].distanceRangeMeters[1], // level 3b 外侧
        ],
        features: clusteredLevel3
      },
    ]
  }
}

/**
 * 对每一级 level 打上 base label（level 3 输入前应当已经把 3a 与 3b 合并
 * @param level
 * @param polarViewFeatures
 * @returns 打好标签，且已把 level 3 POI 全部去掉的单个地物列
 */
function attachLabelBasedOnLevel(
  level: 1|2|3,
  polarViewFeatures: PolarViewFeature[]
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
        switch (level) {
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
        // TODO: 做成自带一个 isSignificant 标签，自动过滤，不用再引用函数了
        // POI在 level 3 时不显示，level 2 透露基础标签，level 1 全名称
        // 除非是因高度显著的地物，此处特殊处理
        switch (level) {
          case 1:
            label = getPoiDisplayLabel(detail.tags)
            break
          case 2:
            label = getPoiPrimaryLabel(detail.tags)
            break
          case 3:
            label = isSignificantPoi(detail.tags) ? getPoiPrimaryLabel(detail.tags) :"NOT_DISPLAY"
            break
        }
        break
      case "area":
      case "line":
        // 线与区域在 level 2~3 时只有基础细节，level 1 全名称
        switch (level) {
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
    const labeledPolarViewFeature: MarkedPolarViewFeature = {
      ...polarViewFeature, baseLabel: label, levelMarker: level, clusterMarker: UNVISITED_CLUSTER_MARKER
    }
    // 若不展示，那么根本不会返回
    if(label !== "NOT_DISPLAY") labeled.push(labeledPolarViewFeature)
  }

  return labeled
}

/**
 * 根据 label 打上 cluster 标签的函数
 * @param polarViewFeature 已经打上 base label 的地物列
 */
function applyClusterMarkderOnLevel(
  level: 1|2|3,
  polarViewFeatures: MarkedPolarViewFeature[],
): MarkedPolarViewFeature[] {
  const groupedByLevelAndCategory = new Map<string, MarkedPolarViewFeature[]>();

  // 先根据 base label 分类
  for (const polarViewFeature of polarViewFeatures) {
    // key是 level + base label
    const groupKey = `L${level}:${polarViewFeature.baseLabel}`;
    const entries = groupedByLevelAndCategory.get(groupKey) || [];
    // 每个分组单独进行方向聚类，因此初始状态必须保留为“未访问”。
    entries.push({...polarViewFeature, clusterMarker: UNVISITED_CLUSTER_MARKER});
    groupedByLevelAndCategory.set(groupKey, entries);
  }

  let markedFeatures: MarkedPolarViewFeature[] = []

  // 在各个分类下进行聚类
  for (const entries of groupedByLevelAndCategory.values()) {
    const clusteredEntries = splitEntriesIntoDirectionClusters(
      level,
      entries,
      DIRECTION_CLUSTER_THRESHOLD_DEGREES[level],
      DIRECTION_CLUSTER_THRESHOLD_COUNT[level]
    );

    markedFeatures = [...markedFeatures, ...clusteredEntries]
  }

  return markedFeatures
}

/**
 * 组装最完整版 Polar View Object
 * @param request
 * @param clusterMarkedPolarView
 * @return 包含 level、label、聚类三种信息/结构的 Polar View Object
 */
export function buildPolarView(
  clusterMarkedPolarView: MarkedPolarView,
): PolarView {
  const level1 = clusterMarkedPolarView.levels[0]
  const level2 = clusterMarkedPolarView.levels[1]
  const level3 = clusterMarkedPolarView.levels[2]
  const level1Features = level1.features
  const level2Features = level2.features
  const level3Features = level3.features

  const levels = [
    buildClusterOnLevel(level1.level, level1.distanceRangeMeters, level1Features),
    buildClusterOnLevel(level2.level, level2.distanceRangeMeters, level2Features),
    buildClusterOnLevel(level3.level, level3.distanceRangeMeters, level3Features),
  ]

  return {
    ...clusterMarkedPolarView,
    levels,
  };
}

function buildClusterOnLevel(
  level: 1|2|3,
  distanceRangeMeters: [number, number],
  features: MarkedPolarViewFeature[]
): PolarViewLevel {
  const groupedByClusterMarker = new Map<string, MarkedPolarViewFeature[]>();
  // 先按 clusterMarker 分类好
  for (const polarViewFeature of features) {
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

  return {
    level,
    distanceRangeMeters,
    clusters,
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
  level: 1|2|3,
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
    if (currentEntry.clusterMarker !== UNVISITED_CLUSTER_MARKER) return

    const neighborFeatureIds = regionQuery(entries, currentEntry.featureId, degreesThreshold)
    // 如果邻居不足，先标记噪声
    if (neighborFeatureIds.length < clusterCntThreshold) {
      currentEntry.clusterMarker = currentEntry.featureId
      return;
    }

    // 创建新簇
    const clusterMarker = `L${level}:${currentEntry.baseLabel}:C${clusterId}`
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
      if (neighborFeature.clusterMarker === UNVISITED_CLUSTER_MARKER) {
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

