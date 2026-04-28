import { degreesToRadians, EARTH_RADIUS_METERS, normalizeBearingDegrees, normalizeLongitude, radiansToDegrees } from "../geometry.js";
import { findContainingBuildingFeatureId } from "./buildingRecord.js";
import { GameState, Position } from "./gameSessionStore.js";

/**
 * 应用移动玩家工具
 * @param state 游戏状态
 * @param args 尚未解析的 tool call 参数
 */
export async function applyMovePlayerTool(
  state: GameState,
  args: any,
  isMoveIntendedIndoor?: boolean,
): Promise<void> {

  const bearingDegrees = Number(args.bearingDegrees);
  const distanceMeters = Number(args.distanceMeters);
  if (!Number.isFinite(bearingDegrees) || !Number.isFinite(distanceMeters) || distanceMeters < 0) {
    return;
  }
  const actualDirectionDegrees = state.playerOrientation + bearingDegrees;
  const nextPosition = movePosition(state.playerPosition, actualDirectionDegrees, distanceMeters);
  if (!nextPosition) {
    return;
  }

  const adjustedPosition = isMoveIntendedIndoor !== undefined
    ? await adjustMoveDestinationForIntent(nextPosition, actualDirectionDegrees, isMoveIntendedIndoor)
    : nextPosition;
  console.log(`[${new Date().toISOString()}] 移动玩家工具完成，绝对方位 ${actualDirectionDegrees}° ${distanceMeters}m`);
  state.playerPosition = adjustedPosition;
  state.playerOrientation = normalizeBearingDegrees(bearingDegrees);
}

/**
 * 生成目的地附近的候选点。
 *
 * 候选顺序为原始目的地、前方近到远、后方近到远；
 * 同距离时优先前方，以便尽量贴近移动意图。
 */
export function listIndoorAdjustmentCandidates(
  destination: Position,
  bearingDegrees: number,
): Position[] {
  const candidates = [destination];

  // 5m 步长，探测前后 30m 范围
  for (let offsetMeters = 5; offsetMeters <= 30; offsetMeters += 5) {
    candidates.push(movePosition(destination, bearingDegrees, offsetMeters));
    candidates.push(movePosition(destination, bearingDegrees + 180, offsetMeters));
  }

  return candidates;
}

/**
 * 根据实际的室内/室外意图微调目的地位置
 * @param destination
 * @param bearingDegrees
 * @param isMoveIntendedIndoor
 * @returns 微调过的与意图一致的目的地位置
 */
async function adjustMoveDestinationForIntent(
  destination: Position,
  bearingDegrees: number,
  isMoveIntendedIndoor: boolean,
): Promise<Position> {
  const candidates = listIndoorAdjustmentCandidates(destination, bearingDegrees);
  for (const candidate of candidates) {
    const isIndoor = Boolean(await findContainingBuildingFeatureId(candidate));
    if (isIndoor === isMoveIntendedIndoor) {
      return candidate;
    }
  }

  return destination;
}

/**
 * 根据“起点经纬度 + 朝向 + 距离”计算移动后的新经纬度。
 *
 * 这里使用球面坐标公式，而不是把经纬度简单当作平面坐标，
 * 这样在地理位置计算上更稳妥。
 * @param position
 * @param bearingDegrees 以北面为 0 度、顺时针增加的绝对朝向
 * @param distanceMeters
 * @returns
 */
export function movePosition(
  position: Position,
  bearingDegrees: number,
  distanceMeters: number,
): Position {
  const bearingRadians = degreesToRadians(bearingDegrees);
  const latRadians = degreesToRadians(position.lat);
  const lonRadians = degreesToRadians(position.lon);
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;

  const nextLat = Math.asin(
    Math.sin(latRadians) * Math.cos(angularDistance)
      + Math.cos(latRadians) * Math.sin(angularDistance) * Math.cos(bearingRadians),
  );
  const nextLon = lonRadians + Math.atan2(
    Math.sin(bearingRadians) * Math.sin(angularDistance) * Math.cos(latRadians),
    Math.cos(angularDistance) - Math.sin(latRadians) * Math.sin(nextLat),
  );

  return {
    lat: radiansToDegrees(nextLat),
    lon: normalizeLongitude(radiansToDegrees(nextLon)),
  };
}
