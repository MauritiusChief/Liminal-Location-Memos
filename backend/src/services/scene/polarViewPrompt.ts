import { AREA_TAG_KEYS, BUILDING_TAG_KEYS, POI_TAG_KEYS, ROAD_TAG_KEYS, trimTagValue } from "./sceneUtilLabel.js";
import { PolarView, PolarViewCluster, PolarViewLevel } from "./polarViewLabeled.js";

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
  building: ["name", "brand", ...BUILDING_TAG_KEYS, ...POI_TAG_KEYS],
  poi: ["name", "brand", ...POI_TAG_KEYS],
  line: ["name", ...ROAD_TAG_KEYS],
  area: ["name", ...AREA_TAG_KEYS],
};

/**
 * 将 Polar View 直接生成提示词，不再额外过滤
 * @param polarView 已经过滤好的 Polar View
 * @returns
 */
export function buildPolarViewPrompt(polarView: PolarView): string {
  const buildingAndPoiBlocks = polarView.levels.map((level) =>
    buildPolarLevelBlock(level, ["building", "poi"]),
  );
  const lineBlocks = polarView.levels.map((level) =>
    buildPolarLevelBlock(level, ["line"]),
  );
  const areaBlocks = polarView.levels.map((level) =>
    buildPolarLevelBlock(level, ["area"]),
  );

  let hintOfLevel = "## 极坐标摘要：无";
  switch (getLargestLevel(polarView)) {
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
): string {
  const levelDesc = { 1: "100m~30m", 2: "300m~100m", 3: "1km~300m" };
  const clusters = level.clusters.filter((cluster) =>
    cluster.features.some((feature) => includedCategories.includes(feature.category)),
  );

  if (clusters.length === 0) {
    return `#### 等级${level.level}(${levelDesc[level.level]})：\n信息不足，未生成极坐标摘要\n`;
  }

  const groupLines = clusters.map((cluster) => {
    const groupBlock = buildPolarGroupBlock(level.level, cluster);
    return [groupBlock.title + ":", "", ...groupBlock.lines, ""].join("\n");
  });

  return [`#### 等级${level.level}(${levelDesc[level.level]})：`, ...groupLines].join("\n");
}

function buildPolarGroupBlock(
  level: 1 | 2 | 3,
  cluster: PolarViewCluster,
): {
  title: string;
  lines: string[];
} {
  const firstFeature = cluster.features[0];
  if (!firstFeature) {
    return {
      title: "",
      lines: [""],
    };
  }

  if (cluster.features.length === 1) {
    return {
      title: firstFeature.baseLabel,
      lines: buildPolarFeatureLines(firstFeature),
    };
  }

  return {
    title: firstFeature.baseLabel,
    lines: buildPolarClusterSummaryLines(level, cluster.features, cluster),
  };
}

function buildPolarClusterSummaryLines(
  level: 1 | 2 | 3,
  features: MarkedPolarViewFeature[],
  cluster: PolarViewCluster,
): string[] {
  const config = POLAR_LEVEL_CLUSTER_PROMPT_CONFIG[level];
  const sortedFeatures = [...features].sort(
    (left, right) =>
      left.widestSpan.angleWidthDegrees - right.widestSpan.angleWidthDegrees ||
      left.centerPoint.distanceMeters - right.centerPoint.distanceMeters ||
      left.osmId - right.osmId,
  );
  const representativeFeatures = sortedFeatures
    .filter((feature) => feature.widestSpan.angleWidthDegrees >= config.representativeMinAngleDegrees)
    .slice(0, config.representativeLimit);
  const fallbackFeature = representativeFeatures.length === 0 ? (sortedFeatures[0] ?? null) : null;
  const resolvedRepresentativeFeatures = fallbackFeature ? [fallbackFeature] : representativeFeatures;
  const omittedCount = Math.max(0, features.length - resolvedRepresentativeFeatures.length);
  const shouldShowOmissionSummary = omittedCount > 0;
  const hint = shouldShowOmissionSummary
    ? `，共${cluster.memberCount}个要素，展示${resolvedRepresentativeFeatures.length}个代表要素，其余${omittedCount}个仅保留数量`
    : "";
  const lines = [`* 群中心方位${formatAngle(cluster.centerBearingDegrees)}${hint}`];

  for (const anchor of resolvedRepresentativeFeatures) {
    lines.push(...buildPolarFeatureLines(anchor));
  }

  return lines;
}

function buildPolarFeatureLines(feature: MarkedPolarViewFeature): string[] {
  const detailTags = collectPromptTags(feature).map((tag) => `${tag.key}: ${tag.value}`);
  const baseLines = [
    `* (id=${feature.featureId})`,
  ];

  if (feature.category === "line" && feature.linePoints && feature.linePoints.length > 0) {
    const pointText = feature.linePoints
      .map((point, index) => `点${index + 1}${formatPolarSample(point)}`)
      .join("，");
    return [
      ...baseLines,
      `  * 中心点${formatPolarSample(feature.centerPoint)}`,
      `  * 线顶点抽样：${pointText}`,
      `  * 主走向${formatAngle(feature.orientationDegrees || 0)}`,
      `  * 起终点开角：边界点1${formatPolarSample(feature.widestSpan.clockwiseEarlyPoint)}，边界点2${formatPolarSample(feature.widestSpan.clockwiseLatePoint)}，角宽${formatAngle(feature.widestSpan.angleWidthDegrees)}`,
      ...detailTags.map((tag) => `  * ${tag}`),
    ];
  }

  return [
    ...baseLines,
    `  * 最近点${formatPolarSample(feature.nearestPoint)}，最远点${formatPolarSample(feature.farthestPoint)}，中心点${formatPolarSample(feature.centerPoint)}`,
    `  * 边界点1${formatPolarSample(feature.widestSpan.clockwiseEarlyPoint)}，边界点2${formatPolarSample(feature.widestSpan.clockwiseLatePoint)}，视野角宽${formatAngle(feature.widestSpan.angleWidthDegrees)}`,
    ...detailTags.map((tag) => `  * ${tag}`),
  ];
}

function collectPromptTags(feature: MarkedPolarViewFeature): Array<{ key: string; value: string }> {
  const selectedEntries = PROMPT_TAG_KEYS_BY_CATEGORY[feature.category]
    .flatMap((key) => {
      const value = trimTagValue(feature.featureDetail.tags[key]);
      return value ? [{ key, value }] : [];
    });

  const seen = new Set(selectedEntries.map((entry) => `${entry.key}:${entry.value}`));
  const fallbackEntries = Object.entries(feature.featureDetail.tags)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([key, rawValue]) => {
      const value = trimTagValue(rawValue);
      const tagKey = `${key}:${value}`;
      if (!value || seen.has(tagKey)) {
        return [];
      }
      return [{ key, value }];
    });

  return [...selectedEntries, ...fallbackEntries];
}

function formatPolarSample(sample: { distanceMeters: number; bearingDegrees: number }): string {
  return `距离${Math.round(sample.distanceMeters)}m / 方位${Math.round(sample.bearingDegrees)}°`;
}

function formatAngle(angleDegrees: number): string {
  return `${Math.round(angleDegrees)}°`;
}

function getLargestLevel(polarView: PolarView): 1 | 2 | 3 | undefined {
  const levels = polarView.levels
    .filter((level) => level.clusters.length > 0)
    .map((level) => level.level);
  if (levels.includes(3)) return 3;
  if (levels.includes(2)) return 2;
  if (levels.includes(1)) return 1;
}
