import KDBush from 'kdbush';
import { around, distance } from 'geokdbush';
import type {
  DescriptionIndexBundle,
  DescriptionIndexPoint,
  GamePosition,
  LargeDescriptionRecord,
  SmallDescriptionRecord,
  GameSaveDocument,
} from '../types/game.js';

type RuntimeDescriptionIndexBundle = DescriptionIndexBundle & {
  largeIndex: KDBush | null;
  smallIndex: KDBush | null;
};

export function buildDescriptionIndex(save: GameSaveDocument): RuntimeDescriptionIndexBundle {
  const largePoints = save.largeDescriptions.map((record) => toPoint(record));
  const smallPoints = save.smallDescriptions.map((record) => toPoint(record));

  return {
    largePoints,
    smallPoints,
    largeIndex: buildPointIndex(largePoints),
    smallIndex: buildPointIndex(smallPoints),
  };
}

export function findNearbyLargeDescriptionCandidates(
  bundle: DescriptionIndexBundle,
  position: GamePosition,
  radiusMeters: number,
): Array<{ record: LargeDescriptionRecord; distanceMeters: number }> {
  return queryAround((bundle as RuntimeDescriptionIndexBundle).largeIndex, bundle.largePoints, position, radiusMeters);
}

export function findNearbySmallDescriptionCandidates(
  bundle: DescriptionIndexBundle,
  position: GamePosition,
  radiusMeters: number,
): Array<{ record: SmallDescriptionRecord; distanceMeters: number }> {
  return queryAround((bundle as RuntimeDescriptionIndexBundle).smallIndex, bundle.smallPoints, position, radiusMeters);
}

function toPoint<TRecord extends LargeDescriptionRecord | SmallDescriptionRecord>(
  record: TRecord,
): DescriptionIndexPoint<TRecord> {
  return {
    id: record.id,
    lon: record.center.lon,
    lat: record.center.lat,
    record,
  };
}

function buildPointIndex<TRecord extends LargeDescriptionRecord | SmallDescriptionRecord>(
  points: DescriptionIndexPoint<TRecord>[],
): KDBush | null {
  if (points.length === 0) {
    return null;
  }

  const index = new KDBush(points.length);
  for (const point of points) {
    index.add(point.lon, point.lat);
  }

  return index.finish();
}

function queryAround<TRecord extends LargeDescriptionRecord | SmallDescriptionRecord>(
  index: KDBush | null,
  points: DescriptionIndexPoint<TRecord>[],
  position: GamePosition,
  radiusMeters: number,
): Array<{ record: TRecord; distanceMeters: number }> {
  if (!index || points.length === 0) {
    return [];
  }

  const ids = around(index, position.lon, position.lat, Infinity, radiusMeters / 1000);
  return ids
    .map((id) => {
      const point = points[id];
      if (!point) {
        return null;
      }

      return {
        record: point.record,
        distanceMeters: distance(position.lon, position.lat, point.lon, point.lat) * 1000,
      };
    })
    .filter((item): item is { record: TRecord; distanceMeters: number } => item !== null)
    .sort((left, right) => left.distanceMeters - right.distanceMeters);
}
