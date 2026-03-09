export interface HealthResponse {
  ok: boolean;
  service: string;
}

export interface ChatResponse {
  reply: string;
}

export interface OverpassResponse {
  data: unknown;
}

export type FeatureCategory = 'building' | 'landuse' | 'natural' | 'leisure' | 'amenity';

export interface NormalizedFeatureProperties {
  osmType: string;
  osmId: number;
  tags: Record<string, string>;
  relations: Array<{
    role: string;
    rel: number;
    reltags: Record<string, string>;
  }>;
  meta: Record<string, string | number>;
  tainted: boolean;
}

export interface NormalizedFeature {
  type: 'Feature';
  id?: string;
  geometry: {
    type: 'Polygon' | 'MultiPolygon';
    coordinates: unknown;
  };
  properties: NormalizedFeatureProperties;
}

export interface NormalizedFeatureCollection {
  type: 'FeatureCollection';
  features: NormalizedFeature[];
}

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

export interface NormalizedOverpassRequest {
  lat: number;
  lon: number;
  radius: number;
  includeRaw?: boolean;
  featureCategories?: FeatureCategory[];
}

export interface NormalizedOverpassResponse {
  query: string;
  geojson: NormalizedFeatureCollection;
  diagnostics: NormalizationDiagnostics;
  raw?: unknown;
}

interface ErrorResponse {
  error: string;
}

/**
 * fetch 后端的状态
 * @returns
 */
export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/health');

  if (!response.ok) {
    throw new Error('Failed to fetch backend health.');
  }

  return response.json() as Promise<HealthResponse>;
}

/**
 * post 一个消息
 * @param message
 * @returns
 */
export async function postChatMessage(message: string): Promise<ChatResponse> {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message }),
  });

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => ({ error: 'Request failed.' }))) as ErrorResponse;
    throw new Error(errorPayload.error || 'Request failed.');
  }

  return response.json() as Promise<ChatResponse>;
}

export async function postOverpassQuery(query: string): Promise<OverpassResponse> {
  const response = await fetch('/api/overpass', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => ({ error: 'Request failed.' }))) as ErrorResponse;
    throw new Error(errorPayload.error || 'Request failed.');
  }

  return response.json() as Promise<OverpassResponse>;
}

export async function postNormalizedOverpassQuery(
  request: NormalizedOverpassRequest,
): Promise<NormalizedOverpassResponse> {
  const response = await fetch('/api/overpass/normalize', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(request),
  });

  if (!response.ok) {
    const errorPayload = (await response.json().catch(() => ({ error: 'Request failed.' }))) as ErrorResponse;
    throw new Error(errorPayload.error || 'Request failed.');
  }

  return response.json() as Promise<NormalizedOverpassResponse>;
}
