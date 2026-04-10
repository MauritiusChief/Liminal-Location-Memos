import { degreesToRadians, EARTH_RADIUS_METERS, normalizeBearingDegrees, normalizeLongitude, radiansToDegrees } from "../geometry.js";
import { GameState, Position } from "./gameSessionStore.js";


/**
 * 应用移动玩家工具
 * @param state 游戏状态
 * @param args 尚未解析的 tool call 参数
 */
export function applyMovePlayerTool(
  state: GameState,
  args: any
): void {

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

  console.log(`[${new Date().toISOString()}] 移动玩家工具完成，绝对方位 ${actualDirectionDegrees}° ${distanceMeters}m`);
  state.playerPosition = nextPosition;
  state.playerOrientation = normalizeBearingDegrees(bearingDegrees);
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
function movePosition(
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