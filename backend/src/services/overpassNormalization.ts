import osmtogeojson from 'osmtogeojson';
import type { Feature, FeatureCollection, Geometry } from 'geojson';

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

export type NormalizedFeature = Feature<Geometry, NormalizedFeatureProperties>;
export type NormalizedFeatureCollection = FeatureCollection<Geometry, NormalizedFeatureProperties>;

export interface NormalizationDiagnostics {
  requestedCategories: FeatureCategory[];
  rawElementCounts: Record<string, number>;
  totalRawElements: number;
  totalConvertedFeatures: number;
  totalNormalizedFeatures: number;
  featureCountsByGeometryType: Record<string, number>;
  taintedFeatures: number;
  skippedFeaturesWithoutGeometry: number;
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

// 这里把 tags 清洗成纯字符串字典，避免后续调用方还要反复判断 value 类型。
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

// meta 字段只保留最常用的 number / string，便于调试时直接 JSON.stringify 查看。
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

// osmtogeojson 会把 relation 成员信息放到 properties.relations 里，这里统一规整成稳定结构。
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

function countFeaturesByGeometryType(features: NormalizedFeature[]): Record<string, number> {
  return features.reduce<Record<string, number>>((counts, feature) => {
    const geometryType = feature.geometry.type;
    counts[geometryType] = (counts[geometryType] || 0) + 1;
    return counts;
  }, {});
}

// 这里不再筛掉点、线、面，只要 osmtogeojson 成功给出了有效 geometry，就统一返回。
// 真正只关心面要素的调用方，可以在上层按 geometry.type 再次过滤。
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

// 同时查询 way 和 relation，是因为 OSM 里的“区域”并不总是单个闭合 way。
// 有些区域会以 multipolygon relation 表达，必须把 relation 一起查回来，后续转换时才能正确拼出几何。
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

// 整个 normalization 的入口：
// 1. 先把 Overpass JSON 交给 osmtogeojson，得到标准 GeoJSON FeatureCollection。
// 2. 再把每个 Feature 的 properties 规整成项目内部更稳定的结构。
// 3. 最后汇总 raw 层统计、geometry 维度统计和 tainted 数量，方便前端调试。
//
// 这里使用 flatProperties: false，是为了保留 tags / meta / relations 的分层信息，
// 后续如果你要继续扩展几何判断或 relation 调试，这种结构会比拍平成单层属性更容易理解。
export function normalizeOverpassData(
  raw: OverpassJsonResponse,
  options: { requestedCategories?: FeatureCategory[] } = {},
): { geojson: NormalizedFeatureCollection; diagnostics: NormalizationDiagnostics } {
  const converted = osmtogeojson(raw, { flatProperties: false }) as FeatureCollection;
  const normalizedCandidates = converted.features.map((feature) => normalizeFeature(feature));
  const features = normalizedCandidates.filter((feature): feature is NormalizedFeature => feature !== null);
  const skippedFeaturesWithoutGeometry = normalizedCandidates.length - features.length;
  const taintedFeatures = features.filter((feature) => feature.properties.tainted).length;

  return {
    geojson: {
      type: 'FeatureCollection',
      features,
    },
    diagnostics: {
      requestedCategories: sanitizeCategories(options.requestedCategories),
      rawElementCounts: countRawElements(raw.elements || []),
      totalRawElements: raw.elements?.length || 0,
      totalConvertedFeatures: converted.features.length,
      totalNormalizedFeatures: features.length,
      featureCountsByGeometryType: countFeaturesByGeometryType(features),
      taintedFeatures,
      skippedFeaturesWithoutGeometry,
    },
  };
}
