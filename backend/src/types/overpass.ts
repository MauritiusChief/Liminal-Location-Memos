import type {
  DbFeatureCategory,
  DbNormalizationDiagnostics,
  SceneFeatureDetail,
} from '../services/sceneTypes.js';
import type {
  ContainedPoiReference,
  NormalizedFeatureCollection,
  OutlineReference,
  RelationReference,
} from '../services/osmNormalization/osmNormalizer.js';
import type { LabeledMicroGrid } from '@/services/scene/microGridPrompt.js';
import type { PolarAngularSpan, PolarCoordinateSample, PolarViewFeature } from '@/services/scene/polarViewObject.js';
import type {
  MarkedPolarViewFeature,
  PolarView,
  PolarViewCluster,
  PolarViewLevel,
} from '@/services/scene/polarViewLabeled.js';

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
}

export interface DbDebugLoadResponseBody {
  query: string;
  diagnostics: DbNormalizationDiagnostics;
  featureSummary: SceneFeatureDetail[];
  microGrid?: LabeledMicroGrid;
  polarView?: PolarView;
}

export type {
  ContainedPoiReference,
  DbFeatureCategory,
  DbNormalizationDiagnostics,
  LabeledMicroGrid,
  MarkedPolarViewFeature,
  NormalizedFeatureCollection,
  OutlineReference,
  PolarAngularSpan,
  PolarCoordinateSample,
  PolarView,
  PolarViewCluster,
  PolarViewFeature,
  PolarViewLevel,
  RelationReference,
  SceneFeatureDetail,
};
