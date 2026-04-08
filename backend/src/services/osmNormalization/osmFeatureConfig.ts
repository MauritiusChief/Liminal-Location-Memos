import type { Geometry } from 'geojson';
import type { NormalizedFeature } from './osmNormalizer.js';

export type OsmFeatureCategory = 'building' | 'poi' | 'line' | 'area';
type GeometryFamily = 'point' | 'line' | 'polygon';

// 每个类别的统一配置：
// 1) structuredTagKeys: 决定入库时哪些 tag 单独落结构化列（osmNormalizedToDb / osmRepository）
// 2) primaryLabelKeys: 决定标签文案主分类优先级（overpassLabels / overpassGrid / overpassPolar）
// 3) classifierTagKeys + retentionTagKeys: 决定 feature 是否可归入该类别（matchFeatureCategory）
type CategoryConfig = {
  geometryFamily: GeometryFamily;
  structuredTagKeys: readonly string[];
  primaryLabelKeys: readonly string[];
  classifierTagKeys: readonly string[];
  retentionTagKeys: readonly string[];
};

// 建筑：结构化字段覆盖建筑类型、高度、层数，便于后续摘要与显著性判断复用。
export const BUILDING_STRUCTURED_TAG_KEYS = ['name', 'building', 'man_made', 'height', 'level', 'building:levels'] as const;
// 建筑标签优先看 building，再回退到 man_made。
export const BUILDING_PRIMARY_LABEL_KEYS = ['building', 'man_made'] as const;
export const BUILDING_CLASSIFIER_TAG_KEYS = ['building', 'man_made'] as const;
export const BUILDING_RETENTION_TAG_KEYS = [] as const;

// POI：覆盖常见业态 key；name/brand 保留给前端与 prompt 做可读展示。
export const POI_STRUCTURED_TAG_KEYS = ['name', 'brand', 'shop', 'amenity', 'office', 'tourism', 'leisure', 'craft', 'healthcare', 'natural', 'man_made'] as const;
export const POI_PRIMARY_LABEL_KEYS = ['shop', 'amenity', 'office', 'tourism', 'leisure', 'craft', 'healthcare', 'natural', 'man_made'] as const;
export const POI_CLASSIFIER_TAG_KEYS = POI_PRIMARY_LABEL_KEYS;
// historic 本身不作为主分类标签，但需要保留在分类判定里避免历史地物被漏掉。
export const POI_RETENTION_TAG_KEYS = ['historic'] as const;

// 线状地物：道路/铁路/水系/人造线性设施。
export const LINE_STRUCTURED_TAG_KEYS = ['name', 'highway', 'railway', 'waterway', 'man_made'] as const;
export const LINE_PRIMARY_LABEL_KEYS = ['highway', 'railway', 'waterway', 'man_made'] as const;
export const LINE_CLASSIFIER_TAG_KEYS = LINE_PRIMARY_LABEL_KEYS;
export const LINE_RETENTION_TAG_KEYS = [] as const;

// 面状区域：偏土地利用与自然/功能区标签。
export const AREA_STRUCTURED_TAG_KEYS = ['name', 'landuse', 'natural', 'leisure', 'amenity'] as const;
export const AREA_PRIMARY_LABEL_KEYS = ['landuse', 'natural', 'leisure', 'amenity'] as const;
export const AREA_CLASSIFIER_TAG_KEYS = AREA_PRIMARY_LABEL_KEYS;
export const AREA_RETENTION_TAG_KEYS = [] as const;

// 同一 feature 可能命中多个类别时，按该顺序选首个类别落库。
// 例如带 amenity 的建筑优先归 building，而不是 poi。
export const OSM_DB_CATEGORY_PRIORITY: readonly OsmFeatureCategory[] = ['building', 'poi', 'line', 'area'] as const;

export const OSM_FEATURE_CATEGORY_CONFIG: Record<OsmFeatureCategory, CategoryConfig> = {
  building: {
    geometryFamily: 'polygon',
    structuredTagKeys: BUILDING_STRUCTURED_TAG_KEYS,
    primaryLabelKeys: BUILDING_PRIMARY_LABEL_KEYS,
    classifierTagKeys: BUILDING_CLASSIFIER_TAG_KEYS,
    retentionTagKeys: BUILDING_RETENTION_TAG_KEYS,
  },
  poi: {
    geometryFamily: 'point',
    structuredTagKeys: POI_STRUCTURED_TAG_KEYS,
    primaryLabelKeys: POI_PRIMARY_LABEL_KEYS,
    classifierTagKeys: POI_CLASSIFIER_TAG_KEYS,
    retentionTagKeys: POI_RETENTION_TAG_KEYS,
  },
  line: {
    geometryFamily: 'line',
    structuredTagKeys: LINE_STRUCTURED_TAG_KEYS,
    primaryLabelKeys: LINE_PRIMARY_LABEL_KEYS,
    classifierTagKeys: LINE_CLASSIFIER_TAG_KEYS,
    retentionTagKeys: LINE_RETENTION_TAG_KEYS,
  },
  area: {
    geometryFamily: 'polygon',
    structuredTagKeys: AREA_STRUCTURED_TAG_KEYS,
    primaryLabelKeys: AREA_PRIMARY_LABEL_KEYS,
    classifierTagKeys: AREA_CLASSIFIER_TAG_KEYS,
    retentionTagKeys: AREA_RETENTION_TAG_KEYS,
  },
};

/**
 * 给入库层提供“结构化 tag 列白名单”，剩余字段会落入 tags_extra。
 * @param category OSM 地物四大类别之一
 * @returns
 */
export function getStructuredTagColumns(category: OsmFeatureCategory): readonly string[] {
  return OSM_FEATURE_CATEGORY_CONFIG[category].structuredTagKeys;
}

/**
 * 分类命中规则：先过几何族（点/线/面），再检查分类相关 tag 是否存在字符串值。
 * 该函数被 matchFeatureCategory 调用，最终用于 syncNormalizedFeaturesToDb 的分表 upsert。
 * @param category
 * @param feature
 * @returns
 */
export function categoryMatchesFeature(
  category: OsmFeatureCategory,
  feature: Pick<NormalizedFeature, 'geometry' | 'properties'>,
): boolean {
  const config = OSM_FEATURE_CATEGORY_CONFIG[category];
  if (!matchesGeometryFamily(feature.geometry, config.geometryFamily)) {
    return false;
  }

  const relevantKeys = [
    ...config.classifierTagKeys,
    ...config.retentionTagKeys,
  ];
  return relevantKeys.some((key) => typeof feature.properties.tags[key] === 'string');
}

/**
 * 对单个规整化地物做类别决策；返回 null 表示当前规则无法归类（将被上游忽略）。
 * @param feature
 * @returns
 */
export function matchFeatureCategory(feature: NormalizedFeature): OsmFeatureCategory | null {
  return OSM_DB_CATEGORY_PRIORITY.find((category) => categoryMatchesFeature(category, feature)) || null;
}

// 把具体 GeoJSON geometry.type 映射到 point/line/polygon 三大几何族。
function matchesGeometryFamily(geometry: Geometry, geometryFamily: GeometryFamily): boolean {
  switch (geometryFamily) {
    case 'point':
      return geometry.type === 'Point';
    case 'line':
      return geometry.type === 'LineString' || geometry.type === 'MultiLineString';
    case 'polygon':
      return geometry.type === 'Polygon' || geometry.type === 'MultiPolygon';
  }
}
