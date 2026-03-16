import type {
  DbFeatureCategory,
  DbNormalizationDiagnostics,
  SceneFeatureDetail,
} from '../services/scene/sceneTypes.js';
import type { NormalizedMicroGrid, NormalizedMicroGridCell } from '../services/overpassGrid.js';
import type { SummaryPreviewMode } from '../services/scene/sceneSummaryService.js';
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
  raw?: unknown;
}

export interface DbDebugLoadResponseBody {
  query: string;
  diagnostics: DbNormalizationDiagnostics;
  featureSummary: SceneFeatureDetail[];
  microGrid?: NormalizedMicroGrid;
  polarView?: NormalizedPolarView;
}

export interface SummaryPreviewRequestBody {
  lat?: number;
  lon?: number;
  summaryMode?: SummaryPreviewMode;
}

export interface SummaryPreviewResponseBody {
  summaryMode: SummaryPreviewMode;
  summaryText: string;
}

export type {
  ContainedPoi,
  DbFeatureCategory,
  DbNormalizationDiagnostics,
  NormalizedFeatureProperties,
  NormalizedMicroGrid,
  NormalizedMicroGridCell,
  NormalizedPolarFeatureSummary,
  NormalizedPolarLevel,
  NormalizedPolarView,
  PolarFeatureCategory,
  PolarVisibleTag,
  PolarAngularSpan,
  PolarCoordinateSample,
  PolarDirectionCluster,
  RelationReference,
  SceneFeatureDetail,
};
