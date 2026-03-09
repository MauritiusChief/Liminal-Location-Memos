import type { NormalizedMicroGrid, NormalizedMicroGridCell } from '../services/overpassGrid.js';
import type {
  ContainedPoi,
  NormalizationDiagnostics,
  NormalizedFeatureCollection,
  NormalizedFeatureProperties,
  RelationReference,
} from '../services/overpassNormalization.js';

export interface OverpassResponse {
  data: unknown;
}

export interface NormalizedOverpassRequestBody {
  lat?: number;
  lon?: number;
  radius?: number;
  includeRaw?: boolean;
}

export interface NormalizedOverpassResponseBody {
  query: string;
  geojson: NormalizedFeatureCollection;
  diagnostics: NormalizationDiagnostics;
  microGrid?: NormalizedMicroGrid;
  raw?: unknown;
}

export type {
  ContainedPoi,
  NormalizedFeatureProperties,
  NormalizedMicroGrid,
  NormalizedMicroGridCell,
  RelationReference,
};
