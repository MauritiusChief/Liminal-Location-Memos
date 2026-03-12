import type {
  DbFeatureCategory,
  DbFeatureDetail,
  DbNormalizationDiagnostics,
} from '../services/dbSceneTypes.js';
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
  PolarDirectionCluster,
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

export interface DbDebugLoadResponseBody {
  query: string;
  diagnostics: DbNormalizationDiagnostics;
  featureSummary: DbFeatureDetail[];
  microGrid?: NormalizedMicroGrid;
  polarView?: NormalizedPolarView;
  promptPreview?: PromptPreview;
}

export type {
  ContainedPoi,
  DbFeatureCategory,
  DbFeatureDetail,
  DbNormalizationDiagnostics,
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
  PolarDirectionCluster,
  RelationReference,
};
