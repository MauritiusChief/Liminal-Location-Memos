import {
  findNearestCoverageDistanceMeters,
} from './osmRepository.js';
import { syncOverpassCoverage } from '@/services/osmNormalization/osmGate.js';
import {
  loadProjectedScene,
} from './sceneSummaryService.js';
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

export async function loadSceneContext(position: GamePosition, radius = 1000): Promise<SceneContext> {
  const largeScene = await loadProjectedScene({ lat: position.lat, lon: position.lon, radius }, 'game');

  return {
    position,
    radius,
    diagnostics: largeScene.diagnostics,
    microGrid: largeScene.microGrid,
    polarView: largeScene.polarView,
  };
}
