import { AREA_TAG_KEYS, BUILDING_TAG_KEYS, POI_TAG_KEYS, ROAD_TAG_KEYS } from "./sceneUtilLabel.js";
import { PolarView, PolarViewCluster, PolarViewLevel } from "./polarViewLabeled.js";
import { trimTagValue } from "../utils.js";
import { normalizeBearingDegrees } from "../geometry.js";
import { isSignificantPoi } from "./polarViewOcclusion.js";

type PolarFeatureCategory = "building" | "area" | "poi" | "line";
type MarkedPolarViewFeature = PolarViewCluster["features"][number];

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

const PROMPT_TAG_KEYS_BY_CATEGORY: Record<PolarFeatureCategory, readonly string[]> = {
  building: ["name", "brand", "building:levels", "height", ...BUILDING_TAG_KEYS, ...POI_TAG_KEYS],
  poi: ["name", "brand", ...POI_TAG_KEYS],
  line: ["name", ...ROAD_TAG_KEYS],
  area: ["name", ...AREA_TAG_KEYS],
};

/**
 * 将 Polar View 直接生成提示词，不再额外过滤
 * @param polarView 已经过滤好的 Polar View
 * @returns
 */
export function buildPolarViewPrompt(polarView: PolarView, playerOrientation: number = 0): string {
  const largestLevel = getLargestLevel(polarView);
  const levelsToRender = largestLevel
    ? polarView.levels.filter((level) => level.level <= largestLevel)
    : polarView.levels;
  const buildingAndPoiBlocks = levelsToRender.map((level) =>
    buildPolarLevelBlock(level, ["building", "poi"], playerOrientation),
  );
  const lineBlocks = levelsToRender.map((level) =>
    buildPolarLevelBlock(level, ["line"], playerOrientation),
  );
  const areaBlocks = levelsToRender.map((level) =>
    buildPolarLevelBlock(level, ["area"], playerOrientation),
  );

  let hintOfLevel = "## 极坐标摘要：无";
  switch (largestLevel) {
    case 1:
      hintOfLevel = "## 极坐标摘要";
      break;
    case 2:
      hintOfLevel = "## 等级1到等级2（30米到300米极坐标摘要）";
      break;
    case 3:
      hintOfLevel = "## 等级1到等级3（30米到1公里极坐标摘要）";
      break;
  }

  return [
    hintOfLevel,
    "",
    "### 显著部分：建筑与POI",
    ...buildingAndPoiBlocks,
    "",
    "### 补充部分：线类",
    ...lineBlocks,
    "",
    "### 补充部分：区域",
    ...areaBlocks,
  ].join("\n");
}

function buildPolarLevelBlock(
  level: PolarViewLevel,
  includedCategories: PolarFeatureCategory[],
  playerOrientation: number,
): string {
  const levelDesc = { 1: "30m~100m", 2: "100m~300m", 3: "300m~1km" };
  const clusters = level.clusters.filter((cluster) =>
    cluster.features.some((feature) => includedCategories.includes(feature.category)),
  );

  if (clusters.length === 0) {
    return `#### 等级${level.level}(${levelDesc[level.level]})：\n信息不足，未生成极坐标摘要`;
  }

  let noGroupLines = true
  const groupLines = clusters.map((cluster) => {
    const groupBlock = buildPolarGroupBlock(level.level, cluster, playerOrientation);
    if (!groupBlock) return ''
    noGroupLines = false
    return [groupBlock.title + ":", "", ...groupBlock.lines, ""].join("\n");
  });

  if (noGroupLines) return `#### 等级${level.level}(${levelDesc[level.level]})：\n信息不足，未生成极坐标摘要`

  return [`#### 等级${level.level}(${levelDesc[level.level]})：`, ...groupLines].join("\n");
}

function buildPolarGroupBlock(
  level: 1 | 2 | 3,
  cluster: PolarViewCluster,
  playerOrientation: number,
): {
  title: string;
  lines: string[];
} | undefined {
  const features = cluster.features.filter( f => f.baseLabel !== "NOT_DISPLAY")
  const firstFeature = features[0];
  if (!firstFeature) {
    return
  }

  if (cluster.features.length === 1) {
    const lines = buildPolarFeatureLines(level, firstFeature, playerOrientation);
    if (lines.length === 0) {
      return;
    }

    return {
      title: firstFeature.baseLabel,
      lines,
    };
  }

  const lines = buildPolarClusterSummaryLines(level, cluster, playerOrientation);
  if (lines.length === 0) {
    return;
  }

  return {
    title: firstFeature.baseLabel,
    lines,
  };
}

function buildPolarClusterSummaryLines(
  level: 1 | 2 | 3,
  cluster: PolarViewCluster,
  playerOrientation: number,
): string[] {
  const features: MarkedPolarViewFeature[] = cluster.features
  const config = POLAR_LEVEL_CLUSTER_PROMPT_CONFIG[level];
  const sortedFeatures = [...features].sort(
    (left, right) =>
      left.widestSpan.angleWidthDegrees - right.widestSpan.angleWidthDegrees ||
      left.centerPoint.distanceMeters - right.centerPoint.distanceMeters ||
      left.osmId - right.osmId,
  );
  // 找到群里宽度最大的作为代表地物
  const representativeFeatures = sortedFeatures
    .filter((feature) => feature.widestSpan.angleWidthDegrees >= config.representativeMinAngleDegrees)
    .slice(0, config.representativeLimit);
  // 如果代表地物各个都不满足条件，至少挑1个最大的作为保底
  const fallbackFeature = representativeFeatures.length === 0 ? (sortedFeatures[0] ?? null) : null;
  // 最终决定展示的地物
  const resolvedRepresentativeFeatures = fallbackFeature ? [fallbackFeature] : representativeFeatures;

  const omittedCount = Math.max(0, features.length - resolvedRepresentativeFeatures.length);
  const shouldShowOmissionSummary = omittedCount > 0;
  const hint = shouldShowOmissionSummary
    ? `，共${cluster.memberCount}个要素，展示${resolvedRepresentativeFeatures.length}个代表要素，其余${omittedCount}个仅保留数量`
    : "";
  const renderedFeatureLines = resolvedRepresentativeFeatures.flatMap((anchor) =>
    buildPolarFeatureLines(level, anchor, playerOrientation),
  );

  if (renderedFeatureLines.length === 0) {
    return [];
  }

  return [
    `* 群中心方向${formatRelativeDirection(cluster.centerBearingDegrees, playerOrientation)}${hint}`,
    ...renderedFeatureLines,
  ];
}

function buildPolarFeatureLines(
  level: 1 | 2 | 3,
  feature: MarkedPolarViewFeature,
  playerOrientation: number,
): string[] {
  const detailTags = collectPromptTags(level, feature).map((tag) => `${tag.key}: ${tag.value}`);
  const baseLines = [
    `* (id=${feature.featureId})`,
  ];

  if (feature.category === "line" && feature.linePoints && feature.linePoints.length > 0) {
    const pointText = feature.linePoints
      .map((point, index) => `点${index + 1}${formatPolarSample(point, playerOrientation)}`)
      .join("，");
    return [
      ...baseLines,
      `  * 中心点${formatPolarSample(feature.centerPoint, playerOrientation)}`,
      `  * 线顶点抽样：${pointText}`,
      `  * 主走向${formatRelativeDirection(feature.orientationDegrees || 0, playerOrientation)}`,
      `  * 起终点开角：边界点1${formatPolarSample(feature.widestSpan.clockwiseEarlyPoint, playerOrientation)}，边界点2${formatPolarSample(feature.widestSpan.clockwiseLatePoint, playerOrientation)}，角宽${formatAngle(feature.widestSpan.angleWidthDegrees)}`,
      ...detailTags.map((tag) => `  * ${tag}`),
    ];
  }
  if (feature.category === 'poi') {
    if (level === 3 && !isSignificantPoi(feature.featureDetail.tags)) {
      return []; // 在此处应用 level 3 的非显著 POI 完全不显示的限制
    }

    return [
      ...baseLines,
      `  * 坐标${formatPolarSample(feature.centerPoint, playerOrientation)}`,
      ...detailTags.map((tag) => `  * ${tag}`),
    ];
  }

  return [
    ...baseLines,
    `  * 最近点${formatPolarSample(feature.nearestPoint, playerOrientation)}，最远点${formatPolarSample(feature.farthestPoint, playerOrientation)}，中心点${formatPolarSample(feature.centerPoint, playerOrientation)}`,
    `  * 边界点1${formatPolarSample(feature.widestSpan.clockwiseEarlyPoint, playerOrientation)}，边界点2${formatPolarSample(feature.widestSpan.clockwiseLatePoint, playerOrientation)}，视野角宽${formatAngle(feature.widestSpan.angleWidthDegrees)}`,
    ...detailTags.map((tag) => `  * ${tag}`),
  ];
}

/**
 * 再次应用 Polar View Prompt 过滤逻辑，只不过这次是具体tag的呈现
 * （上次是在 label 系统）
 * 1. level 1: 特定细节一览无余
 * 2. level 2: 对建筑来说，name brand height-level, 其余（POI、线、区域）仅基本信息
 * 3. level 3: 对建筑来说，height-level，其余（线、区域、显著POI）仅基本信息（不显著POI会被自动过滤）
 * @param feature
 * @returns
 */
function collectPromptTags(level: 1|2|3, feature: MarkedPolarViewFeature): Array<{ key: string; value: string }> {
  // 先把可展示的细节过滤出来
  const selectedEntries = PROMPT_TAG_KEYS_BY_CATEGORY[feature.category]
    .flatMap((key) => {
      const value = trimTagValue(feature.featureDetail.tags[key]);
      return value ? [{ key, value }] : [];
    });
  const entries = selectedEntries.map(e => [e.key, e.value])
  switch (level) {
    case 1:  // 特定细节一览无余
      return entries.flatMap(([key, rawValue]) => {
          const value = trimTagValue(rawValue);
          if (!value) { return []; }
          return [{ key, value }];
        })
    case 2:
      if (feature.category === 'building') { // 建筑可展示：名字/品牌，楼层/高度
        return entries.flatMap(([key, rawValue]) => {
            const value = trimTagValue(rawValue);
            if (!value) { return []; }
            return [{ key, value }];
          }).filter(e => ["name", "brand", "building:levels", "height"].includes(e.key))
      } else {
        return []
      }
    case 3:
      if (feature.category === 'building') { // 建筑可展示：楼层/高度
        return entries.flatMap(([key, rawValue]) => {
            const value = trimTagValue(rawValue);
            if (!value) { return []; }
            return [{ key, value }];
          }).filter(e => ["building:levels", "height"].includes(e.key))
      } else {
        return []
      }
  }
}

function formatPolarSample(
  sample: { distanceMeters: number; bearingDegrees: number },
  playerOrientation: number,
): string {
  return `距离${Math.round(sample.distanceMeters)}m / ${formatRelativeDirection(sample.bearingDegrees, playerOrientation)}`;
}

function formatAngle(angleDegrees: number): string {
  return `${Math.round(angleDegrees)}°`;
}

/**
 * 返回某一角度的方向与实际偏转角，正前方为 0°
 * @param bearingDegrees 正北0°坐标下的绝对偏转角
 * @param playerOrientation
 * @returns 方向标记和实际角度的字符串
 */
export function formatRelativeDirection(bearingDegrees: number, playerOrientation: number): string {
  const relativeDegrees = normalizeBearingDegrees(bearingDegrees - playerOrientation);
  const labels = [
    "前",
    "前偏右",
    "右前",
    "右偏前",
    "右",
    "右偏后",
    "右后",
    "后偏右",
    "后",
    "后偏左",
    "左后",
    "左偏后",
    "左",
    "左偏前",
    "左前",
    "前偏左",
  ] as const;
  const index = Math.floor((relativeDegrees + 11.25) / 22.5) % labels.length;
  return `${labels[index]}(${Math.round(relativeDegrees)}°)`;
}

function getLargestLevel(polarView: PolarView): 1 | 2 | 3 | undefined {
  const levels = polarView.levels
    .filter((level) => level.clusters.length > 0)
    .map((level) => level.level);
  if (levels.includes(3)) return 3;
  if (levels.includes(2)) return 2;
  if (levels.includes(1)) return 1;
}
