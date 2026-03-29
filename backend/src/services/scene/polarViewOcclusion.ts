import { RangedPosition } from "@/routes/apiTypes.js";
import { PolarViewFeature } from "./polarViewObject.js";
import { normalizeBearingDegrees } from "../geometry.js";

/**
 * 分为 level 1、2、3a、3b；
 * 分别为 30m-100m, 100-300m, 300m-500m, 500-1km；
 * 其中 level 1为全员可见，其他层级都要接受前一层级制作的可视范围过滤。
 * level 2 - 3a 只要有一点可见便视为可见，level 3b 只有全部可见才视为可见
 */
interface PolarViewLevel {
  level: 1 | 2 | 3;
  layer?: 'a'|'b';
  distanceRangeMeters: [number, number];
  features: PolarViewFeature[]
}

interface LeveledPolarView {
  center: {
    lat: number;
    lon: number;
  };
  maxRadiusMeters: number;
  levels: PolarViewLevel[];
}

interface AngularSpan {
  clockwiseEarlyDegree: number;
  clockwiseLateDegree: number;
  angleWidthDegrees: number;
}

interface DegreeInterval {
  startDegree: number;
  endDegree: number;
}

const POLAR_LEVELS: { level: 1 | 2 | 3; minExclusive: number; maxInclusive: number }[] = [
  { level: 1, minExclusive: 30, maxInclusive: 100 },
  { level: 2, minExclusive: 100, maxInclusive: 300 },
  { level: 3, minExclusive: 300, maxInclusive: 1000 },
];
/**
 * 专门用于剔除视野遮挡的层定义，区别在于把 level 3 额外分了两层
 */
const OCCLUSION_LEVEL_LAYERS: { layer: 'a'|'b'; minExclusive: number; maxInclusive: number }[] = [
  { layer: 'a', minExclusive: 300, maxInclusive: 500 },
  { layer: 'b', minExclusive: 500, maxInclusive: 1000 },
]

// 因高度而显眼的地物
// 同时必定显著，不会被过滤掉
const SIGNIFICANT_POI_TAGS = new Set(['man_made:antenna', 'man_made:tower']);
const SIGNIFICANT_BUILDING_MIN_HEIGHT_METERS = 35;
const SIGNIFICANT_BUILDING_MIN_LEVELS = 10;

//#region 主函数

/**
 * 把扁平的 Polar View Feature 列分为 level 1 - 3 三级，以及 leve 3 内部的 a、b 两层
 * @param request
 * @param polarViewFeatures
 * @returns 分级与分层好的结果
 */
export function buildLeveledPolarView(request: RangedPosition, polarViewFeatures: PolarViewFeature[]): LeveledPolarView {
  const {lat, lon, radius} = request
  // 构建空的 LeveledPolarView 以盛放结果
  const leveled: LeveledPolarView = {
    center: {lat, lon}, maxRadiusMeters: radius,
    levels: []
  }
  for (const polarLevel of POLAR_LEVELS) {
    const {level, minExclusive, maxInclusive} = polarLevel
    if (level === 3) continue // 跳过 level 3
    leveled.levels.push({
      level,
      distanceRangeMeters:[minExclusive, maxInclusive],
      features: []
    })
  }
  for (const occlusionLayer of OCCLUSION_LEVEL_LAYERS) {
    const {layer, minExclusive, maxInclusive} = occlusionLayer
    leveled.levels.push({ // level 3 在这里被拆成两层 layer
      level: 3,
      layer,
      distanceRangeMeters:[minExclusive, maxInclusive],
      features: []
    })
  }

  // 将 PolarViewFeature 放入 LeveledPolarView
  for (const polarViewFeature of polarViewFeatures) {
    const distanceMeters = polarViewFeature.nearestPoint.distanceMeters
    const levelMarker = typeof distanceMeters === "number" ? classifyPolarLevel(distanceMeters) : null;
    const layerMarker = typeof distanceMeters === "number" ? classifyPolarLevelLayer(distanceMeters) : null;

    if (!levelMarker) continue

    // 找到对应的 level
    const levelToAssert = leveled.levels.find(l => levelMarker !== 3 && l.level === levelMarker)
    if (levelToAssert) {
      // 装填 level 1 与 level 2
      levelToAssert.features.push(polarViewFeature)
      continue
    }

    // 对 level 3，找到对应的 layer
    const levelLayerToAssert = leveled.levels.find(l => l.level === 3 && l.layer === layerMarker);
    if (!levelLayerToAssert) continue
    // 装填 level 3 两个 layer
    levelLayerToAssert.features.push(polarViewFeature)
  }

  return leveled
}

/**
 * 根据层叠规则，过滤被内层地物遮挡的地物，从内到外依次为 level 1, 2, 3a, 3b
 * 1. level 1 完全可见
 * 2. level 2, 3a 部分遮挡依然可见，完全遮挡不可见
 * 3. level 3b 部分遮挡则不可见
 * @param leveledPolarView
 * @returns
 */
export function buildOccludedPolarView(leveledPolarView: LeveledPolarView): LeveledPolarView {
  const level1Features = leveledPolarView.levels[0].features
  const level2Features = leveledPolarView.levels[1].features
  const level3aFeatures = leveledPolarView.levels[2].features
  const level3bFeatures = leveledPolarView.levels[3].features
  const level1VisibleIntervals = buildVisibleIntervals(level1Features)
  const level2VisibleIntervals = buildVisibleIntervals(level2Features)
  const level3aVisibleIntervals = buildVisibleIntervals(level3aFeatures)

  const occludedLevel2 = level2Features.filter( f => isFeatureVisibleInIntervals(f, level1VisibleIntervals))
  const occludedLevel3a = level3aFeatures.filter( f => {
    return isFeatureVisibleInIntervals(f, level1VisibleIntervals) &&
      isFeatureVisibleInIntervals(f, level2VisibleIntervals)
  })
  // level 3b 使用更严格的过滤
  const occludedLevel3b = level3bFeatures.filter( f => {
    return isFeatureFullyVisibleInIntervals(f, level1VisibleIntervals) &&
    isFeatureFullyVisibleInIntervals(f, level2VisibleIntervals) &&
    isFeatureFullyVisibleInIntervals(f, level3aVisibleIntervals)
  })

  return {
    ...leveledPolarView,
    levels: [
      { ...leveledPolarView.levels[0], features: level1Features },
      { ...leveledPolarView.levels[1], features: occludedLevel2 },
      { ...leveledPolarView.levels[2], features: occludedLevel3a },
      { ...leveledPolarView.levels[3], features: occludedLevel3b },
    ]
  }
}

//#region 判断函数

/**
 * 判断某个地物会不会阻挡视野。
 * TODO：添加特殊地形的遮挡，比如树林
 * @param feature
 */
function isOcclusion(feature: PolarViewFeature): boolean {
  return feature.category === "building"
}

/**
 * 判断某个地物是否穿过给定的可见角度区间。
 * @param feature 待判断地物
 * @param visibleIntervals 单层可见区间
 * @returns 只要任一角区间相交则为 true
 */
function isFeatureVisibleInIntervals(
  feature: PolarViewFeature,
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

/**
 * 判断某个地物是否完全处在给定的可见角度区间。
 * @param feature 待判断地物
 * @param visibleIntervals 单层可见区间
 * @returns 全部处于可见区间则为 true
 */
function isFeatureFullyVisibleInIntervals(
  feature: PolarViewFeature,
  visibleIntervals: DegreeInterval[],
): boolean {
  if (visibleIntervals.length === 0) {
    return false;
  }
  const featureIntervals = expandAngularSpan(feature.widestSpan);

  return featureIntervals.every((featureInterval) =>
    visibleIntervals.some((visibleInterval) => isFullyContained(featureInterval, visibleInterval)
    )
  );
}

//#region 帮助函数

/**
 * 基于一层内所有 building 的角跨度，计算补集形式的可见区间。
 * @param features 某一层的 features
 * @returns 该层未被 building 遮住的可见角度区间
 */
function buildVisibleIntervals(features: PolarViewFeature[]): DegreeInterval[] {

  const occlusionIntervals = mergeIntervals(
    features.flatMap((feature) =>
      isOcclusion(feature) ? expandAngularSpan(feature.widestSpan) : [],
    ),
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

/**
 * 将角跨度展开为一个或两个不跨 360 度的区间。
 * @param span 原始角跨度
 * @returns 规范化后的角度区间数组
 */
function expandAngularSpan(
  span: AngularSpan | PolarViewFeature["widestSpan"],
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

/**
 * 合并重叠或相邻的角度区间。
 * @param intervals 原始区间列表
 * @returns 合并后的区间列表
 */
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

/**
 * 判断两个角度区间是否有重叠。
 * @param left 左侧区间
 * @param right 右侧区间
 * @returns 是否重叠
 */
function intervalsOverlap(left: DegreeInterval, right: DegreeInterval): boolean {
  return left.startDegree < right.endDegree && right.startDegree < left.endDegree;
}

/**
 * 判断 inner 是否完全在 outer 范围内
 * @param inner
 * @param outer
 * @returns
 */
function isFullyContained(inner: DegreeInterval, outer: DegreeInterval): boolean {
  return inner.startDegree >= outer.startDegree && inner.endDegree <= outer.endDegree;
}

/**
 * 将两种 span 结构统一转换为本文件使用的 AngularSpan。
 * @param span 输入 span
 * @returns 标准化后的 AngularSpan
 */
function toAngularSpan(
  span: AngularSpan | PolarViewFeature["widestSpan"],
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

function classifyPolarLevel(distanceMeters: number): 1 | 2 | 3 | null {
  const matchedLevel = POLAR_LEVELS.find(
    (definition) => distanceMeters > definition.minExclusive && distanceMeters <= definition.maxInclusive,
  );
  return matchedLevel ? matchedLevel.level : null;
}

function classifyPolarLevelLayer(distanceMeters: number): 'a' | 'b' | null {
  const matchedLayer = OCCLUSION_LEVEL_LAYERS.find(
    (definition) => distanceMeters > definition.minExclusive && distanceMeters <= definition.maxInclusive,
  );
  return matchedLayer ? matchedLayer.layer : null;
}
