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

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}
