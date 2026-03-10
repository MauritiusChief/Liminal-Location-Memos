export interface HealthResponse {
  ok: boolean;
  service: string;
}

export interface ChatResponse {
  reply: string;
}

export interface PromptPreview {
  userPrompt: string;
}

export interface OverpassResponse {
  data: unknown;
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

export type MicroGridCellKind = 'building' | 'area' | 'empty';

export interface NormalizedMicroGridCell {
  row: number;
  col: number;
  center: [number, number];
  baseKind: MicroGridCellKind;
  baseLabel: string;
  poiLabels: string[];
  roadLabels: string[];
  label: string;
  sourceFeatureIds: string[];
}

export interface NormalizedMicroGrid {
  enabled: boolean;
  reason?: 'radius_too_small';
  center: {
    lat: number;
    lon: number;
  };
  extentMeters: 60;
  cellSizeMeters: 5;
  rows: 12;
  cols: 12;
  cells: NormalizedMicroGridCell[][];
}

export interface PolarCoordinateSample {
  coordinate: [number, number];
  distanceMeters: number;
  bearingDegrees: number;
}

export interface PolarAngularSpan {
  clockwiseEarlyPoint: PolarCoordinateSample;
  clockwiseLatePoint: PolarCoordinateSample;
  angleWidthDegrees: number;
}

export interface NormalizedPolarFeatureSummary {
  featureId: string;
  osmType: string;
  osmId: number;
  geometryType: string;
  displayLabel: string;
  level: 1 | 2 | 3;
  nearestPoint: PolarCoordinateSample;
  farthestPoint: PolarCoordinateSample;
  centerPoint: PolarCoordinateSample;
  widestSpan: PolarAngularSpan;
}

export interface NormalizedPolarLevel {
  level: 1 | 2 | 3;
  distanceRangeMeters: [number, number];
  features: NormalizedPolarFeatureSummary[];
}

export interface NormalizedPolarView {
  center: {
    lat: number;
    lon: number;
  };
  maxRadiusMeters: 1000;
  levels: NormalizedPolarLevel[];
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

export interface NormalizedFeature {
  type: 'Feature';
  id?: string;
  geometry: {
    type: string;
    coordinates?: unknown;
    geometries?: unknown;
  };
  properties: NormalizedFeatureProperties;
}

export interface NormalizedFeatureCollection {
  type: 'FeatureCollection';
  features: NormalizedFeature[];
}

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

export interface NormalizedOverpassRequest {
  lat: number;
  lon: number;
  radius: number;
  includeRaw?: boolean;
}

export interface NormalizedOverpassResponse {
  query: string;
  geojson: NormalizedFeatureCollection;
  diagnostics: NormalizationDiagnostics;
  microGrid?: NormalizedMicroGrid;
  polarView?: NormalizedPolarView;
  promptPreview?: PromptPreview;
  raw?: unknown;
}

interface ErrorResponse {
  error: string;
}

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/health');

  if (!response.ok) {
    throw new Error('Failed to fetch backend health.');
  }

  return response.json() as Promise<HealthResponse>;
}

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

export async function postDebugLlmMessage(input: { systemPrompt: string; message: string }): Promise<ChatResponse> {
  const response = await fetch('/api/debug/llm', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
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
