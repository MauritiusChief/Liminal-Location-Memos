import { debugSyncOverpassRespond, RangedPosition } from "@/routes/apiTypes.js";
import { query } from "@/db/client.js";
import { overpassJson } from "overpass-ts";
import { convertOverpassToNormalizedFeatures } from "./osmNormalizer.js";
import { syncNormalizedFeaturesToDb } from "./osmNormalizedToDb.js";

const COVERAGE_REUSE_DISTANCE_METERS = 500;
const COVERAGE_SYNC_RADIUS_METERS = 1000;
const OVERPASS_MAX_ATTEMPTS = 3;
const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

interface CoverageNearestRow {
  distance_meters: number | string | null;
}

export class OsmCoverageSyncRetryExhaustedError extends Error {
  constructor(message: string = '地图数据同步失败，请再次发送上一条消息重试。') {
    super(message);
    this.name = 'OsmCoverageSyncRetryExhaustedError';
  }
}

/**
 * 从 open street map 查询数据
 * @param request Overpass Query
 * @param includeRaw debug 是否返回原始的 OverpassJson
 * @returns debug 用的参数
 */
export async function syncOverpassCoverage(
  request: RangedPosition,
  _includeRaw: boolean = false
): Promise<debugSyncOverpassRespond> {
  const query = buildJsonSkelOverpassQuery(request);
  const raw = await fetchOverpassJsonWithRetry(query);
  const features = convertOverpassToNormalizedFeatures(raw);
  // features: 归整化的地物，去向有两处
  // 1. 落入数据库
  // 2. 作为 debug 帮助信息返回
  await syncNormalizedFeaturesToDb(features, request);

  return {query, features, counts: features.length}
}

/**
 * 如果检测到最近的同步点中心远于 500 米，则强制一次 1000 米半径的查询
 * @param request
 * @returns
 */
export async function ensureOsmCoverageForRequest(request: RangedPosition): Promise<void> {
  const nearestDistanceMeters = await findNearestCoverageDistanceMeters(request);
  if (nearestDistanceMeters !== null && nearestDistanceMeters <= COVERAGE_REUSE_DISTANCE_METERS) {
    return;
  }

  console.log(`[${new Date().toISOString()}] 从 OSM 获取数据中...`);
  await syncOverpassCoverage({
    lat: request.lat,
    lon: request.lon,
    radius: COVERAGE_SYNC_RADIUS_METERS,
  });
  console.log(`[${new Date().toISOString()}] OSM 获取数据完成`);
}

// #region 帮助函数

async function findNearestCoverageDistanceMeters(request: RangedPosition): Promise<number | null> {
  const result = await query<CoverageNearestRow>(
    `
    SELECT ST_DistanceSphere(
      center,
      ST_SetSRID(ST_MakePoint($1, $2), 4326)
    ) AS distance_meters
    FROM osm_sync_coverage
    ORDER BY center <-> ST_SetSRID(ST_MakePoint($1, $2), 4326)
    LIMIT 1
    `,
    [request.lon, request.lat],
  );

  const rawDistance = result.rows[0]?.distance_meters;
  if (rawDistance === null || typeof rawDistance === 'undefined') {
    return null;
  }

  const distanceMeters = Number(rawDistance);
  return Number.isFinite(distanceMeters) ? distanceMeters : null;
}

async function fetchOverpassJsonWithRetry(query: string) {
  let lastError: unknown;

  for (let attempt = 1; attempt <= OVERPASS_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await overpassJson(query, {
        endpoint: OVERPASS_ENDPOINT,
      });
    } catch (error) {
      lastError = error;
      if (attempt === OVERPASS_MAX_ATTEMPTS) {
        throw new OsmCoverageSyncRetryExhaustedError();
      }
    }
  }

  throw lastError instanceof Error ? lastError : new OsmCoverageSyncRetryExhaustedError();
}

/**
 * 生成专门用于规整化函数的 Overpass Query，无任何过滤。
 * @param para Overpass Query 所需的参数
 * @returns 生成的 Overpass Query
 */
function buildJsonSkelOverpassQuery(
  para: RangedPosition,
): string {
  return [
    '[out:json][timeout:25];',
    `nwr(around:${para.radius},${para.lat},${para.lon});`,
    'out body geom;',
    '>;', // Overpass QL 语法，取出上一个结果集中所有
    'out body geom;',
  ].join('\n');
}
