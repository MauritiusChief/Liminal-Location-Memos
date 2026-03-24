import type { RangedPosition } from '../routes/apiTypes.js';
import {
  type SceneDataProfile,
} from './osmRepository.js';
import type {
  DbNormalizationDiagnostics,
  SceneFeatureDetail,
} from './sceneTypes.js';
import { buildLabeledMicroGrid } from './scene/microGridPrompt.js';
import { buildScenePrompt } from './scene/scenePrompt.js';
import { fetchSceneFeatureDetailsFromDb } from './scene/sceneUtilFeatureDetail.js';
import { buildMicroGrid, fetchMicroGridFromDb } from './scene/microGridObject.js';
import { buildPolarViewFeature, fetchScenePolarFeaturesFromDb } from './scene/polarViewObject.js';
import {
  applyClusterMarkder,
  applyLevelMarker,
  attachLabelBasedOnLevel,
  buildPolarView,
  type PolarView,
} from './scene/polarViewLabeled.js';

export const SUMMARY_PREVIEW_MODE_CONFIG = {
  detailed_far_1000: { radius: 1000 },
  concise_far_1000: { radius: 1000 },
  concise_near_200: { radius: 200 },
} as const satisfies Record<string, { radius: number }>;

export type SummaryPreviewMode = keyof typeof SUMMARY_PREVIEW_MODE_CONFIG;

export const SUMMARY_PREVIEW_MODE_VALUES = Object.keys(SUMMARY_PREVIEW_MODE_CONFIG) as SummaryPreviewMode[];
export const SUMMARY_PREVIEW_MODE_VALUE_LIST = SUMMARY_PREVIEW_MODE_VALUES.join(', ');

export const SCENE_CONTEXT_SUMMARY_MODE_TO_PREVIEW_MODE = {
  concise_near: 'concise_near_200',
  concise_far: 'concise_far_1000',
  detailed_far: 'detailed_far_1000',
} as const satisfies Record<string, SummaryPreviewMode>;

export type SceneContextSummaryMode = keyof typeof SCENE_CONTEXT_SUMMARY_MODE_TO_PREVIEW_MODE;

export const DEFAULT_LARGE_DESCRIPTION_SUMMARY_MODE: SummaryPreviewMode = 'concise_far_1000';
export const DEFAULT_SMALL_DESCRIPTION_SUMMARY_MODE: SummaryPreviewMode = 'concise_near_200';

export interface ProjectedScene<TFeatureDetail extends SceneFeatureDetail> {
  request: RangedPosition;
  diagnostics: DbNormalizationDiagnostics;
  featureDetails: TFeatureDetail[];
  featureDetailIndex: Map<string, TFeatureDetail>;
  microGrid: ReturnType<typeof buildLabeledMicroGrid>;
  polarView: PolarView;
}

function buildFeatureDetailIndex<TFeatureDetail extends SceneFeatureDetail>(featureDetails: TFeatureDetail[]): Map<string, TFeatureDetail> {
  return new Map(featureDetails.map((feature) => [feature.featureId, feature]));
}

function countPolarFeatures(polarView: PolarView): number {
  return polarView.levels.reduce(
    (count, level) => count + level.clusters.reduce((clusterCount, cluster) => clusterCount + cluster.features.length, 0),
    0,
  );
}

function buildDbDiagnostics(input: {
  featureDetails: SceneFeatureDetail[];
  microGrid: ReturnType<typeof buildLabeledMicroGrid>;
  polarView: PolarView;
}): DbNormalizationDiagnostics {
  const featureCountsByCategory = input.featureDetails.reduce<Record<'building' | 'poi' | 'line' | 'area', number>>(
    (counts, feature) => {
      counts[feature.category] += 1;
      return counts;
    },
    { building: 0, poi: 0, line: 0, area: 0 },
  );

  return {
    featureCountsByCategory,
    totalFeatures: input.featureDetails.length,
    populatedMicroGridCellCount: input.microGrid.cells.flat().filter((cell) => cell.sourceFeatureIds.length > 0).length,
    polarFeatureCount: countPolarFeatures(input.polarView),
  };
}

function buildScenePolarView(
  request: RangedPosition,
  featureDetailIndex: ReadonlyMap<string, SceneFeatureDetail>,
  polarRecords: Awaited<ReturnType<typeof fetchScenePolarFeaturesFromDb>>,
): PolarView {
  const polarFeatures = buildPolarViewFeature(request, polarRecords, featureDetailIndex);
  const levelMarked = applyLevelMarker(polarFeatures);
  const labeled = attachLabelBasedOnLevel(levelMarked);
  const clusterMarked = applyClusterMarkder(labeled);
  return buildPolarView(request, clusterMarked);
}

export function isSummaryPreviewMode(value: unknown): value is SummaryPreviewMode {
  return typeof value === 'string' && Object.hasOwn(SUMMARY_PREVIEW_MODE_CONFIG, value);
}

export async function loadProjectedScene(
  request: RangedPosition,
  profile: SceneDataProfile,
): Promise<ProjectedScene<SceneFeatureDetail>> {
  const [featureDetails, microGridRecords, polarRecords] = await Promise.all([
    fetchSceneFeatureDetailsFromDb(request, profile),
    fetchMicroGridFromDb(request),
    fetchScenePolarFeaturesFromDb(request, profile),
  ]);
  const featureDetailIndex = buildFeatureDetailIndex(featureDetails);
  const microGrid = buildLabeledMicroGrid(buildMicroGrid(
    request,
    microGridRecords,
    featureDetailIndex,
  ));
  const polarView = buildScenePolarView(request, featureDetailIndex, polarRecords);

  return {
    request,
    diagnostics: buildDbDiagnostics({
      featureDetails,
      microGrid,
      polarView,
    }),
    featureDetails,
    featureDetailIndex,
    microGrid,
    polarView,
  };
}

export async function buildProjectedSceneSummary(
  position: Pick<RangedPosition, 'lat' | 'lon'>,
  options: { radius: number },
  profile: SceneDataProfile,
): Promise<string> {
  const scene = await loadProjectedScene({
    lat: position.lat,
    lon: position.lon,
    radius: options.radius,
  }, profile);

  return buildScenePrompt(
    scene.request,
    scene.microGrid,
    scene.polarView,
  );
}

export async function buildProjectedSceneSummaryByMode(
  position: Pick<RangedPosition, 'lat' | 'lon'>,
  summaryMode: SummaryPreviewMode,
  profile: SceneDataProfile,
): Promise<string> {
  const config = SUMMARY_PREVIEW_MODE_CONFIG[summaryMode];
  return buildProjectedSceneSummary(
    position,
    {
      radius: config.radius,
    },
    profile,
  );
}
