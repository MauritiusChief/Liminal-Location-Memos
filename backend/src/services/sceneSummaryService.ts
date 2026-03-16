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

export const SUMMARY_PREVIEW_MODE_CONFIG = {
  detailed_far_1000: { radius: 1000, promptSummaryMode: 'detailed' },
  concise_far_1000: { radius: 1000, promptSummaryMode: 'concise' },
  concise_near_200: { radius: 200, promptSummaryMode: 'concise' },
} as const satisfies Record<string, { radius: number; promptSummaryMode: PromptSummaryMode }>;

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

export function isSummaryPreviewMode(value: unknown): value is SummaryPreviewMode {
  return typeof value === 'string' && Object.hasOwn(SUMMARY_PREVIEW_MODE_CONFIG, value);
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

/**
 * 通过经纬度参数和其他参数，返回完整的提示词
 * @param position
 * @param summaryMode
 * @param profile 暂时没用，未来会决定 SQL 的查询精细度
 * @returns
 */
export async function buildProjectedSceneSummary(
  position: Pick<NormalizedOverpassRequest, 'lat' | 'lon'>,
  summaryMode: SummaryPreviewMode,
  profile: SceneDataProfile,
): Promise<string> {
  const config = SUMMARY_PREVIEW_MODE_CONFIG[summaryMode];
  const scene = await loadProjectedScene({
    lat: position.lat,
    lon: position.lon,
    radius: config.radius,
  }, profile);

  return buildNormalizationPrompt({
    request: scene.request,
    summaryMode: config.promptSummaryMode,
    microGrid: scene.microGrid,
    polarView: scene.polarView,
  });
}
