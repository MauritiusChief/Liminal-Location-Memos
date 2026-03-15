import {
  AREA_PRIMARY_LABEL_KEYS,
  BUILDING_PRIMARY_LABEL_KEYS,
  LINE_PRIMARY_LABEL_KEYS,
  POI_PRIMARY_LABEL_KEYS,
} from './osmFeatureConfig.js';

export const BUILDING_TAG_KEYS = BUILDING_PRIMARY_LABEL_KEYS;
export const POI_TAG_KEYS = POI_PRIMARY_LABEL_KEYS;
export const AREA_TAG_KEYS = AREA_PRIMARY_LABEL_KEYS;
export const ROAD_TAG_KEYS = LINE_PRIMARY_LABEL_KEYS;
const BUILDING_POI_LABEL_LIMIT = 1;

interface LabelContainedPoi {
  tags: Record<string, string>;
}

export interface BuildingLabelSource {
  tags: Record<string, string>;
  containedPois?: LabelContainedPoi[];
}

// 这个文件专门承接“如何把 normalized feature 压成短标签”这类规则。
// 这样 grid 和 polar 可以共享同一套文本风格，而不用各自维护一份相似但逐渐分叉的逻辑。

// 这里顺手把空字符串也视为“没有值”，避免 label 里出现视觉上为空的噪音。
export function trimTagValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// 共用的依照 XX_TAG_KEYS 产出主分类标签的函数。
// 返回值保留 key:value 形式，避免调用方只看到裸值却不知道语义来源。
export function getPrimaryLabel(keys: readonly string[], tags: Record<string, string>): string | null {
  for (const key of keys) {
    const value = trimTagValue(tags[key]);
    if (value) {
      return `${key}:${value}`;
    }
  }

  return null;
}

export function getFallbackBuildingLabel(buildingTagValue: string | undefined): string {
  const buildingValue = trimTagValue(buildingTagValue);
  return buildingValue && buildingValue !== 'yes' ? `building:${buildingValue}` : 'building';
}

export function getFallbackBuildingLikeLabel(tags: Record<string, string>): string {
  const buildingValue = trimTagValue(tags.building);
  if (buildingValue) {
    return getFallbackBuildingLabel(buildingValue);
  }

  const manMadeValue = trimTagValue(tags.man_made);
  return manMadeValue ? `man_made:${manMadeValue}` : 'building';
}

// 当前建筑标签规则只在“内部正好有 1 个可展示 contained POI”时借用它。
// 这是复用现有 overpassGrid 行为，而不是恢复到更早的“前两个 POI 拼接”版本。
export function getDisplayableContainedPois(containedPois: LabelContainedPoi[] | undefined): LabelContainedPoi | null {
  if (!containedPois || containedPois.length === 0 || containedPois.length > BUILDING_POI_LABEL_LIMIT) {
    return null;
  }

  return containedPois[0];
}

export function getPoiDisplayLabel(tags: Record<string, string>): string {
  const label = getPrimaryLabel(POI_TAG_KEYS, tags) || 'poi';
  const name = trimTagValue(tags.name) || trimTagValue(tags.brand);
  return name ? `${name} - ${label}` : label;
}

export function getRoadDisplayLabel(tags: Record<string, string>): string {
  const label = getPrimaryLabel(ROAD_TAG_KEYS, tags) || 'way';
  const name = trimTagValue(tags.name);
  return name ? `${name} - ${label}` : label;
}

export function getAreaDisplayLabel(tags: Record<string, string>): string {
  const label = getPrimaryLabel(AREA_TAG_KEYS, tags) || 'area';
  const name = trimTagValue(tags.name);
  return name ? `${name} - ${label}` : label;
}

// 建筑标签只负责回答“这个建筑本身该怎么称呼”，
// POI / ROAD 的重叠显示由 grid 之类的上层结构再做额外拼接。
export function buildBuildingBaseLabel(
  feature: BuildingLabelSource,
): string {
  const buildingName = trimTagValue(feature.tags.name);
  const fallbackBuildingLabel = getFallbackBuildingLikeLabel(feature.tags);
  const containedPoi = getDisplayableContainedPois(feature.containedPois);
  const containedPoiLabel = containedPoi ? getPoiDisplayLabel(containedPoi.tags) : null;

  if (buildingName) {
    return `${buildingName} | ${containedPoiLabel || fallbackBuildingLabel}`;
  }

  if (containedPoiLabel) {
    return `${containedPoiLabel} | ${fallbackBuildingLabel}`;
  }

  return fallbackBuildingLabel;
}
