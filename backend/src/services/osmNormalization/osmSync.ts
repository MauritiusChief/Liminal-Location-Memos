import { debugSyncOverpassRespond } from "@/routes/apiTypes.js";
import { overpassJson } from "overpass-ts";
import { convertOverpassToNormalizedFeatures, NormalizedFeature } from "./osmNormalizer.js";

/**
 * `/debug/db/sync-overpass` API 负责 debug 这个部分
 */

/**
 *
 * @param lat Overpass Query 中心经度
 * @param lon Overpass Query 中心维度
 * @param radius Overpass Query 半径
 * @param includeRaw 是否返回原结果
 * @returns debug 用的参数
 */
export async function syncOverpassCoverage(
  lat: number,
  lon: number,
  radius: number,
  includeRaw: boolean = false
): Promise<debugSyncOverpassRespond> {
  const query = buildJsonSkelOverpassQuery(lat, lon, radius);
  const raw = (await overpassJson(query, {
    endpoint: 'https://overpass-api.de/api/interpreter',
  }));
  const features = convertOverpassToNormalizedFeatures(raw);
  return {}
}

// #region 帮助函数

/**
 * 生成专门用于规整化函数的 Overpass Query，无任何过滤且启用 skel 参数。
 * @param lat Overpass Query 中心经度
 * @param lon Overpass Query 中心维度
 * @param radius Overpass Query 半径
 * @returns 生成的 Overpass Query
 */
function buildJsonSkelOverpassQuery(
  lat: number,
  lon: number,
  radius: number
): string {
  return [
    '[out:json][timeout:25];',
    `nwr(around:${radius},${lat},${lon});`,
    'out body geom;',
    '>;',
    'out skel geom;',
  ].join('\n');
}