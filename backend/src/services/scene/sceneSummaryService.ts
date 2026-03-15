import { buildNormalizedMicroGrid } from '../overpassGrid.js';
import { type NormalizedOverpassRequest } from '../overpassNormalization.js';
import { buildNormalizedPolarView } from '../overpassPolar.js';
import { buildNormalizationPrompt, type PromptSummaryMode } from '../overpassPrompt.js';
import {
  fetchSceneFeatureDetailsFromDb,
  fetchMicroGridFromDb,
  fetchScenePolarFeaturesFromDb,
  type SceneDataProfile,
} from '../osmRepository.js';
import type {
  DbNormalizationDiagnostics,
  SceneFeatureDetail,
} from './sceneTypes.js';

export type SummaryPreviewMode = 'detailed_far_1000' | 'concise_far_1000' | 'concise_near_200';

export interface ProjectedScene<TFeatureDetail extends SceneFeatureDetail> {
  request: NormalizedOverpassRequest;
  diagnostics: DbNormalizationDiagnostics;
  featureDetails: TFeatureDetail[];
  featureDetailIndex: Map<string, TFeatureDetail>;
  microGrid: ReturnType<typeof buildNormalizedMicroGrid>;
  polarView: ReturnType<typeof buildNormalizedPolarView>;
}

/**
 * TODO 搞清楚具体用处
 * @param featureDetails
 * @returns
 */
function buildFeatureDetailIndex<TFeatureDetail extends SceneFeatureDetail>(featureDetails: TFeatureDetail[]): Map<string, TFeatureDetail> {
  return new Map(featureDetails.map((feature) => [feature.featureId, feature]));
}

function buildDbDiagnostics(input: {
  featureDetails: SceneFeatureDetail[];
  microGrid: ReturnType<typeof buildNormalizedMicroGrid>;
  polarView: ReturnType<typeof buildNormalizedPolarView>;
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
    populatedMicroGridCellCount: input.microGrid.enabled
      ? input.microGrid.cells.flat().filter((cell) => cell.sourceFeatureIds.length > 0).length
      : 0,
    polarFeatureCount: input.polarView.levels.reduce((count, level) => count + level.features.length, 0),
  };
}


/**
 * TODO 改成一个 object
 * @param summaryMode
 * @returns
 */
function toPromptBuildConfig(summaryMode: SummaryPreviewMode): {
  radius: number;
  promptSummaryMode: PromptSummaryMode;
} {
  switch (summaryMode) {
    case 'detailed_far_1000':
      return { radius: 1000, promptSummaryMode: 'detailed' };
    case 'concise_far_1000':
      return { radius: 1000, promptSummaryMode: 'concise' };
    case 'concise_near_200':
      return { radius: 200, promptSummaryMode: 'concise' };
  }
}

/**
 * TODO 改成一个 object
 * @param summaryMode
 * @returns
 */
export function resolveSceneContextSummaryMode(summaryMode: 'concise_near' | 'concise_far' | 'detailed_far'): SummaryPreviewMode {
  switch (summaryMode) {
    case 'concise_near':
      return 'concise_near_200';
    case 'concise_far':
      return 'concise_far_1000';
    case 'detailed_far':
      return 'detailed_far_1000';
  }
}

export async function loadProjectedScene(
  request: NormalizedOverpassRequest,
  profile: SceneDataProfile,
): Promise<ProjectedScene<SceneFeatureDetail>> {
  const [featureDetails, microGridRecords, polarRecords] = await Promise.all([
    fetchSceneFeatureDetailsFromDb(request, profile),
    fetchMicroGridFromDb(request),
    fetchScenePolarFeaturesFromDb(request, profile),
  ]);
  const featureDetailIndex = buildFeatureDetailIndex(featureDetails);
  const microGrid = buildNormalizedMicroGrid({
    request,
    cells: microGridRecords,
    featureDetails: featureDetailIndex,
  });
  const polarView = buildNormalizedPolarView({
    records: polarRecords,
    featureDetails: featureDetailIndex,
    request,
  });

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

export function buildSummaryFromProjectedScene<TFeatureDetail extends SceneFeatureDetail>(
  scene: ProjectedScene<TFeatureDetail>,
  summaryMode: SummaryPreviewMode,
): string {
  const config = toPromptBuildConfig(summaryMode);

  return buildNormalizationPrompt({
    request: scene.request,
    summaryMode: config.promptSummaryMode,
    microGrid: scene.microGrid,
    polarView: scene.polarView,
  });
}

/**
 * 注：单纯用来 debug `buildNormalizationPrompt` 函数用
 * @param position
 * @param summaryMode
 * @returns
 */
export async function buildDebugSummaryPreview(
  position: Pick<NormalizedOverpassRequest, 'lat' | 'lon'>,
  summaryMode: SummaryPreviewMode,
): Promise<string> {
  const config = toPromptBuildConfig(summaryMode);
  const scene = await loadProjectedScene({
    lat: position.lat,
    lon: position.lon,
    radius: config.radius,
  }, 'debug');

  return buildSummaryFromProjectedScene(scene, summaryMode);
}
