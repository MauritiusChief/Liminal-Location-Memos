import type { NormalizedMicroGrid, NormalizedMicroGridCell } from '../services/overpassGrid.js';
import type { PromptPreview } from '../services/overpassPrompt.js';
import type {
  NormalizedPolarFeatureSummary,
  NormalizedPolarLevel,
  NormalizedPolarView,
  PolarFeatureCategory,
  PolarVisibleTag,
  PolarAngularSpan,
  PolarCoordinateSample,
} from '../services/overpassPolar.js';
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
  polarView?: NormalizedPolarView;
  promptPreview?: PromptPreview;
  raw?: unknown;
}

export type {
  ContainedPoi,
  NormalizedFeatureProperties,
  NormalizedMicroGrid,
  NormalizedMicroGridCell,
  NormalizedPolarFeatureSummary,
  NormalizedPolarLevel,
  NormalizedPolarView,
  PolarFeatureCategory,
  PromptPreview,
  PolarVisibleTag,
  PolarAngularSpan,
  PolarCoordinateSample,
  RelationReference,
};
