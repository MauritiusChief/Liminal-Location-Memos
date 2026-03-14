import type { GamePosition } from '../types/game.js';

const EARTH_RADIUS_METERS = 6371000;

export function movePosition(input: {
  position: GamePosition;
  bearingDegrees: number;
  distanceMeters: number;
}): GamePosition {
  const bearingRadians = degreesToRadians(input.bearingDegrees);
  const latRadians = degreesToRadians(input.position.lat);
  const lonRadians = degreesToRadians(input.position.lon);
  const angularDistance = input.distanceMeters / EARTH_RADIUS_METERS;

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

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function radiansToDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

function normalizeLongitude(value: number): number {
  if (value > 180) {
    return value - 360;
  }

  if (value < -180) {
    return value + 360;
  }

  return value;
}
