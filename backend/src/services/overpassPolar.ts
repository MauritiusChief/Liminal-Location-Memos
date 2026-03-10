import type { Geometry } from 'geojson';
import {
  bearingBetweenCoordinates,
  circularAngleDeltaDegrees,
  distanceBetweenCoordinates,
  extractAllCoordinates,
  getBoundingBoxCenter,
} from './overpassGeometry.js';
import type { ContainedPoi, NormalizedFeature } from './overpassNormalization.js';

export interface PolarCoordinateSample {
  coordinate: [number, number];
  distanceMeters: number;
  bearingDegrees: number;
}

export interface PolarAngularSpan {
  leftPoint: PolarCoordinateSample;
  rightPoint: PolarCoordinateSample;
  angleWidthDegrees: number;
}

export interface NormalizedPolarFeatureSummary {
  featureId: string;
  osmType: string;
  osmId: number;
  geometryType: string;
  displayLabel: string;
  level: 1 | 2 | 3;
  nearestPoint: PolarCoordinateSample;
  farthestPoint: PolarCoordinateSample;
  centerPoint: PolarCoordinateSample;
  widestSpan: PolarAngularSpan;
}

export interface NormalizedPolarLevel {
  level: 1 | 2 | 3;
  distanceRangeMeters: [number, number];
  features: NormalizedPolarFeatureSummary[];
}

export interface NormalizedPolarView {
  center: {
    lat: number;
    lon: number;
  };
  maxRadiusMeters: 1000;
  levels: NormalizedPolarLevel[];
}

const MAX_POLAR_RADIUS_METERS = 1000 as const;
const POLAR_LEVELS: Array<{ level: 1 | 2 | 3; minExclusive: number; maxInclusive: number }> = [
  { level: 1, minExclusive: 30, maxInclusive: 100 },
  { level: 2, minExclusive: 100, maxInclusive: 300 },
  { level: 3, minExclusive: 300, maxInclusive: 1000 },
];
const POI_TAG_KEYS = ['shop', 'amenity', 'office', 'tourism', 'leisure', 'craft', 'healthcare'] as const;
const LINE_TAG_KEYS = ['highway', 'railway', 'waterway'] as const;
const AREA_TAG_KEYS = ['landuse', 'natural', 'leisure', 'amenity'] as const;

// polar 视图只消费 normalized features；
// 它的任务不是重建几何，而是压缩出“对叙述最有用的视角信息”。
export function buildNormalizedPolarView(
  features: NormalizedFeature[],
  request: { lat: number; lon: number },
): NormalizedPolarView {
  const origin: [number, number] = [request.lon, request.lat];
  const summaries = features.flatMap((feature) => {
    const summary = buildPolarFeatureSummary(feature, origin);
    return summary ? [summary] : [];
  });

  const levels = POLAR_LEVELS.map<NormalizedPolarLevel>((definition) => ({
    level: definition.level,
    distanceRangeMeters: [definition.minExclusive, definition.maxInclusive],
    features: summaries
      .filter((summary) => summary.level === definition.level)
      .sort((left, right) => left.centerPoint.distanceMeters - right.centerPoint.distanceMeters || left.osmId - right.osmId),
  }));

  return {
    center: {
      lat: request.lat,
      lon: request.lon,
    },
    maxRadiusMeters: MAX_POLAR_RADIUS_METERS,
    levels,
  };
}

function buildPolarFeatureSummary(
  feature: NormalizedFeature,
  origin: [number, number],
): NormalizedPolarFeatureSummary | null {
  const clippedCoordinates = clipFeatureCoordinatesToRadius(feature.geometry, origin, MAX_POLAR_RADIUS_METERS);
  if (clippedCoordinates.length === 0) {
    return null;
  }

  const samples = clippedCoordinates.map((coordinate) => toPolarCoordinateSample(origin, coordinate));
  const nearestPoint = selectNearestSample(samples);
  const farthestPoint = selectFarthestSample(samples);
  const centerCoordinate = feature.geometry.type === 'Point' ? clippedCoordinates[0] || null : getBoundingBoxCenter(clippedCoordinates);
  if (!nearestPoint || !farthestPoint || !centerCoordinate) {
    return null;
  }

  const centerPoint = toPolarCoordinateSample(origin, centerCoordinate);
  const level = classifyPolarLevel(centerPoint.distanceMeters);
  if (!level) {
    return null;
  }

  return {
    featureId: toFeatureId(feature),
    osmType: feature.properties.osmType,
    osmId: feature.properties.osmId,
    geometryType: feature.geometry.type,
    displayLabel: getPolarDisplayLabel(feature),
    level,
    nearestPoint,
    farthestPoint,
    centerPoint,
    widestSpan: computeWidestSpan(feature.geometry, samples),
  };
}

function clipFeatureCoordinatesToRadius(
  geometry: Geometry,
  origin: [number, number],
  maxRadiusMeters: number,
): [number, number][] {
  return extractAllCoordinates(geometry).filter((coordinate) => distanceBetweenCoordinates(origin, coordinate) <= maxRadiusMeters);
}

function toPolarCoordinateSample(origin: [number, number], coordinate: [number, number]): PolarCoordinateSample {
  return {
    coordinate,
    distanceMeters: distanceBetweenCoordinates(origin, coordinate),
    bearingDegrees: bearingBetweenCoordinates(origin, coordinate),
  };
}

function selectNearestSample(samples: PolarCoordinateSample[]): PolarCoordinateSample | null {
  return samples.reduce<PolarCoordinateSample | null>((selected, sample) => {
    if (!selected || sample.distanceMeters < selected.distanceMeters) {
      return sample;
    }
    return selected;
  }, null);
}

function selectFarthestSample(samples: PolarCoordinateSample[]): PolarCoordinateSample | null {
  return samples.reduce<PolarCoordinateSample | null>((selected, sample) => {
    if (!selected || sample.distanceMeters > selected.distanceMeters) {
      return sample;
    }
    return selected;
  }, null);
}

// widest span 体现“这个要素从查询点看占据了多宽的视野角”。
// 实现上通过寻找 bearing 序列里的最大 gap，反推出最小包络角宽。
// 这里的 leftPoint / rightPoint 表示“可见扇区两侧的边界点”，
// 它们本身不是前端 SVG 路径的天然 start/end sweep 参数，真正可信的角宽以 angleWidthDegrees 为准。
function computeWidestSpan(geometry: Geometry, samples: PolarCoordinateSample[]): PolarAngularSpan {
  if (geometry.type === 'Point' || samples.length === 1) {
    const point = samples[0]!;
    return {
      leftPoint: point,
      rightPoint: point,
      angleWidthDegrees: 0,
    };
  }

  const sortedSamples = [...samples].sort((left, right) => left.bearingDegrees - right.bearingDegrees);
  let largestGap = -1;
  let gapStartIndex = 0;

  for (let index = 0; index < sortedSamples.length; index += 1) {
    const current = sortedSamples[index]!;
    const next = sortedSamples[(index + 1) % sortedSamples.length]!;
    const gap = circularAngleDeltaDegrees(current.bearingDegrees, next.bearingDegrees);

    if (gap > largestGap) {
      largestGap = gap;
      gapStartIndex = index;
    }
  }

  const rightPoint = sortedSamples[gapStartIndex]!;
  const leftPoint = sortedSamples[(gapStartIndex + 1) % sortedSamples.length]!;

  return {
    leftPoint,
    rightPoint,
    angleWidthDegrees: 360 - largestGap,
  };
}

function classifyPolarLevel(distanceMeters: number): 1 | 2 | 3 | null {
  const match = POLAR_LEVELS.find(
    (definition) => distanceMeters > definition.minExclusive && distanceMeters <= definition.maxInclusive,
  );
  return match ? match.level : null;
}

function getPolarDisplayLabel(feature: NormalizedFeature): string {
  const name = trimTagValue(feature.properties.tags.name);
  if (name) {
    return name;
  }

  const containedPois = getDisplayableContainedPois(feature.properties.containedPois);
  if (containedPois.length > 0) {
    return containedPois.map((poi) => getContainedPoiDisplayLabel(poi)).join('&');
  }

  const tags = feature.properties.tags;
  if (typeof tags.building === 'string') {
    return trimTagValue(tags.building) || 'building';
  }

  for (const key of POI_TAG_KEYS) {
    const value = trimTagValue(tags[key]);
    if (value) {
      return value;
    }
  }

  for (const key of LINE_TAG_KEYS) {
    const value = trimTagValue(tags[key]);
    if (value) {
      return value;
    }
  }

  for (const key of AREA_TAG_KEYS) {
    const value = trimTagValue(tags[key]);
    if (value) {
      return value;
    }
  }

  return `${feature.properties.osmType}/${feature.properties.osmId}`;
}

function getDisplayableContainedPois(containedPois: ContainedPoi[] | undefined): ContainedPoi[] {
  if (!containedPois || containedPois.length === 0) {
    return [];
  }

  return [...containedPois].sort((left, right) => left.osmId - right.osmId).slice(0, 2);
}

function getContainedPoiDisplayLabel(poi: ContainedPoi): string {
  return trimTagValue(poi.tags.name) || trimTagValue(poi.tags.brand) || getPrimaryPoiLabel(poi.tags) || 'poi';
}

function getPrimaryPoiLabel(tags: Record<string, string>): string | null {
  for (const key of POI_TAG_KEYS) {
    const value = trimTagValue(tags[key]);
    if (value) {
      return value;
    }
  }

  return null;
}

function trimTagValue(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toFeatureId(feature: NormalizedFeature): string {
  return feature.id ? String(feature.id) : `${feature.properties.osmType}/${feature.properties.osmId}`;
}
