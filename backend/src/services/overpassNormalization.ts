import osmtogeojson from 'osmtogeojson';
import type { Feature, FeatureCollection, Geometry } from 'geojson';

export interface NormalizedOverpassRequest {
  lat: number;
  lon: number;
  radius: number;
  includeRaw?: boolean;
}

export interface RelationReference {
  role: string;
  rel: number;
  reltags: Record<string, string>;
}

export interface ContainedPoi {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  relations: RelationReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
  coordinate: [number, number];
  sourceFeatureId: string;
}

export interface NormalizedFeatureProperties {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  relations: RelationReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
  containedPois?: ContainedPoi[];
}

export type NormalizedFeature = Feature<Geometry, NormalizedFeatureProperties>;
export type NormalizedFeatureCollection = FeatureCollection<Geometry, NormalizedFeatureProperties>;

export interface NormalizationDiagnostics {
  rawElementCounts: Record<string, number>;
  totalRawElements: number;
  totalConvertedFeatures: number;
  totalNormalizedFeatures: number;
  featureCountsByGeometryType: Record<string, number>;
  taintedFeatures: number;
  skippedFeaturesWithoutGeometry: number;
  filteredRelationOutlineFeatures: number;
  filteredRelationMemberLineFeatures: number;
}

export interface OverpassJsonResponse {
  version?: number;
  generator?: string;
  osm3s?: {
    timestamp_osm_base?: string;
    copyright?: string;
  };
  elements: Array<{ type?: string }>;
}

type RawFeatureProperties = {
  type?: unknown;
  id?: unknown;
  tags?: unknown;
  relations?: unknown;
  meta?: unknown;
  tainted?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) {
    return {};
  }

  const entries: Array<[string, string]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      entries.push([key, entry]);
    }
  }
  return Object.fromEntries(entries);
}

function toMetaRecord(value: unknown): Record<string, string | number> {
  if (!isRecord(value)) {
    return {};
  }

  const entries: Array<[string, string | number]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' || typeof entry === 'string') {
      entries.push([key, entry]);
    }
  }
  return Object.fromEntries(entries);
}

function toRelationReferences(value: unknown): RelationReference[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    if (!isRecord(entry) || typeof entry.role !== 'string' || typeof entry.rel !== 'number') {
      return [];
    }

    return [
      {
        role: entry.role,
        rel: entry.rel,
        reltags: toStringRecord(entry.reltags),
      },
    ];
  });
}

function normalizeFeature(feature: Feature): NormalizedFeature | null {
  if (!feature.geometry) {
    return null;
  }

  const properties = (feature.properties || {}) as RawFeatureProperties;
  const osmType = typeof properties.type === 'string' ? properties.type : 'unknown';
  const osmId = typeof properties.id === 'number' ? properties.id : Number.NaN;

  return {
    type: 'Feature',
    id: feature.id ? String(feature.id) : `${osmType}/${osmId}`,
    geometry: feature.geometry,
    properties: {
      osmType,
      osmId,
      tags: toStringRecord(properties.tags),
      relations: toRelationReferences(properties.relations),
      meta: toMetaRecord(properties.meta),
      tainted: Boolean(properties.tainted),
    },
  };
}

function isLinearGeometry(feature: NormalizedFeature): boolean {
  return feature.geometry.type === 'LineString' || feature.geometry.type === 'MultiLineString';
}

function isRelationOutlineCoveredByPolygon(feature: NormalizedFeature): boolean {
  if (!isLinearGeometry(feature)) {
    return false;
  }

  return feature.properties.relations.some((relation) => {
    const relationType = relation.reltags.type;
    const isAreaRelation = relationType === 'multipolygon' || relationType === 'boundary';
    const isOutlineRole = relation.role === 'outer' || relation.role === 'inner';
    return isAreaRelation && isOutlineRole;
  });
}

function hasMeaningfulLinearTags(tags: Record<string, string>): boolean {
  return Object.keys(tags).length > 0;
}

function buildRelationLineIndex(features: NormalizedFeature[]): Set<number> {
  const relationIds = new Set<number>();

  for (const feature of features) {
    if (!isLinearGeometry(feature) || feature.properties.osmType !== 'relation') {
      continue;
    }

    const relationType = feature.properties.tags.type;
    if (relationType === 'route' || relationType === 'waterway') {
      relationIds.add(feature.properties.osmId);
    }
  }

  return relationIds;
}

function isMemberLineCoveredByRelationLine(feature: NormalizedFeature, relationLineIds: Set<number>): boolean {
  if (!isLinearGeometry(feature) || feature.properties.osmType !== 'way') {
    return false;
  }

  if (hasMeaningfulLinearTags(feature.properties.tags)) {
    return false;
  }

  return feature.properties.relations.some((relation) => {
    if (!relationLineIds.has(relation.rel)) {
      return false;
    }

    const relationType = relation.reltags.type;
    return relationType === 'route' || relationType === 'waterway';
  });
}

export function buildNormalizedOverpassQuery(request: NormalizedOverpassRequest): string {
  return [
    '[out:json][timeout:25];',
    `nwr(around:${request.radius},${request.lat},${request.lon});`,
    'out body geom;',
    '>;',
    'out skel geom;',
  ].join('\n');
}

export function convertOverpassToNormalizedFeatures(raw: OverpassJsonResponse): NormalizedFeature[] {
  const converted = osmtogeojson(raw, { flatProperties: false }) as FeatureCollection;
  const normalizedCandidates = converted.features.map((feature) => normalizeFeature(feature));
  const normalizedFeatures = normalizedCandidates.filter((feature): feature is NormalizedFeature => feature !== null);

  const withoutPolygonOutlines = normalizedFeatures.filter((feature) => !isRelationOutlineCoveredByPolygon(feature));
  const relationLineIds = buildRelationLineIndex(withoutPolygonOutlines);

  return withoutPolygonOutlines.filter((feature) => !isMemberLineCoveredByRelationLine(feature, relationLineIds));
}
