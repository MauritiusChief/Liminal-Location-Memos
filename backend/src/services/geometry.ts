import { Position } from "./gameSystem/gameSessionStore.js";

export const EARTH_RADIUS_METERS = 6371000

export function distanceBetweenCoordinates(
  left: [number, number],
  right: [number, number],
): number {
  const earthRadiusMeters = 6_371_000;
  const [leftLon, leftLat] = left;
  const [rightLon, rightLat] = right;

  const deltaLat = degreesToRadians(rightLat - leftLat);
  const deltaLon = degreesToRadians(rightLon - leftLon);
  const leftLatRadians = degreesToRadians(leftLat);
  const rightLatRadians = degreesToRadians(rightLat);

  const haversine =
    Math.sin(deltaLat / 2) * Math.sin(deltaLat / 2) +
    Math.cos(leftLatRadians) *
      Math.cos(rightLatRadians) *
      Math.sin(deltaLon / 2) *
      Math.sin(deltaLon / 2);

  const angularDistance = 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
  return earthRadiusMeters * angularDistance;
}

/**
 * 计算两个经纬度点之间的直线距离，单位为米。
 */
export function distanceToPosition(left: Position, right: Position): number {
  return distanceBetweenCoordinates(
    [left.lon, left.lat],
    [right.lon, right.lat],
  );
}

export function bearingBetweenCoordinates(
  origin: [number, number],
  target: [number, number],
): number {
  const [originLon, originLat] = origin;
  const [targetLon, targetLat] = target;
  const originLatRadians = degreesToRadians(originLat);
  const targetLatRadians = degreesToRadians(targetLat);
  const deltaLonRadians = degreesToRadians(targetLon - originLon);

  const y = Math.sin(deltaLonRadians) * Math.cos(targetLatRadians);
  const x =
    Math.cos(originLatRadians) * Math.sin(targetLatRadians) -
    Math.sin(originLatRadians) * Math.cos(targetLatRadians) * Math.cos(deltaLonRadians);

  return normalizeBearingDegrees(radiansToDegrees(Math.atan2(y, x)));
}

export function circularAngleDeltaDegrees(fromDegrees: number, toDegrees: number): number {
  return normalizeBearingDegrees(toDegrees - fromDegrees);
}

export function normalizeBearingDegrees(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

export function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

export function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

export function normalizeLongitude(value: number): number {
  if (value > 180) {
    return value - 360;
  }

  if (value < -180) {
    return value + 360;
  }

  return value;
}

export function computeCircularMeanDegrees(values: number[]): number {
  const { sinSum, cosSum } = values.reduce(
    (accumulator, value) => {
      const radians = (value * Math.PI) / 180;
      return {
        sinSum: accumulator.sinSum + Math.sin(radians),
        cosSum: accumulator.cosSum + Math.cos(radians),
      };
    },
    { sinSum: 0, cosSum: 0 },
  );
  const radians = Math.atan2(sinSum, cosSum);
  return normalizeBearingDegrees((radians * 180) / Math.PI);
}

/**
 * 基于局部东/北偏移量，把某个经纬度点投影到新的经纬度位置。
 */
export function projectPositionByMeters(
  origin: Position,
  eastMeters: number,
  northMeters: number,
): Position {
  const distanceMeters = Math.hypot(eastMeters, northMeters);
  if (distanceMeters === 0) {
    return { ...origin };
  }

  const bearingDegrees = normalizeBearingDegrees(radiansToDegrees(Math.atan2(eastMeters, northMeters)));
  const bearingRadians = degreesToRadians(bearingDegrees);
  const latRadians = degreesToRadians(origin.lat);
  const lonRadians = degreesToRadians(origin.lon);
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
