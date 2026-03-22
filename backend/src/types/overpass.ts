import type {
  DbFeatureCategory,
  DbNormalizationDiagnostics,
  SceneFeatureDetail,
} from '../services/sceneTypes.js';
import type { NormalizedMicroGrid, NormalizedMicroGridCell } from '../services/overpassGrid.js';
import type { SummaryPreviewStyle } from '../services/sceneSummaryService.js';
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
  OutlineReference,
  RelationReference,
} from '../services/overpassNormalization.js';
import { NormalizedFeatureCollection } from '@/services/osmNormalization/osmNormalizer.js';

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
  radius?: number;
  summaryStyle?: SummaryPreviewStyle;
}

export interface SummaryPreviewResponseBody {
  radius: number;
  summaryStyle: SummaryPreviewStyle;
  summaryText: string;
}

export type {
  ContainedPoi,
  DbFeatureCategory,
  DbNormalizationDiagnostics,
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
  OutlineReference,
  RelationReference,
  SceneFeatureDetail,
};
