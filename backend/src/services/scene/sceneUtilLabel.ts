import {
  AREA_PRIMARY_LABEL_KEYS,
  BUILDING_PRIMARY_LABEL_KEYS,
  LINE_PRIMARY_LABEL_KEYS,
  POI_PRIMARY_LABEL_KEYS,
} from '@/services/osmNormalization/osmFeatureConfig.js';
import { ContainedPoiReference } from '@/services/osmNormalization/osmNormalizer.js';
import { FeatureDetail } from '../featureDetail.js';

export const BUILDING_TAG_KEYS = BUILDING_PRIMARY_LABEL_KEYS;
export const POI_TAG_KEYS = POI_PRIMARY_LABEL_KEYS;
export const AREA_TAG_KEYS = AREA_PRIMARY_LABEL_KEYS;
export const ROAD_TAG_KEYS = LINE_PRIMARY_LABEL_KEYS;
const BUILDING_POI_LABEL_LIMIT = 1;

// 这个文件专门承接“如何把 normalized feature 压成短标签”这类规则。
// 这样 grid 和 polar 可以共享同一套文本风格，而不用各自维护一份相似但逐渐分叉的逻辑。

//#region 共享辅助填标签函数

// 这里顺手把空字符串也视为“没有值”，避免 label 里出现视觉上为空的噪音。
export function trimTagValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 共用的依照 XX_TAG_KEYS 产出主分类标签的函数。
 * 返回值保留 key:value 形式，避免调用方只看到裸值却不知道语义来源。
 * 作用是提供最基础的分类参考
 * @param keys
 * @param tags
 * @returns
 */
export function getPrimaryLabel(keys: readonly string[], tags: Record<string, string>): string | null {
  for (const key of keys) {
    const value = trimTagValue(tags[key]);
    if (value) {
      return `${key}:${value}`;
    }
  }

  return null;
}

/**
 * 根据标签决定最基础的建筑标签
 * @param tags
 * @returns 'man_made:xxx' 或者 'building:xxx' 或者 'building
 */
export function getFallbackBuildingLabel(tags: Record<string, string>): string {
  const manMadeValue = trimTagValue(tags.man_made);
  if (manMadeValue) {
    return `man_made:${manMadeValue}`;
  }

  const buildingValue = trimTagValue(tags.building);
  return buildingValue && buildingValue !== 'yes' ? `building:${buildingValue}` : 'building';
}

/**
 * 在所含 POI 刚好为 1 个时，取出这个 POI；
 * 太多或太少都不取出
 * @param containedPois
 * @returns
 */
export function getDisplayableContainedPois(containedPois: ContainedPoiReference[] | undefined): ContainedPoiReference | null {
  if (!containedPois || containedPois.length === 0 || containedPois.length > BUILDING_POI_LABEL_LIMIT) {
    return null;
  }

  return containedPois[0];
}

/**
 * 如有正式名称或品牌则作为主体名称，基本分类作为辅助；
 * 若没有则使用基本分类作为标签
 * @param tags
 * @returns
 */
export function getPoiDisplayLabel(tags: Record<string, string>): string {
  const label = getPoiPrimaryLabel(tags);
  const name = trimTagValue(tags.name) || trimTagValue(tags.brand);
  return name ? `${name} - ${label}` : label;
}
export function getPoiPrimaryLabel(tags: Record<string, string>): string {
  return getPrimaryLabel(POI_TAG_KEYS, tags) || 'poi';
}

/**
 * 如有正式名称则作为主体名称，基本分类作为辅助；
 * 若没有则使用基本分类作为标签
 * @param tags
 * @returns
 */
export function getRoadDisplayLabel(tags: Record<string, string>): string {
  const label = getRoadPrimaryLabel(tags);
  const name = trimTagValue(tags.name);
  return name ? `${name} - ${label}` : label;
}
export function getRoadPrimaryLabel(tags: Record<string, string>): string {
  return getPrimaryLabel(ROAD_TAG_KEYS, tags) || 'line';
}

/**
 * 如有正式名称则作为主体名称，基本分类作为辅助；
 * 若没有则使用基本分类作为标签
 * @param tags
 * @returns
 */
export function getAreaDisplayLabel(tags: Record<string, string>): string {
  const label = getAreaPrimaryLabel(tags);
  const name = trimTagValue(tags.name);
  return name ? `${name} - ${label}` : label;
}
export function getAreaPrimaryLabel(tags: Record<string, string>): string {
  return getPrimaryLabel(AREA_TAG_KEYS, tags) || 'area';
}

/**
 * 拼接字符串形式的标签，规则：
 * 1. 标签分主体部分与提示部分
 * 2. 主体部分，优先使用建筑名字，其次使用所含POI名字
 * 3. 提示部分，优先使用所含POI名字，其次使用
 * @param feature
 * @returns 字符串标签
 */
export function buildBuildingBaseLabel(
  feature: FeatureDetail,
): string {
  const buildingName = trimTagValue(feature.tags.name);
  const fallbackBuildingLabel = getFallbackBuildingLabel(feature.tags);
  const containedPoi = getDisplayableContainedPois(feature.containedPoisReferences);
  const containedPoiLabel = containedPoi ? getPoiDisplayLabel(containedPoi.tags) : null;

  if (buildingName) {
    return `${buildingName} | ${containedPoiLabel || fallbackBuildingLabel}`;
  }

  if (containedPoiLabel) {
    return `${containedPoiLabel} | ${fallbackBuildingLabel}`;
  }

  return fallbackBuildingLabel;
}
