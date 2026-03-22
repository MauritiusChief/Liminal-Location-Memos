import type { Geometry } from 'geojson';
import type { NormalizedFeature } from './osmNormalizer.js';

export type OsmFeatureCategory = 'building' | 'poi' | 'line' | 'area';
type GeometryFamily = 'point' | 'line' | 'polygon';

type CategoryConfig = {
  geometryFamily: GeometryFamily;
  structuredTagKeys: readonly string[];
  primaryLabelKeys: readonly string[];
  classifierTagKeys: readonly string[];
  retentionTagKeys: readonly string[];
};

export const BUILDING_STRUCTURED_TAG_KEYS = ['name', 'building', 'man_made', 'height', 'level', 'building:levels'] as const;
export const BUILDING_PRIMARY_LABEL_KEYS = ['building', 'man_made'] as const;
export const BUILDING_CLASSIFIER_TAG_KEYS = ['building', 'man_made'] as const;
export const BUILDING_RETENTION_TAG_KEYS = [] as const;

export const POI_STRUCTURED_TAG_KEYS = ['name', 'brand', 'shop', 'amenity', 'office', 'tourism', 'leisure', 'craft', 'healthcare', 'natural', 'man_made'] as const;
export const POI_PRIMARY_LABEL_KEYS = ['shop', 'amenity', 'office', 'tourism', 'leisure', 'craft', 'healthcare', 'natural', 'man_made'] as const;
export const POI_CLASSIFIER_TAG_KEYS = POI_PRIMARY_LABEL_KEYS;
export const POI_RETENTION_TAG_KEYS = ['historic'] as const;

export const LINE_STRUCTURED_TAG_KEYS = ['name', 'highway', 'railway', 'waterway', 'man_made'] as const;
export const LINE_PRIMARY_LABEL_KEYS = ['highway', 'railway', 'waterway', 'man_made'] as const;
export const LINE_CLASSIFIER_TAG_KEYS = LINE_PRIMARY_LABEL_KEYS;
export const LINE_RETENTION_TAG_KEYS = [] as const;

export const AREA_STRUCTURED_TAG_KEYS = ['name', 'landuse', 'natural', 'leisure', 'amenity'] as const;
export const AREA_PRIMARY_LABEL_KEYS = ['landuse', 'natural', 'leisure', 'amenity'] as const;
export const AREA_CLASSIFIER_TAG_KEYS = AREA_PRIMARY_LABEL_KEYS;
export const AREA_RETENTION_TAG_KEYS = [] as const;

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

export function getStructuredTagColumns(category: OsmFeatureCategory): readonly string[] {
  return OSM_FEATURE_CATEGORY_CONFIG[category].structuredTagKeys;
}

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

export function matchFeatureCategory(feature: NormalizedFeature): OsmFeatureCategory | null {
  return OSM_DB_CATEGORY_PRIORITY.find((category) => categoryMatchesFeature(category, feature)) || null;
}

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
