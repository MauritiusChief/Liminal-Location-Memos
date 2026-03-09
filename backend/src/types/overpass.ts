import type { FeatureCategory, NormalizationDiagnostics, NormalizedFeatureCollection } from '../services/overpassNormalization.js';

export type { FeatureCategory };

export interface OverpassResponse {
  data: unknown;
}

export interface NormalizedOverpassRequestBody {
  lat?: number;
  lon?: number;
  radius?: number;
  includeRaw?: boolean;
  featureCategories?: FeatureCategory[];
}

export interface NormalizedOverpassResponseBody {
  query: string;
  geojson: NormalizedFeatureCollection;
  diagnostics: NormalizationDiagnostics;
  raw?: unknown;
}
