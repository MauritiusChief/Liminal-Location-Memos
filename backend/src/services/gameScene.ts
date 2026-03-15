import {
  findNearestCoverageDistanceMeters,
} from './osmRepository.js';
import { syncOverpassCoverage } from './overpass/overpassSync.js';
import {
  buildSummaryFromProjectedScene,
  loadProjectedScene,
  type SummaryPreviewMode,
} from './scene/sceneSummaryService.js';
import type { GamePosition, SceneContext } from '../types/game.js';

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

  await syncOverpassCoverage({
    lat: position.lat,
    lon: position.lon,
    radius: syncRadius,
  });
  return true;
}

/**
 * TODO 解决逻辑漏洞
 * @param position
 * @param radius
 * @returns
 */
export async function loadSceneContext(position: GamePosition, radius = 1000): Promise<SceneContext> {
  const largeScene = await loadProjectedScene({ lat: position.lat, lon: position.lon, radius }, 'game');
  // TODO 不要使用 closure 特性，这会造成理解难度的提升
  const summaryCache = new Map<SummaryPreviewMode, Promise<string>>();

  return {
    position,
    radius,
    diagnostics: largeScene.diagnostics,
    microGrid: largeScene.microGrid,
    polarView: largeScene.polarView,
    getSummary(summaryMode) {
      const cached = summaryCache.get(summaryMode);
      if (cached) {
        return cached;
      }

      const nextSummaryPromise = (async () => {
        if (summaryMode === 'detailed_far_1000' || summaryMode === 'concise_far_1000') {
          return buildSummaryFromProjectedScene(largeScene, summaryMode);
        }

        const smallScene = await loadProjectedScene({ lat: position.lat, lon: position.lon, radius: 200 }, 'game');
        return buildSummaryFromProjectedScene(smallScene, summaryMode);
      })();
      summaryCache.set(summaryMode, nextSummaryPromise);
      return nextSummaryPromise;
    },
  };
}
