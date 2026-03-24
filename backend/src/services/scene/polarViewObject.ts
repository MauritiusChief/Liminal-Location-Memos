import { query } from "@/db/client.js";
import { loadServiceSql } from "@/db/sqlLoader.js";
import { RangedPosition } from "@/routes/apiTypes.js";
import {
  bearingBetweenCoordinates,
  circularAngleDeltaDegrees,
  distanceBetweenCoordinates,
  normalizeBearingDegrees,
} from "../geometry.js";
import { SceneFeatureDetail } from "./sceneUtilFeatureDetail.js";

/**
 * 与 SQL 查询结果表一致的扁平类型
 */
type DbPolarViewFeatureTabelRow = {
  feature_id: string;
  osm_type: string;
  osm_id: number;
  category: "building" | "area" | "poi" | "line";
  geometry_type: string;
  sample_coordinates: Array<[number, number]> | null;
  center_coordinate: [number, number] | null;
};

/**
 * 采样过的用于 Polar View 的地物。
 * 此处采样指的是采集所有点的坐标、计算中心点坐标、查找线类地物的样本坐标
 */
export interface SampledPolarViewFeature {
  featureId: string;
  osmId: number;
  category: "building" | "area" | "poi" | "line";
  geometryType: string;
  osmType?: string;
  // 该地物所有的坐标点
  // 如果是 line，这个也 sampleCoordinates 也负责计算线类专属属性
  sampleCoordinates: [number, number][];
  // 该地物的中心坐标点
  centerCoordinate: [number, number] | null;
}

export interface PolarCoordinateSample {
  coordinate: [number, number];
  distanceMeters: number;
  bearingDegrees: number;
}
export interface PolarAngularSpan {
  clockwiseEarlyPoint: PolarCoordinateSample;
  clockwiseLatePoint: PolarCoordinateSample;
  angleWidthDegrees: number;
}

/**
 * 基于 SampledPolarViewFeature 计算的，理论上可直接用于 Polar View 的信息
 */
export interface PolarViewFeature {
  featureId: string;
  osmId: number;
  category: "building" | "area" | "poi" | "line";
  geometryType: string;
  osmType?: string;
  featureDetail: SceneFeatureDetail;
  centerPoint: PolarCoordinateSample;
  widestSpan: PolarAngularSpan;
  nearestPoint: PolarCoordinateSample;
  farthestPoint: PolarCoordinateSample;
  // 线类地物
  linePoints?: PolarCoordinateSample[];
  linePath?: PolarCoordinateSample[];
  orientationDegrees?: number;
}

//#region 主函数

const fetchScenePolarFeaturesFromDbSqlPromise = loadServiceSql('osmRepository/fetchScenePolarFeaturesFromDb.sql');

/**
 * polar 的 DB 查询只做“取候选 + 裁剪几何 + 导出坐标样本”。
 * bearing、群聚、视野角宽这类叙述性压缩继续保留在 TS，便于调参和阅读。
 * @param request
 * @param _profile 暂时没用，未来可区分 debug 模式和常规模式的 SQL
 * @returns
 */
export async function fetchScenePolarFeaturesFromDb(
  request: RangedPosition,
  _profile: string = 'debug',
): Promise<SampledPolarViewFeature[]> {
  const radiusMeters = Math.min(request.radius, 1000);

  const sql = await fetchScenePolarFeaturesFromDbSqlPromise;
  const result = await query<DbPolarViewFeatureTabelRow>(
    sql,
    [request.lon, request.lat, radiusMeters],
  );

  return result.rows.map((row) => ({
    featureId: row.feature_id,
    osmType: row.osm_type || undefined,
    osmId: row.osm_id,
    category: row.category,
    geometryType: row.geometry_type,
    sampleCoordinates: (row.sample_coordinates || []).map((pair) => [Number(pair[0]), Number(pair[1])]),
    centerCoordinate: row.center_coordinate
      ? [Number(row.center_coordinate[0]), Number(row.center_coordinate[1])]
      : null,
  }));
}

/**
 * 组装可用来打标签的扁平结构，精炼 Samples Coordinates 为真正所需要的数据：
 * 最远点、最近点、视角宽度等等
 * @param request
 * @param polarViewFeature
 */
export function buildPolarViewFeature(
  request: RangedPosition,
  polarViewFeatures: SampledPolarViewFeature[],
  featureDetails: ReadonlyMap<string, SceneFeatureDetail>,
): PolarViewFeature[] {
  const origin: [number, number] = [request.lon, request.lat];

  return polarViewFeatures.flatMap((polarViewFeature) => {
    const samples = dedupeConsecutiveCoordinates(polarViewFeature.sampleCoordinates);
    const centerCoordinate = polarViewFeature.centerCoordinate || samples[0] || null;
    if (samples.length === 0 || !centerCoordinate) {
      return [];
    }

    const commonMetrics = buildCommonPolarViewFeature(
      origin,
      polarViewFeature,
      samples,
      centerCoordinate,
      featureDetails
    );

    if (!commonMetrics) {
      return [];
    }

    if (polarViewFeature.category !== "line") {
      return [commonMetrics];
    }

    if (samples.length < 2) {
      return [];
    }

    const representativeCoordinates = selectRepresentativeLineCoordinates(samples, 4);
    const linePoints = representativeCoordinates.map((coordinate) => toPolarCoordinateSample(origin, coordinate));
    const orientationDegrees = computeLineOrientationDegrees(representativeCoordinates);
    if (linePoints.length < 4 || orientationDegrees === null) {
      return [];
    }

    const startPoint = linePoints[0]!;
    const endPoint = linePoints[linePoints.length - 1]!;
    const linePath = samples.map((coordinate) => toPolarCoordinateSample(origin, coordinate));

    return [
      {
        ...commonMetrics,
        widestSpan: computeLineEndpointSpan(startPoint, endPoint),
        linePoints,
        linePath,
        orientationDegrees,
      },
    ];
  });
}

/**
 * 精炼 Samples Coordinates 为真正所需要的数据：
 * 最远点、最近点、视角宽度等等
 * @param origin
 * @param polarViewFeature
 * @returns
 */
function buildCommonPolarViewFeature(
  origin: [number, number],
  polarViewFeature: SampledPolarViewFeature,
  coordinates: [number, number][],
  centerCoordinate: [number, number],
  featureDetails: ReadonlyMap<string, SceneFeatureDetail>,
): PolarViewFeature | null {
  if (coordinates.length === 0) {
    return null;
  }

  const samples = coordinates.map((coordinate) => toPolarCoordinateSample(origin, coordinate));
  const nearestPoint = selectNearestSample(samples);
  const farthestPoint = selectFarthestSample(samples);

  if (!nearestPoint || !farthestPoint) {
    return null;
  }

  const id = polarViewFeature.featureId
  const detail = featureDetails.get(id)
  if (!detail) {
    return null
  }

  return {
    featureId: id,
    osmId: polarViewFeature.osmId,
    category: polarViewFeature.category,
    geometryType: polarViewFeature.geometryType,
    osmType: polarViewFeature.osmType,
    featureDetail: detail,
    centerPoint: toPolarCoordinateSample(origin, centerCoordinate),
    widestSpan: computeWidestSpan(polarViewFeature.geometryType, samples),
    nearestPoint,
    farthestPoint,
  };
}

//#region 帮助函数

function toPolarCoordinateSample(
  origin: [number, number],
  coordinate: [number, number],
): PolarCoordinateSample {
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

function computeWidestSpan(geometryType: string, samples: PolarCoordinateSample[]): PolarAngularSpan {
  if (geometryType.toLowerCase().includes("point") || samples.length === 1) {
    const point = samples[0]!;
    return {
      clockwiseEarlyPoint: point,
      clockwiseLatePoint: point,
      angleWidthDegrees: 0,
    };
  }

  const sortedSamples = [...samples].sort((left, right) => left.bearingDegrees - right.bearingDegrees);
  let largestGap = -1;
  let gapStartIndex = 0;

  // 在 bearing 序列里找最大空隙，
  // 其余部分围成的就是最小包络视野角。
  for (let index = 0; index < sortedSamples.length; index += 1) {
    const current = sortedSamples[index]!;
    const next = sortedSamples[(index + 1) % sortedSamples.length]!;
    const gap = circularAngleDeltaDegrees(current.bearingDegrees, next.bearingDegrees);

    if (gap > largestGap) {
      largestGap = gap;
      gapStartIndex = index;
    }
  }

  return {
    clockwiseEarlyPoint: sortedSamples[(gapStartIndex + 1) % sortedSamples.length]!,
    clockwiseLatePoint: sortedSamples[gapStartIndex]!,
    angleWidthDegrees: 360 - largestGap,
  };
}

function computeLineEndpointSpan(
  startPoint: PolarCoordinateSample,
  endPoint: PolarCoordinateSample,
): PolarAngularSpan {
  const deltaForward = circularAngleDeltaDegrees(startPoint.bearingDegrees, endPoint.bearingDegrees);
  if (deltaForward <= 180) {
    return {
      clockwiseEarlyPoint: startPoint,
      clockwiseLatePoint: endPoint,
      angleWidthDegrees: deltaForward,
    };
  }

  return {
    clockwiseEarlyPoint: endPoint,
    clockwiseLatePoint: startPoint,
    angleWidthDegrees: 360 - deltaForward,
  };
}

function dedupeConsecutiveCoordinates(
  coordinates: [number, number][] | undefined,
): [number, number][] {
  const dedupedCoordinates: [number, number][] = [];

  for (const coordinate of coordinates || []) {
    const previousCoordinate = dedupedCoordinates[dedupedCoordinates.length - 1];
    if (previousCoordinate && previousCoordinate[0] === coordinate[0] && previousCoordinate[1] === coordinate[1]) {
      continue;
    }
    dedupedCoordinates.push(coordinate);
  }

  return dedupedCoordinates;
}

function selectRepresentativeLineCoordinates(
  coordinates: [number, number][],
  targetCount: number,
): [number, number][] {
  if (coordinates.length === 0) {
    return [];
  }

  if (coordinates.length === 1) {
    return Array.from({ length: targetCount }, () => coordinates[0]!);
  }

  const cumulativeDistances = buildCumulativeDistances(coordinates);
  const totalLengthMeters = cumulativeDistances[cumulativeDistances.length - 1] || 0;
  const selectedIndices: number[] = [];

  // 这里优先贴近原始顶点，
  // 这样 linePoints 更像“原始线形的代表点”而不是新造出来的插值点。
  for (let slot = 0; slot < targetCount; slot += 1) {
    const fraction = targetCount === 1 ? 0 : slot / (targetCount - 1);
    const targetDistance = totalLengthMeters * fraction;
    let bestIndex = 0;
    let bestDistanceGap = Number.POSITIVE_INFINITY;

    for (let index = 0; index < cumulativeDistances.length; index += 1) {
      if (slot > 0 && index <= selectedIndices[slot - 1]!) {
        continue;
      }
      if (slot < targetCount - 1 && cumulativeDistances.length - index < targetCount - slot) {
        continue;
      }

      const gap = Math.abs(cumulativeDistances[index]! - targetDistance);
      if (gap < bestDistanceGap) {
        bestDistanceGap = gap;
        bestIndex = index;
      }
    }

    selectedIndices.push(bestIndex);
  }

  const selectedCoordinates = selectedIndices.map((index) => coordinates[index]!);
  const uniqueCoordinateCount = new Set(selectedCoordinates.map((coordinate) => coordinate.join(","))).size;
  if (uniqueCoordinateCount === selectedCoordinates.length) {
    return selectedCoordinates;
  }

  return buildInterpolatedPathSamples(coordinates, targetCount);
}

function buildCumulativeDistances(coordinates: [number, number][]): number[] {
  const cumulativeDistances: number[] = [0];

  for (let index = 1; index < coordinates.length; index += 1) {
    cumulativeDistances.push(
      cumulativeDistances[index - 1]! + distanceBetweenCoordinates(coordinates[index - 1]!, coordinates[index]!),
    );
  }

  return cumulativeDistances;
}

function buildInterpolatedPathSamples(
  coordinates: [number, number][],
  targetCount: number,
): [number, number][] {
  if (coordinates.length === 0) {
    return [];
  }

  if (coordinates.length === 1) {
    return Array.from({ length: targetCount }, () => coordinates[0]!);
  }

  const cumulativeDistances = buildCumulativeDistances(coordinates);
  const totalLengthMeters = cumulativeDistances[cumulativeDistances.length - 1] || 0;

  if (totalLengthMeters <= 0) {
    return Array.from({ length: targetCount }, (_, index) => coordinates[Math.min(index, coordinates.length - 1)]!);
  }

  return Array.from({ length: targetCount }, (_, slot) => {
    const fraction = targetCount === 1 ? 0 : slot / (targetCount - 1);
    const targetDistance = totalLengthMeters * fraction;
    return interpolateCoordinateAlongPath(coordinates, cumulativeDistances, targetDistance);
  });
}

function interpolateCoordinateAlongPath(
  coordinates: [number, number][],
  cumulativeDistances: number[],
  targetDistance: number,
): [number, number] {
  for (let index = 1; index < cumulativeDistances.length; index += 1) {
    const segmentStartDistance = cumulativeDistances[index - 1]!;
    const segmentEndDistance = cumulativeDistances[index]!;

    if (targetDistance > segmentEndDistance) {
      continue;
    }

    const startCoordinate = coordinates[index - 1]!;
    const endCoordinate = coordinates[index]!;
    const segmentLength = segmentEndDistance - segmentStartDistance;
    if (segmentLength <= 0) {
      return endCoordinate;
    }

    const ratio = (targetDistance - segmentStartDistance) / segmentLength;
    return [
      startCoordinate[0] + (endCoordinate[0] - startCoordinate[0]) * ratio,
      startCoordinate[1] + (endCoordinate[1] - startCoordinate[1]) * ratio,
    ];
  }

  return coordinates[coordinates.length - 1]!;
}

function computeLineOrientationDegrees(coordinates: [number, number][]): number | null {
  if (coordinates.length < 2) {
    return null;
  }

  const projectedCoordinates = coordinates.map(projectCoordinateToMeters);
  const meanX = projectedCoordinates.reduce((sum, point) => sum + point.x, 0) / projectedCoordinates.length;
  const meanY = projectedCoordinates.reduce((sum, point) => sum + point.y, 0) / projectedCoordinates.length;

  let sxx = 0;
  let syy = 0;
  let sxy = 0;

  for (const point of projectedCoordinates) {
    const dx = point.x - meanX;
    const dy = point.y - meanY;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }

  if (sxx === 0 && syy === 0) {
    return null;
  }

  const angleRadians = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  const dx = Math.cos(angleRadians);
  const dy = Math.sin(angleRadians);
  return normalizeBearingDegrees((Math.atan2(dx, dy) * 180) / Math.PI);
}

function projectCoordinateToMeters(coordinate: [number, number]): { x: number; y: number } {
  const [lon, lat] = coordinate;
  const latRadians = (lat * Math.PI) / 180;
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon = 111_320 * Math.cos(latRadians);

  return {
    x: lon * metersPerDegreeLon,
    y: lat * metersPerDegreeLat,
  };
}
