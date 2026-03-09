import osmtogeojson from 'osmtogeojson';
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson';

export const supportedFeatureCategories = ['building', 'landuse', 'natural', 'leisure', 'amenity'] as const;

export type FeatureCategory = (typeof supportedFeatureCategories)[number];

export interface NormalizedOverpassRequest {
  lat: number;
  lon: number;
  radius: number;
  includeRaw?: boolean;
  featureCategories?: FeatureCategory[];
}

export interface RelationReference {
  role: string;
  rel: number;
  reltags: Record<string, string>;
}

export interface NormalizedFeatureProperties {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  relations: RelationReference[];
  meta: Record<string, string | number>;
  tainted: boolean;
}

export type NormalizedFeature = Feature<Polygon | MultiPolygon, NormalizedFeatureProperties>;
export type NormalizedFeatureCollection = FeatureCollection<Polygon | MultiPolygon, NormalizedFeatureProperties>;

export interface NormalizationDiagnostics {
  requestedCategories: FeatureCategory[];
  rawElementCounts: Record<string, number>;
  totalRawElements: number;
  totalConvertedFeatures: number;
  totalNormalizedFeatures: number;
  filteredNonPolygonFeatures: number;
  polygonFeatures: number;
  multiPolygonFeatures: number;
  taintedFeatures: number;
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

function sanitizeCategories(categories?: FeatureCategory[]): FeatureCategory[] {
  const requested = categories?.length ? categories : [...supportedFeatureCategories];
  return [...new Set(requested.filter((category): category is FeatureCategory => supportedFeatureCategories.includes(category)))];
}

function countRawElements(elements: Array<{ type?: string }>): Record<string, number> {
  return elements.reduce<Record<string, number>>((counts, element) => {
    const type = element.type || 'unknown';
    counts[type] = (counts[type] || 0) + 1;
    return counts;
  }, {});
}

function normalizeFeature(feature: Feature): NormalizedFeature | null {
  if (feature.geometry.type !== 'Polygon' && feature.geometry.type !== 'MultiPolygon') {
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

export function buildNormalizedOverpassQuery(request: NormalizedOverpassRequest): string {
  const categories = sanitizeCategories(request.featureCategories);
  const clauses = categories.flatMap((category) => [
    `  way(around:${request.radius},${request.lat},${request.lon})[${category}];`,
    `  relation(around:${request.radius},${request.lat},${request.lon})[type=multipolygon][${category}];`,
  ]);

  return [
    '[out:json][timeout:25];',
    '(',
    ...clauses,
    ');',
    'out body geom;',
    '>;',
    'out skel geom;',
  ].join('\n');
}

export function normalizeOverpassData(
  raw: OverpassJsonResponse,
  options: { requestedCategories?: FeatureCategory[] } = {},
): { geojson: NormalizedFeatureCollection; diagnostics: NormalizationDiagnostics } {
  const converted = osmtogeojson(raw, { flatProperties: false }) as FeatureCollection;
  const features = converted.features.flatMap((feature) => {
    const normalized = normalizeFeature(feature);
    return normalized ? [normalized] : [];
  });

  const polygonFeatures = features.filter((feature) => feature.geometry.type === 'Polygon').length;
  const multiPolygonFeatures = features.filter((feature) => feature.geometry.type === 'MultiPolygon').length;
  const taintedFeatures = features.filter((feature) => feature.properties.tainted).length;
  const totalConvertedFeatures = converted.features.length;

  return {
    geojson: {
      type: 'FeatureCollection',
      features,
    },
    diagnostics: {
      requestedCategories: sanitizeCategories(options.requestedCategories),
      rawElementCounts: countRawElements(raw.elements || []),
      totalRawElements: raw.elements?.length || 0,
      totalConvertedFeatures,
      totalNormalizedFeatures: features.length,
      filteredNonPolygonFeatures: totalConvertedFeatures - features.length,
      polygonFeatures,
      multiPolygonFeatures,
      taintedFeatures,
    },
  };
}
