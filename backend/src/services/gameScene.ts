import { overpassJson } from 'overpass-ts';
import type { GameSceneFeatureDetail } from './dbSceneTypes.js';
import { buildNormalizedMicroGrid } from './overpassGrid.js';
import {
  buildNormalizedOverpassQuery,
  convertOverpassToNormalizedFeatures,
  type NormalizedOverpassRequest,
} from './overpassNormalization.js';
import { buildNormalizedPolarView } from './overpassPolar.js';
import { buildNormalizationPrompt } from './overpassPrompt.js';
import {
  fetchGameSceneFeatureDetailsFromDb,
  fetchGameScenePolarFeaturesFromDb,
  fetchMicroGridFromDb,
  findNearestCoverageDistanceMeters,
  syncNormalizedFeaturesToDb,
} from './osmRepository.js';
import type { GamePosition, SceneContext } from '../types/game.js';

function buildFeatureDetailIndex(featureDetails: GameSceneFeatureDetail[]): Map<string, GameSceneFeatureDetail> {
  // 这里沿用 debug 链路的索引方式，避免后续 grid/polar/prompt 再重复扫描数组。
  return new Map(featureDetails.map((feature) => [feature.featureId, feature]));
}

function buildDbDiagnostics(input: {
  featureDetails: GameSceneFeatureDetail[];
  microGrid: ReturnType<typeof buildNormalizedMicroGrid>;
  polarView: ReturnType<typeof buildNormalizedPolarView>;
}) {
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

export async function ensureCoverageForPosition(
  position: GamePosition,
  thresholdMeters = 300,
  syncRadius = 1000,
): Promise<boolean> {
  // 正式链路里的“自动补洞”入口：
  // 如果当前位置距离最近一次 overpass coverage 超过阈值，就同步补齐 1km 数据。
  const nearestDistance = await findNearestCoverageDistanceMeters(position);
  if (nearestDistance !== null && nearestDistance <= thresholdMeters) {
    return false;
  }

  const query = buildNormalizedOverpassQuery({
    lat: position.lat,
    lon: position.lon,
    radius: syncRadius,
  });
  const raw = (await overpassJson(query, {
    endpoint: 'https://overpass-api.de/api/interpreter',
  })) as Parameters<typeof convertOverpassToNormalizedFeatures>[0];
  const features = convertOverpassToNormalizedFeatures(raw);
  await syncNormalizedFeaturesToDb(features, {
    lat: position.lat,
    lon: position.lon,
    radius: syncRadius,
  });
  return true;
}

export async function loadSceneContext(position: GamePosition, radius = 1000): Promise<SceneContext> {
  // 同一位置会同时加载两份 scene：
  // 1. 大场景：1km，用于大描述和宏观上下文
  // 2. 小场景：200m，用于局部描述和移动时的近场判断
  const largeRequest = { lat: position.lat, lon: position.lon, radius };
  const smallRequest = { lat: position.lat, lon: position.lon, radius: 200 };

  const [largeScene, smallScene] = await Promise.all([
    loadProjectedScene(largeRequest),
    loadProjectedScene(smallRequest),
  ]);

  return {
    position,
    radius,
    diagnostics: largeScene.diagnostics,
    microGrid: largeScene.microGrid,
    polarView: largeScene.polarView,
    detailedSummary1000: largeScene.detailedSummary,
    conciseSummary1000: largeScene.conciseSummary,
    conciseSummary200: smallScene.conciseSummary,
  };
}

async function loadProjectedScene(request: NormalizedOverpassRequest): Promise<{
  diagnostics: SceneContext['diagnostics'];
  microGrid: SceneContext['microGrid'];
  polarView: SceneContext['polarView'];
  detailedSummary: string;
  conciseSummary: string;
}> {
  // 这里不重新实现空间投影逻辑，而是直接复用现有 DB-native debug 链路：
  // 取 DB 要素 -> 组装 microGrid/polar -> 生成 prompt summary。
  const [featureDetails, microGridRecords, polarRecords] = await Promise.all([
    fetchGameSceneFeatureDetailsFromDb(request),
    fetchMicroGridFromDb(request),
    fetchGameScenePolarFeaturesFromDb(request),
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
    diagnostics: buildDbDiagnostics({
      featureDetails,
      microGrid,
      polarView,
    }),
    microGrid,
    polarView,
    detailedSummary: buildNormalizationPrompt({
      request,
      summaryMode: 'detailed',
      microGrid,
      polarView,
      featureDetails: featureDetailIndex,
    }),
    conciseSummary: buildNormalizationPrompt({
      request,
      summaryMode: 'concise',
      microGrid,
      polarView,
      featureDetails: featureDetailIndex,
    }),
  };
}
