import { debugSyncOverpassRespond } from "@/routes/apiTypes.js";
import { overpassJson } from "overpass-ts";
import { convertOverpassToNormalizedFeatures } from "./osmNormalizer.js";
import { syncNormalizedFeaturesToDb } from "./osmNormalizedToDb.js";

/**
 * `/debug/db/sync-overpass` API 负责 debug 这个部分
 */

/**
 *
 * @param lat Overpass Query 中心经度
 * @param lon Overpass Query 中心维度
 * @param radius Overpass Query 半径
 * @param includeRaw debug 是否返回原始的 OverpassJson
 * @returns debug 用的参数
 */
export async function syncOverpassCoverage(
  request: {
    lat: number,
    lon: number,
    radius: number,
  },
  includeRaw: boolean = false
): Promise<debugSyncOverpassRespond> {
  const query = buildJsonSkelOverpassQuery(request);
  const raw = (await overpassJson(query, {
    endpoint: 'https://overpass-api.de/api/interpreter',
  }));
  const features = convertOverpassToNormalizedFeatures(raw);
  // features: 归整化的地物，去向有两处
  // 1. 落入数据库
  // 2. 作为 debug 帮助信息返回
  await syncNormalizedFeaturesToDb(features, request);

  return {query, features, counts: 666}
}

// #region 帮助函数

/**
 * 生成专门用于规整化函数的 Overpass Query，无任何过滤。
 * @param lat Overpass Query 中心经度
 * @param lon Overpass Query 中心维度
 * @param radius Overpass Query 半径
 * @returns 生成的 Overpass Query
 */
function buildJsonSkelOverpassQuery(
  para: {
    lat: number,
    lon: number,
    radius: number,
  },
): string {
  return [
    '[out:json][timeout:25];',
    `nwr(around:${para.radius},${para.lat},${para.lon});`,
    'out body geom;',
    '>;', // Overpass QL 语法，取出上一个结果集中所有
    'out body geom;',
  ].join('\n');
}